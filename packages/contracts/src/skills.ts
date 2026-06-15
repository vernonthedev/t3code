import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const SkillId = TrimmedNonEmptyString.pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

export const SkillProviderKind = Schema.Literals(["builtin", "local", "skills.sh"]);
export type SkillProviderKind = typeof SkillProviderKind.Type;

export const SkillPermission = TrimmedNonEmptyString.pipe(Schema.brand("SkillPermission"));
export type SkillPermission = typeof SkillPermission.Type;

export const SkillDefinition = Schema.Struct({
  id: SkillId,
  name: TrimmedNonEmptyString,
  description: TrimmedString,
  version: TrimmedNonEmptyString,
  provider: SkillProviderKind,
  permissions: Schema.Array(SkillPermission).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  installPath: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
});
export type SkillDefinition = typeof SkillDefinition.Type;

export const SkillRegistrySnapshot = Schema.Struct({
  defaultInstallPath: Schema.String,
  configuredInstallPath: Schema.String,
  skills: Schema.Array(SkillDefinition),
});
export type SkillRegistrySnapshot = typeof SkillRegistrySnapshot.Type;

export const SkillSearchInput = Schema.Struct({
  query: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type SkillSearchInput = typeof SkillSearchInput.Type;

export const SkillSearchResult = Schema.Struct({
  skills: Schema.Array(SkillDefinition),
});
export type SkillSearchResult = typeof SkillSearchResult.Type;

export const SkillAuditIssueSeverity = Schema.Literals(["info", "warning", "critical"]);
export type SkillAuditIssueSeverity = typeof SkillAuditIssueSeverity.Type;

export const SkillAuditStatus = Schema.Literals(["trusted", "warning", "unknown", "failed"]);
export type SkillAuditStatus = typeof SkillAuditStatus.Type;

export const SkillAuditReport = Schema.Struct({
  skillId: SkillId,
  provider: SkillProviderKind,
  status: SkillAuditStatus,
  summary: TrimmedString,
  checkedAt: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      severity: SkillAuditIssueSeverity,
      message: TrimmedString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sourceUrl: Schema.optional(Schema.String),
});
export type SkillAuditReport = typeof SkillAuditReport.Type;

export const SkillInstallInput = Schema.Struct({
  id: SkillId,
  provider: SkillProviderKind.pipe(
    Schema.withDecodingDefault(Effect.succeed("skills.sh" as const)),
  ),
});
export type SkillInstallInput = typeof SkillInstallInput.Type;

export const SkillInstallResult = Schema.Struct({
  skill: SkillDefinition,
  audit: SkillAuditReport,
});
export type SkillInstallResult = typeof SkillInstallResult.Type;

export const SkillCreateInput = Schema.Struct({
  id: SkillId,
  name: TrimmedNonEmptyString,
  description: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  version: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("0.1.0"))),
  permissions: Schema.Array(SkillPermission).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SkillCreateInput = typeof SkillCreateInput.Type;

export const SkillSetEnabledInput = Schema.Struct({
  id: SkillId,
  enabled: Schema.Boolean,
});
export type SkillSetEnabledInput = typeof SkillSetEnabledInput.Type;

export const SkillExecuteInput = Schema.Struct({
  id: SkillId,
  input: Schema.Unknown,
  cwd: Schema.optional(Schema.String),
});
export type SkillExecuteInput = typeof SkillExecuteInput.Type;

export const SkillExecutionStatus = Schema.Literals(["success", "failed", "blocked"]);
export type SkillExecutionStatus = typeof SkillExecutionStatus.Type;

export const SkillExecutionRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  skillId: SkillId,
  skillName: TrimmedNonEmptyString,
  startedAt: Schema.String,
  durationMs: Schema.Number,
  status: SkillExecutionStatus,
  permissions: Schema.Array(SkillPermission).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  message: TrimmedString,
});
export type SkillExecutionRecord = typeof SkillExecutionRecord.Type;

export const SkillExecutionResult = Schema.Struct({
  output: Schema.Unknown,
  execution: SkillExecutionRecord,
});
export type SkillExecutionResult = typeof SkillExecutionResult.Type;

export class SkillProviderError extends Schema.TaggedErrorClass<SkillProviderError>()(
  "SkillProviderError",
  {
    message: Schema.String,
    provider: SkillProviderKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class SkillExecutionError extends Schema.TaggedErrorClass<SkillExecutionError>()(
  "SkillExecutionError",
  {
    message: Schema.String,
    skillId: SkillId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
