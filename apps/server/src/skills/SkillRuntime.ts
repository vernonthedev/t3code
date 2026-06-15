import {
  type SkillAuditReport,
  type SkillCreateInput,
  type SkillDefinition,
  type SkillExecuteInput,
  SkillExecutionError,
  type SkillExecutionRecord,
  type SkillExecutionResult,
  SkillId,
  type SkillInstallInput,
  type SkillInstallResult,
  SkillPermission,
  SkillProviderError,
  type ServerSettingsError,
  type SkillRegistrySnapshot,
  type SkillSearchInput,
  type SkillSearchResult,
  type SkillSetEnabledInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsProcess, type VcsProcessShape } from "../vcs/VcsProcess.ts";

const SKILLS_SH_BASE_URL = "https://www.skills.sh";
const MAX_EXECUTION_RECORDS = 100;
const decodeUnknownJson = Schema.decodeEffect(Schema.UnknownFromJsonString);
const isSkillProviderError = Schema.is(SkillProviderError);

interface BuiltinSkill {
  readonly definition: Omit<SkillDefinition, "enabled" | "installPath">;
  readonly run: (input: SkillExecuteInput) => Effect.Effect<unknown, SkillExecutionError>;
}

export interface SkillRuntimeShape {
  readonly list: Effect.Effect<SkillRegistrySnapshot, SkillProviderError | ServerSettingsError>;
  readonly search: (
    input: SkillSearchInput,
  ) => Effect.Effect<SkillSearchResult, SkillProviderError>;
  readonly audit: (input: SkillInstallInput) => Effect.Effect<SkillAuditReport, SkillProviderError>;
  readonly install: (
    input: SkillInstallInput,
  ) => Effect.Effect<SkillInstallResult, SkillProviderError | ServerSettingsError>;
  readonly create: (
    input: SkillCreateInput,
  ) => Effect.Effect<SkillDefinition, SkillProviderError | ServerSettingsError>;
  readonly setEnabled: (
    input: SkillSetEnabledInput,
  ) => Effect.Effect<SkillDefinition, SkillProviderError | ServerSettingsError>;
  readonly execute: (
    input: SkillExecuteInput,
  ) => Effect.Effect<
    SkillExecutionResult,
    SkillExecutionError | SkillProviderError | ServerSettingsError
  >;
  readonly listExecutions: Effect.Effect<readonly SkillExecutionRecord[]>;
}

export class SkillRuntime extends Context.Service<SkillRuntime, SkillRuntimeShape>()(
  "t3/skills/SkillRuntime",
) {}

const decodeSkillId = Schema.decodeUnknownSync(SkillId);
const decodePermission = Schema.decodeUnknownSync(SkillPermission);

function toSkillId(value: string): SkillId {
  return decodeSkillId(value.trim());
}

function toPermission(value: string): SkillPermission {
  return decodePermission(value.trim());
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function providerError(message: string, cause?: unknown): SkillProviderError {
  return new SkillProviderError({ message, provider: "local", cause });
}

function skillsShError(message: string, cause?: unknown): SkillProviderError {
  return new SkillProviderError({ message, provider: "skills.sh", cause });
}

function defaultInstallPath(path: Path.Path, config: ServerConfigShape): string {
  return path.join(config.baseDir, "skills");
}

function resolveInstallPath(
  path: Path.Path,
  config: ServerConfigShape,
  configuredInstallPath: string,
): string {
  return path.resolve(configuredInstallPath.trim() || defaultInstallPath(path, config));
}

function resolveWorkspacePath(path: Path.Path, cwd: string, requestedPath: string): string {
  const base = path.resolve(cwd);
  const resolved = path.resolve(base, requestedPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Skill file access must stay inside the workspace root.");
  }
  return resolved;
}

function metadataFromUnknown(raw: unknown, fallbackId: string): SkillDefinition {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const id = String(record.id ?? record.slug ?? fallbackId);
  const name = String(record.name ?? id);
  const description = String(record.description ?? "");
  const version = String(record.version ?? "0.1.0");
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.map((permission) => toPermission(String(permission))).filter(Boolean)
    : [];
  return {
    id: toSkillId(id),
    name,
    description,
    version,
    provider: "skills.sh",
    permissions,
    enabled: false,
    sourceUrl: `${SKILLS_SH_BASE_URL}/skills/${encodeURIComponent(id)}`,
  };
}

function parseSkillMd(content: string, id: string, installPath: string): SkillDefinition {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const readField = (field: string): string | undefined => {
    const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  };
  const permissionsText = readField("permissions") ?? "";
  const permissions = permissionsText
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((permission) => permission.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map(toPermission);

  return {
    id: toSkillId(readField("id") ?? id),
    name: readField("name") ?? id,
    description: readField("description") ?? "",
    version: readField("version") ?? "0.1.0",
    provider: "local",
    permissions,
    enabled: true,
    installPath,
  };
}

function skillMdContent(input: SkillCreateInput): string {
  const permissions = input.permissions.map((permission) => `"${permission}"`).join(", ");
  return [
    "---",
    `id: ${input.id}`,
    `name: ${input.name}`,
    `description: ${input.description}`,
    `version: ${input.version}`,
    `permissions: [${permissions}]`,
    "---",
    "",
    "# Instructions",
    "",
    "Describe what this skill does and when agents should use it.",
    "",
  ].join("\n");
}

function makeAuditReport(input: {
  readonly skillId: SkillId;
  readonly provider: SkillAuditReport["provider"];
  readonly status: SkillAuditReport["status"];
  readonly summary: string;
  readonly checkedAt: string;
  readonly sourceUrl?: string;
}): SkillAuditReport {
  return {
    skillId: input.skillId,
    provider: input.provider,
    status: input.status,
    summary: input.summary,
    checkedAt: input.checkedAt,
    issues: [],
    sourceUrl: input.sourceUrl,
  };
}

function makeBuiltins(input: {
  readonly config: ServerConfigShape;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly vcsProcess: VcsProcessShape;
}): ReadonlyMap<string, BuiltinSkill> {
  const { config, fileSystem, path, vcsProcess } = input;
  const workspaceCwd = (input: SkillExecuteInput) => input.cwd ?? config.cwd;
  const builtins: BuiltinSkill[] = [
    {
      definition: {
        id: toSkillId("file_reader"),
        name: "File reader",
        description: "Read a text file from the workspace.",
        version: "1.0.0",
        provider: "builtin",
        permissions: [toPermission("workspace:read")],
      },
      run: (input) =>
        Effect.tryPromise({
          try: async () => {
            const payload = input.input as { path?: unknown };
            const requestedPath = String(payload?.path ?? "");
            if (!requestedPath) throw new Error("file_reader requires input.path.");
            const filePath = resolveWorkspacePath(path, workspaceCwd(input), requestedPath);
            return {
              path: filePath,
              contents: await Effect.runPromise(fileSystem.readFileString(filePath)),
            };
          },
          catch: (cause) =>
            new SkillExecutionError({
              skillId: toSkillId("file_reader"),
              message: cause instanceof Error ? cause.message : "Failed to read file.",
              cause,
            }),
        }),
    },
    {
      definition: {
        id: toSkillId("file_writer"),
        name: "File writer",
        description: "Write a text file inside the workspace.",
        version: "1.0.0",
        provider: "builtin",
        permissions: [toPermission("workspace:write")],
      },
      run: (input) =>
        Effect.tryPromise({
          try: async () => {
            const payload = input.input as { path?: unknown; contents?: unknown };
            const requestedPath = String(payload?.path ?? "");
            if (!requestedPath) throw new Error("file_writer requires input.path.");
            const filePath = resolveWorkspacePath(path, workspaceCwd(input), requestedPath);
            const contents = String(payload?.contents ?? "");
            await Effect.runPromise(
              fileSystem
                .makeDirectory(path.dirname(filePath), { recursive: true })
                .pipe(Effect.andThen(fileSystem.writeFileString(filePath, contents))),
            );
            return { path: filePath, bytes: contents.length };
          },
          catch: (cause) =>
            new SkillExecutionError({
              skillId: toSkillId("file_writer"),
              message: cause instanceof Error ? cause.message : "Failed to write file.",
              cause,
            }),
        }),
    },
    {
      definition: {
        id: toSkillId("git_commit_message_generator"),
        name: "Git commit message generator",
        description: "Generate a concise commit message from a git diff.",
        version: "1.0.0",
        provider: "builtin",
        permissions: [toPermission("git:read")],
      },
      run: (input) =>
        Effect.tryPromise({
          try: async () => {
            const payload = input.input as { diff?: unknown };
            const diff =
              typeof payload?.diff === "string" && payload.diff.trim()
                ? payload.diff
                : await Effect.runPromise(
                    vcsProcess
                      .run({
                        operation: "skills.git_commit_message_generator.staged_diff",
                        command: "git",
                        args: ["diff", "--staged"],
                        cwd: workspaceCwd(input),
                        maxOutputBytes: 4 * 1024 * 1024,
                      })
                      .pipe(
                        Effect.flatMap((staged) =>
                          staged.stdout
                            ? Effect.succeed(staged.stdout)
                            : vcsProcess
                                .run({
                                  operation: "skills.git_commit_message_generator.diff",
                                  command: "git",
                                  args: ["diff"],
                                  cwd: workspaceCwd(input),
                                  maxOutputBytes: 4 * 1024 * 1024,
                                })
                                .pipe(Effect.map((unstaged) => unstaged.stdout)),
                        ),
                      ),
                  );
            const changedFiles = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
              (match) => match[2],
            );
            const subject =
              changedFiles.length === 0
                ? "chore: update project files"
                : `chore: update ${changedFiles.slice(0, 3).join(", ")}${
                    changedFiles.length > 3 ? ` and ${changedFiles.length - 3} more` : ""
                  }`;
            return { subject, body: [`Files changed: ${changedFiles.length}`] };
          },
          catch: (cause) =>
            new SkillExecutionError({
              skillId: toSkillId("git_commit_message_generator"),
              message: cause instanceof Error ? cause.message : "Failed to inspect git diff.",
              cause,
            }),
        }),
    },
  ];
  return new Map(builtins.map((skill) => [skill.definition.id, skill]));
}

function fetchJson(
  httpClient: HttpClient.HttpClient,
  url: string,
): Effect.Effect<unknown, SkillProviderError> {
  return HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap((text) =>
      decodeUnknownJson(text).pipe(
        Effect.mapError((cause) => skillsShError("skills.sh returned invalid JSON.", cause)),
      ),
    ),
    Effect.mapError((cause) =>
      isSkillProviderError(cause)
        ? cause
        : skillsShError(
            cause instanceof Error ? cause.message : "Failed to call skills.sh.",
            cause,
          ),
    ),
  );
}

export const SkillRuntimeLive = Layer.effect(
  SkillRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const vcsProcess = yield* VcsProcess;
    const executionsRef = yield* Ref.make<readonly SkillExecutionRecord[]>([]);
    const builtins = makeBuiltins({ config, fileSystem, path, vcsProcess });

    const listLocalSkills = (
      installPath: string,
    ): Effect.Effect<SkillDefinition[], SkillProviderError> =>
      Effect.gen(function* () {
        yield* fileSystem
          .makeDirectory(installPath, { recursive: true })
          .pipe(
            Effect.mapError((cause) => providerError("Failed to create skills directory.", cause)),
          );
        const entries = yield* fileSystem
          .readDirectory(installPath)
          .pipe(
            Effect.mapError((cause) => providerError("Failed to discover local skills.", cause)),
          );
        const skills: SkillDefinition[] = [];
        for (const entry of entries) {
          const skillPath = path.join(installPath, entry);
          const skillFile = path.join(skillPath, "SKILL.md");
          const content = yield* fileSystem.readFileString(skillFile).pipe(
            Effect.map((text) => text as string | null),
            Effect.orElseSucceed(() => null),
          );
          if (content) {
            skills.push(parseSkillMd(content, entry, skillPath));
          }
        }
        return skills;
      });

    const list = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const configuredInstallPath = settings.skills.installPath;
      const installPath = resolveInstallPath(path, config, configuredInstallPath);
      const localSkills = yield* listLocalSkills(installPath);
      const skillsById = new Map<string, SkillDefinition>();

      for (const builtin of builtins.values()) {
        const persisted = settings.skills.installed[builtin.definition.id];
        skillsById.set(builtin.definition.id, {
          ...builtin.definition,
          enabled: persisted?.enabled ?? true,
          installPath: undefined,
        });
      }

      for (const localSkill of localSkills) {
        const persisted = settings.skills.installed[localSkill.id];
        skillsById.set(localSkill.id, {
          ...localSkill,
          enabled: persisted?.enabled ?? localSkill.enabled,
          permissions: persisted?.permissions ?? localSkill.permissions,
        });
      }

      for (const [id, persisted] of Object.entries(settings.skills.installed)) {
        if (skillsById.has(id)) continue;
        skillsById.set(id, {
          id: toSkillId(id),
          name: id,
          description: "",
          version: persisted.version,
          provider: persisted.provider,
          permissions: persisted.permissions,
          enabled: persisted.enabled,
          installPath: persisted.installPath || undefined,
          sourceUrl: persisted.sourceUrl || undefined,
        });
      }

      return {
        defaultInstallPath: defaultInstallPath(path, config),
        configuredInstallPath,
        skills: [...skillsById.values()].sort((left, right) => left.name.localeCompare(right.name)),
      } satisfies SkillRegistrySnapshot;
    });

    const findSkill = (
      id: SkillId,
    ): Effect.Effect<SkillDefinition, SkillProviderError | ServerSettingsError> =>
      list.pipe(
        Effect.flatMap((snapshot) => {
          const skill = snapshot.skills.find((candidate) => candidate.id === id);
          return skill
            ? Effect.succeed(skill)
            : Effect.fail(providerError(`Skill '${id}' is not installed.`));
        }),
      );

    const writeInstallState = (skill: SkillDefinition) =>
      settingsService.updateSettings({
        skills: {
          installed: {
            [skill.id]: {
              enabled: skill.enabled,
              provider: skill.provider,
              version: skill.version,
              permissions: skill.permissions,
              installPath: skill.installPath ?? "",
              sourceUrl: skill.sourceUrl ?? "",
            },
          },
          grantedPermissions: {
            [skill.id]: skill.permissions,
          },
        },
      });

    const search = (input: SkillSearchInput) =>
      fetchJson(
        httpClient,
        `${SKILLS_SH_BASE_URL}/api/v1/skills/search?q=${encodeURIComponent(input.query)}`,
      ).pipe(
        Effect.map((raw) => {
          const listRaw =
            raw && typeof raw === "object" && Array.isArray((raw as { skills?: unknown }).skills)
              ? (raw as { skills: unknown[] }).skills
              : Array.isArray(raw)
                ? raw
                : [];
          return {
            skills: listRaw.map((item, index) =>
              metadataFromUnknown(item, input.query || `skill-${index + 1}`),
            ),
          } satisfies SkillSearchResult;
        }),
      );

    const audit = (input: SkillInstallInput) =>
      Effect.gen(function* () {
        const checkedAt = yield* nowIso;
        if (input.provider !== "skills.sh") {
          return makeAuditReport({
            skillId: input.id,
            provider: input.provider,
            status: input.provider === "builtin" ? "trusted" : "unknown",
            summary:
              input.provider === "builtin"
                ? "Built-in T3 Code skill."
                : "Local skills are trusted by their install location.",
            checkedAt,
          });
        }

        return yield* fetchJson(
          httpClient,
          `${SKILLS_SH_BASE_URL}/api/v1/skills/audit/${encodeURIComponent(input.id)}`,
        ).pipe(
          Effect.map((raw) => {
            const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
            return makeAuditReport({
              skillId: input.id,
              provider: "skills.sh",
              status:
                record.status === "trusted" || record.status === "warning"
                  ? record.status
                  : "unknown",
              summary: String(record.summary ?? "No audit summary was returned by skills.sh."),
              checkedAt,
              sourceUrl: `${SKILLS_SH_BASE_URL}/skills/${encodeURIComponent(input.id)}`,
            });
          }),
          Effect.catch(() =>
            Effect.succeed(
              makeAuditReport({
                skillId: input.id,
                provider: "skills.sh",
                status: "unknown",
                summary: "Audit information is unavailable for this skill.",
                checkedAt,
                sourceUrl: `${SKILLS_SH_BASE_URL}/skills/${encodeURIComponent(input.id)}`,
              }),
            ),
          ),
        );
      });

    const install = (input: SkillInstallInput) =>
      Effect.gen(function* () {
        if (input.provider !== "skills.sh") {
          return yield* Effect.fail(skillsShError("Only skills.sh installation is supported."));
        }
        const settings = yield* settingsService.getSettings;
        const installPath = resolveInstallPath(path, config, settings.skills.installPath);
        const raw = yield* fetchJson(
          httpClient,
          `${SKILLS_SH_BASE_URL}/api/v1/skills/${encodeURIComponent(input.id)}`,
        );
        const skill = metadataFromUnknown(raw, input.id);
        const skillPath = path.join(installPath, skill.id);
        const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const content =
          typeof record.content === "string"
            ? record.content
            : skillMdContent({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                version: skill.version,
                permissions: skill.permissions,
              });
        yield* fileSystem.makeDirectory(skillPath, { recursive: true }).pipe(
          Effect.andThen(fileSystem.writeFileString(path.join(skillPath, "SKILL.md"), content)),
          Effect.mapError((cause) => providerError("Failed to install skill files.", cause)),
        );
        const installedSkill: SkillDefinition = {
          ...skill,
          enabled: true,
          installPath: skillPath,
        };
        yield* writeInstallState(installedSkill);
        return {
          skill: installedSkill,
          audit: yield* audit(input),
        } satisfies SkillInstallResult;
      });

    const create = (input: SkillCreateInput) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const installPath = resolveInstallPath(path, config, settings.skills.installPath);
        const skillPath = path.join(installPath, input.id);
        yield* fileSystem.makeDirectory(skillPath, { recursive: true }).pipe(
          Effect.andThen(
            fileSystem.writeFileString(path.join(skillPath, "SKILL.md"), skillMdContent(input)),
          ),
          Effect.mapError((cause) => providerError("Failed to create local skill.", cause)),
        );
        const skill: SkillDefinition = {
          id: input.id,
          name: input.name,
          description: input.description,
          version: input.version,
          provider: "local",
          permissions: input.permissions,
          enabled: true,
          installPath: skillPath,
        };
        yield* writeInstallState(skill);
        return skill;
      });

    const setEnabled = (input: SkillSetEnabledInput) =>
      Effect.gen(function* () {
        const skill = yield* findSkill(input.id);
        const next = { ...skill, enabled: input.enabled };
        yield* writeInstallState(next);
        return next;
      });

    const appendExecution = (record: SkillExecutionRecord) =>
      Ref.update(executionsRef, (records) => [record, ...records].slice(0, MAX_EXECUTION_RECORDS));

    const execute = (input: SkillExecuteInput) =>
      Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const startedMs = yield* Clock.currentTimeMillis;
        const skill = yield* findSkill(input.id);
        const finish = (status: SkillExecutionRecord["status"], message: string, output: unknown) =>
          Effect.gen(function* () {
            const record: SkillExecutionRecord = {
              id: `${input.id}:${startedMs}`,
              skillId: skill.id,
              skillName: skill.name,
              startedAt,
              durationMs: (yield* Clock.currentTimeMillis) - startedMs,
              status,
              permissions: skill.permissions,
              message,
            };
            yield* appendExecution(record);
            return { output, execution: record } satisfies SkillExecutionResult;
          });

        if (!skill.enabled) {
          return yield* finish("blocked", "Skill is disabled.", null).pipe(
            Effect.flatMap((result) =>
              Effect.fail(
                new SkillExecutionError({
                  skillId: input.id,
                  message: result.execution.message,
                }),
              ),
            ),
          );
        }

        const settings = yield* settingsService.getSettings;
        const grantedPermissions = settings.skills.grantedPermissions[input.id] ?? [];
        const missingPermissions = skill.permissions.filter(
          (permission) => !grantedPermissions.includes(permission) && skill.provider !== "builtin",
        );
        if (missingPermissions.length > 0) {
          return yield* finish(
            "blocked",
            `Missing permissions: ${missingPermissions.join(", ")}`,
            null,
          ).pipe(
            Effect.flatMap((result) =>
              Effect.fail(
                new SkillExecutionError({
                  skillId: input.id,
                  message: result.execution.message,
                }),
              ),
            ),
          );
        }

        const builtin = builtins.get(input.id);
        if (!builtin) {
          return yield* finish(
            "blocked",
            "Installed prompt skills are discoverable but cannot execute until sandboxing lands.",
            null,
          ).pipe(
            Effect.flatMap((result) =>
              Effect.fail(
                new SkillExecutionError({
                  skillId: input.id,
                  message: result.execution.message,
                }),
              ),
            ),
          );
        }

        const output = yield* builtin.run(input).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const endedMs = yield* Clock.currentTimeMillis;
              yield* appendExecution({
                id: `${input.id}:${startedMs}`,
                skillId: skill.id,
                skillName: skill.name,
                startedAt,
                durationMs: endedMs - startedMs,
                status: "failed",
                permissions: skill.permissions,
                message: error.message,
              });
            }),
          ),
        );
        return yield* finish("success", "Skill executed successfully.", output);
      });

    return {
      list,
      search,
      audit,
      install,
      create,
      setEnabled,
      execute,
      listExecutions: Ref.get(executionsRef),
    } satisfies SkillRuntimeShape;
  }),
);
