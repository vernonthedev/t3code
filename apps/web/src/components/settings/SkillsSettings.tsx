import type {
  SkillAuditReport,
  SkillDefinition,
  SkillExecutionRecord,
  SkillId,
  SkillPermission,
  SkillRegistrySnapshot,
  SkillSearchResult,
} from "@t3tools/contracts";
import {
  FileCode2Icon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function showError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Unexpected skills runtime error.",
    }),
  );
}

function PermissionList({ permissions }: { permissions: readonly string[] }) {
  if (permissions.length === 0) {
    return <span className="text-muted-foreground">No permissions</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((permission) => (
        <span
          key={permission}
          className="rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {permission}
        </span>
      ))}
    </div>
  );
}

function AuditBadge({ audit }: { audit: SkillAuditReport | undefined }) {
  if (!audit) return <span className="text-muted-foreground">Audit not loaded</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <ShieldCheckIcon className="size-3.5" />
      {audit.status}
    </span>
  );
}

function executionLabel(record: SkillExecutionRecord) {
  return `${record.skillName} · ${record.status} · ${record.durationMs}ms`;
}

export function SkillsSettingsPanel() {
  const skillsSettings = useSettings((settings) => settings.skills);
  const { updateSettings } = useUpdateSettings();
  const [snapshot, setSnapshot] = useState<SkillRegistrySnapshot | null>(null);
  const [executions, setExecutions] = useState<readonly SkillExecutionRecord[]>([]);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SkillSearchResult>({ skills: [] });
  const [audits, setAudits] = useState<Record<string, SkillAuditReport>>({});
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState({
    id: "",
    name: "",
    description: "",
    permissions: "",
  });

  const installedSkills = snapshot?.skills ?? [];
  const defaultInstallPath = snapshot?.defaultInstallPath ?? "";
  const configuredInstallPath = skillsSettings.installPath || snapshot?.configuredInstallPath || "";

  const reload = useCallback(async () => {
    const api = ensureLocalApi();
    const [nextSnapshot, nextExecutions] = await Promise.all([
      api.skills.list(),
      api.skills.listExecutions(),
    ]);
    setSnapshot(nextSnapshot);
    setExecutions(nextExecutions);
  }, []);

  useEffect(() => {
    void reload().catch((error) => showError("Could not load skills", error));
  }, [reload]);

  const handleSearch = useCallback(async () => {
    try {
      setSearchResult(await ensureLocalApi().skills.search({ query }));
    } catch (error) {
      showError("Skill search failed", error);
    }
  }, [query]);

  const handleAudit = useCallback(async (skill: SkillDefinition) => {
    try {
      setBusySkillId(skill.id);
      const audit = await ensureLocalApi().skills.audit({ id: skill.id, provider: skill.provider });
      setAudits((current) => ({ ...current, [skill.id]: audit }));
    } catch (error) {
      showError("Audit lookup failed", error);
    } finally {
      setBusySkillId(null);
    }
  }, []);

  const handleInstall = useCallback(
    async (skill: SkillDefinition) => {
      try {
        setBusySkillId(skill.id);
        const result = await ensureLocalApi().skills.install({
          id: skill.id,
          provider: skill.provider,
        });
        setAudits((current) => ({ ...current, [skill.id]: result.audit }));
        await reload();
      } catch (error) {
        showError("Skill install failed", error);
      } finally {
        setBusySkillId(null);
      }
    },
    [reload],
  );

  const handleToggle = useCallback(
    async (skill: SkillDefinition, enabled: boolean) => {
      try {
        setBusySkillId(skill.id);
        await ensureLocalApi().skills.setEnabled({ id: skill.id, enabled });
        await reload();
      } catch (error) {
        showError("Could not update skill", error);
      } finally {
        setBusySkillId(null);
      }
    },
    [reload],
  );

  const handleCreate = useCallback(async () => {
    try {
      const id = newSkill.id.trim();
      const name = newSkill.name.trim() || id;
      if (!id) return;
      setBusySkillId(id);
      await ensureLocalApi().skills.create({
        id: id as SkillId,
        name,
        description: newSkill.description.trim(),
        version: "0.1.0",
        permissions: newSkill.permissions
          .split(",")
          .map((permission) => permission.trim())
          .filter(Boolean) as SkillPermission[],
      });
      setNewSkill({ id: "", name: "", description: "", permissions: "" });
      await reload();
    } catch (error) {
      showError("Could not create skill", error);
    } finally {
      setBusySkillId(null);
    }
  }, [newSkill, reload]);

  const handleExecuteSmokeTest = useCallback(
    async (skill: SkillDefinition) => {
      try {
        setBusySkillId(skill.id);
        const input =
          skill.id === "git_commit_message_generator"
            ? { diff: "" }
            : skill.id === "file_reader"
              ? { path: "package.json" }
              : { path: ".t3-skill-smoke-test.txt", contents: "skills runtime smoke test\n" };
        await ensureLocalApi().skills.execute({ id: skill.id, input });
        await reload();
      } catch (error) {
        showError("Skill execution failed", error);
        await reload().catch(() => undefined);
      } finally {
        setBusySkillId(null);
      }
    },
    [reload],
  );

  const installedById = useMemo(
    () => new Set(installedSkills.map((skill) => skill.id)),
    [installedSkills],
  );

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection title="Storage" icon={<FileCode2Icon className="size-3.5" />}>
        <SettingsRow
          title="Skills path"
          description="Folder used for local and installed skill files."
          status={defaultInstallPath ? `Default: ${defaultInstallPath}` : undefined}
          control={
            <DraftInput
              value={configuredInstallPath}
              placeholder={defaultInstallPath}
              className="min-w-0 sm:w-96"
              onCommit={(installPath) =>
                updateSettings({ skills: { ...skillsSettings, installPath } })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Installed" icon={<ListChecksIcon className="size-3.5" />}>
        {installedSkills.map((skill) => (
          <SettingsRow
            key={skill.id}
            title={skill.name}
            description={`${skill.id} · ${skill.provider} · v${skill.version}`}
            status={<PermissionList permissions={skill.permissions} />}
            control={
              <>
                {skill.provider === "builtin" ? (
                  <Button
                    size="icon-xs"
                    variant="outline"
                    aria-label={`Run ${skill.name}`}
                    disabled={busySkillId === skill.id}
                    onClick={() => void handleExecuteSmokeTest(skill)}
                  >
                    <PlayIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Switch
                  checked={skill.enabled}
                  disabled={busySkillId === skill.id}
                  aria-label={`Enable ${skill.name}`}
                  onCheckedChange={(enabled) => void handleToggle(skill, enabled)}
                />
              </>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Available"
        icon={<SearchIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" onClick={() => void handleSearch()}>
            <SearchIcon className="size-3.5" />
            Search
          </Button>
        }
      >
        <SettingsRow
          title="Search skills.sh"
          description="Find remote skills before reviewing audit information and installing."
          control={
            <Input
              value={query}
              type="search"
              placeholder="Search skills"
              className="min-w-0 sm:w-80"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSearch();
              }}
            />
          }
        />
        {searchResult.skills.map((skill) => (
          <SettingsRow
            key={skill.id}
            title={skill.name}
            description={`${skill.id} · ${skill.description || "No description"}`}
            status={<AuditBadge audit={audits[skill.id]} />}
            control={
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busySkillId === skill.id}
                  onClick={() => void handleAudit(skill)}
                >
                  <ShieldCheckIcon className="size-3.5" />
                  Audit
                </Button>
                <Button
                  size="xs"
                  disabled={busySkillId === skill.id || installedById.has(skill.id)}
                  onClick={() => void handleInstall(skill)}
                >
                  <PlusIcon className="size-3.5" />
                  Install
                </Button>
              </>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Create" icon={<SparklesIcon className="size-3.5" />}>
        <div className="grid gap-3 border-t border-border/60 px-4 py-4 first:border-t-0 sm:grid-cols-2 sm:px-5">
          <Input
            value={newSkill.id}
            placeholder="skill_id"
            onChange={(event) => setNewSkill((current) => ({ ...current, id: event.target.value }))}
          />
          <Input
            value={newSkill.name}
            placeholder="Skill name"
            onChange={(event) =>
              setNewSkill((current) => ({ ...current, name: event.target.value }))
            }
          />
          <Input
            value={newSkill.description}
            placeholder="Description"
            onChange={(event) =>
              setNewSkill((current) => ({ ...current, description: event.target.value }))
            }
          />
          <div className="flex gap-2">
            <Input
              value={newSkill.permissions}
              placeholder="workspace:read, git:read"
              onChange={(event) =>
                setNewSkill((current) => ({ ...current, permissions: event.target.value }))
              }
            />
            <Button disabled={!newSkill.id.trim()} onClick={() => void handleCreate()}>
              <PlusIcon className="size-4" />
              Create
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Execution Log" icon={<PlayIcon className="size-3.5" />}>
        {executions.length === 0 ? (
          <SettingsRow
            title="No skill executions"
            description="Built-in skill runs and blocked attempts will appear here."
          />
        ) : (
          executions.map((record) => (
            <SettingsRow
              key={record.id}
              title={executionLabel(record)}
              description={record.message}
              status={record.startedAt}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
