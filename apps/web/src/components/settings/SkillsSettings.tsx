import type {
  SkillAuditReport,
  SkillDefinition,
  SkillExecutionRecord,
  SkillId,
  SkillPermission,
  SkillRegistrySnapshot,
  SkillSearchResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  EllipsisIcon,
  FileCode2Icon,
  ListChecksIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "../ui/command";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type SkillsView = "available" | "online";

const EMPTY_SEARCH_RESULT: SkillSearchResult = { skills: [] };

function showError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Unexpected skills runtime error.",
    }),
  );
}

function permissionsFromText(value: string): SkillPermission[] {
  return value
    .split(",")
    .map((permission) => permission.trim())
    .filter(Boolean) as SkillPermission[];
}

function SkillSourceBadge({ provider }: { provider: SkillDefinition["provider"] }) {
  return (
    <span className="rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {provider}
    </span>
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

function SkillRow({
  skill,
  status,
  busy,
  onToggle,
  onAudit,
  onExecute,
  onOpenLogs,
  onRemove,
  onUpdate,
}: {
  skill: SkillDefinition;
  status?: React.ReactNode;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
  onAudit: () => void;
  onExecute: () => void;
  onOpenLogs: () => void;
  onRemove: () => void;
  onUpdate: () => void;
}) {
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{skill.name}</span>
          <SkillSourceBadge provider={skill.provider} />
        </span>
      }
      description={`${skill.id} - v${skill.version}`}
      status={status ?? <PermissionList permissions={skill.permissions} />}
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={`Open settings for ${skill.name}`}
                disabled={busy}
              >
                <EllipsisIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end" className="w-56">
            <MenuGroup>
              <MenuGroupLabel>Skill</MenuGroupLabel>
              <MenuCheckboxItem checked={skill.enabled} variant="switch" onCheckedChange={onToggle}>
                Enabled
              </MenuCheckboxItem>
              <MenuItem disabled={skill.provider !== "builtin"} onClick={onExecute}>
                <CheckCircle2Icon />
                Run smoke test
              </MenuItem>
              <MenuItem onClick={onAudit}>
                <ShieldCheckIcon />
                View audit
              </MenuItem>
              <MenuItem onClick={onOpenLogs}>
                <ListChecksIcon />
                View execution logs
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem onClick={onUpdate}>
                <RefreshCwIcon />
                Update skill
              </MenuItem>
              <MenuItem variant="destructive" onClick={onRemove}>
                <Trash2Icon />
                Remove skill
              </MenuItem>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    />
  );
}

function SkillSearchDialog({
  open,
  installedIds,
  busySkillId,
  audits,
  onOpenChange,
  onInstall,
  onAudit,
}: {
  open: boolean;
  installedIds: ReadonlySet<string>;
  busySkillId: string | null;
  audits: Record<string, SkillAuditReport>;
  onOpenChange: (open: boolean) => void;
  onInstall: (skill: SkillDefinition) => void;
  onAudit: (skill: SkillDefinition) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SkillSearchResult>(EMPTY_SEARCH_RESULT);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResult(EMPTY_SEARCH_RESULT);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      setResult(EMPTY_SEARCH_RESULT);
      return;
    }

    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void ensureLocalApi()
        .skills.search({ query: trimmedQuery })
        .then((nextResult) => {
          if (!abort.signal.aborted) {
            setResult(nextResult);
          }
        })
        .catch((error) => {
          if (!abort.signal.aborted) {
            showError("Skill search failed", error);
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) {
            setLoading(false);
          }
        });
    }, 250);

    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup className="max-w-2xl">
        <Command filter={null} value={query} onValueChange={setQuery}>
          <CommandInput placeholder="Search online skills" />
          <CommandPanel>
            <CommandList>
              {result.warning ? (
                <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                  {result.warning}
                </div>
              ) : null}
              <CommandEmpty>
                {loading ? "Searching..." : "Search skills.sh for community skills."}
              </CommandEmpty>
              <CommandGroup items={result.skills}>
                <CommandGroupLabel>Online skills</CommandGroupLabel>
                <CommandCollection>
                  {(skill: SkillDefinition) => (
                    <CommandItem
                      key={skill.id}
                      value={skill.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="truncate text-sm font-medium">{skill.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {skill.description || skill.id}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <AuditStatus audit={audits[skill.id]} />
                          <PermissionList permissions={skill.permissions} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busySkillId === skill.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            onAudit(skill);
                          }}
                        >
                          Audit
                        </Button>
                        <Button
                          size="xs"
                          disabled={busySkillId === skill.id || installedIds.has(skill.id)}
                          onClick={(event) => {
                            event.stopPropagation();
                            onInstall(skill);
                          }}
                        >
                          Install
                        </Button>
                      </div>
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function AuditStatus({ audit }: { audit: SkillAuditReport | undefined }) {
  if (!audit) return <span>Audit not loaded</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <ShieldCheckIcon className="size-3" />
      {audit.status}
    </span>
  );
}

function ExecutionLogsDialog({
  open,
  executions,
  onOpenChange,
}: {
  open: boolean;
  executions: readonly SkillExecutionRecord[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Skill Execution Logs</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          {executions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Built-in skill runs and blocked attempts will appear here.
            </p>
          ) : (
            executions.map((record) => (
              <div key={record.id} className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{record.skillName}</span>
                  <span className="text-xs text-muted-foreground">{record.durationMs}ms</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{record.message}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/70">{record.startedAt}</p>
              </div>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function AuditDialog({
  audit,
  open,
  onOpenChange,
}: {
  audit: SkillAuditReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Audit Report</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {audit ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <ShieldCheckIcon className="size-4 text-muted-foreground" />
                <span className="font-medium">{audit.status}</span>
              </div>
              <p className="text-muted-foreground">{audit.summary}</p>
              <p className="text-xs text-muted-foreground">Checked {audit.checkedAt}</p>
              {audit.issues.length > 0 ? (
                <div className="space-y-2">
                  {audit.issues.map((issue) => (
                    <div
                      key={`${issue.severity}-${issue.message}`}
                      className="rounded-md border p-2"
                    >
                      <span className="text-xs font-medium">{issue.severity}</span>
                      <p className="text-xs text-muted-foreground">{issue.message}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No audit report loaded.</p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function SkillsSettingsPanel() {
  const navigate = useNavigate();
  const skillsSettings = useSettings((settings) => settings.skills);
  const { updateSettings } = useUpdateSettings();
  const [snapshot, setSnapshot] = useState<SkillRegistrySnapshot | null>(null);
  const [executions, setExecutions] = useState<readonly SkillExecutionRecord[]>([]);
  const [audits, setAudits] = useState<Record<string, SkillAuditReport>>({});
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [view, setView] = useState<SkillsView>("available");
  const [searchOpen, setSearchOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [activeAudit, setActiveAudit] = useState<SkillAuditReport | null>(null);

  const installedSkills = snapshot?.skills ?? [];
  const defaultInstallPath = snapshot?.defaultInstallPath ?? "";
  const configuredInstallPath = skillsSettings.installPath || snapshot?.configuredInstallPath || "";
  const installedById = useMemo(
    () => new Set(installedSkills.map((skill) => skill.id)),
    [installedSkills],
  );
  const availableSkills = installedSkills.filter((skill) => skill.provider !== "skills.sh");
  const onlineSkills = installedSkills.filter((skill) => skill.provider === "skills.sh");
  const visibleSkills = view === "available" ? availableSkills : onlineSkills;

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

  const handleAudit = useCallback(async (skill: SkillDefinition) => {
    try {
      setBusySkillId(skill.id);
      const audit = await ensureLocalApi().skills.audit({ id: skill.id, provider: skill.provider });
      setAudits((current) => ({ ...current, [skill.id]: audit }));
      setActiveAudit(audit);
      setAuditOpen(true);
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
        setView("online");
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
        setLogsOpen(true);
      } catch (error) {
        showError("Skill execution failed", error);
        await reload().catch(() => undefined);
      } finally {
        setBusySkillId(null);
      }
    },
    [reload],
  );

  const handleUnsupportedAction = useCallback((title: string) => {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title,
        description: "This action is wired in the menu and will be backed by the next runtime API.",
      }),
    );
  }, []);

  return (
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection
        title="Skills"
        icon={<SparklesIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setSearchOpen(true)}>
            <SearchIcon className="size-3.5" />
            Search
          </Button>
        }
      >
        <div className="border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex w-fit rounded-lg border bg-muted/40 p-1">
              {(["available", "online"] as const).map((item) => (
                <button
                  key={item}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium capitalize",
                    view === item
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  type="button"
                  onClick={() => setView(item)}
                >
                  {item === "available"
                    ? `Available skills (${availableSkills.length})`
                    : `Online skills (${onlineSkills.length})`}
                </button>
              ))}
            </div>
            <Button size="xs" onClick={() => void navigate({ to: "/settings/skills/create" })}>
              <PlusIcon className="size-3.5" />
              Create skill
            </Button>
          </div>
        </div>

        {visibleSkills.length === 0 ? (
          <SettingsRow
            title={view === "available" ? "No local skills" : "No online skills installed"}
            description={
              view === "available"
                ? "Built-in and local skills appear here."
                : "Install a remote skill from the search dialog to see it here."
            }
          />
        ) : (
          visibleSkills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              busy={busySkillId === skill.id}
              onToggle={(enabled) => void handleToggle(skill, enabled)}
              onAudit={() => void handleAudit(skill)}
              onExecute={() => void handleExecuteSmokeTest(skill)}
              onOpenLogs={() => setLogsOpen(true)}
              onUpdate={() => handleUnsupportedAction("Update skill")}
              onRemove={() => handleUnsupportedAction("Remove skill")}
            />
          ))
        )}
      </SettingsSection>

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

      <SkillSearchDialog
        open={searchOpen}
        installedIds={installedById}
        busySkillId={busySkillId}
        audits={audits}
        onOpenChange={setSearchOpen}
        onInstall={handleInstall}
        onAudit={handleAudit}
      />
      <ExecutionLogsDialog open={logsOpen} executions={executions} onOpenChange={setLogsOpen} />
      <AuditDialog audit={activeAudit} open={auditOpen} onOpenChange={setAuditOpen} />
    </SettingsPageContainer>
  );
}

export function CreateSkillSettingsPanel() {
  const navigate = useNavigate();
  const [newSkill, setNewSkill] = useState({
    id: "",
    name: "",
    description: "",
    permissions: "",
  });
  const [busy, setBusy] = useState(false);

  const handleCreate = useCallback(async () => {
    try {
      const id = newSkill.id.trim();
      const name = newSkill.name.trim() || id;
      if (!id) return;
      setBusy(true);
      await ensureLocalApi().skills.create({
        id: id as SkillId,
        name,
        description: newSkill.description.trim(),
        version: "0.1.0",
        permissions: permissionsFromText(newSkill.permissions),
      });
      await navigate({ to: "/settings/skills" });
    } catch (error) {
      showError("Could not create skill", error);
    } finally {
      setBusy(false);
    }
  }, [navigate, newSkill]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Create Skill" icon={<SparklesIcon className="size-3.5" />}>
        <SettingsRow
          title="Skill ID"
          description="Stable identifier used by agents and runtime logs."
          control={
            <Input
              value={newSkill.id}
              placeholder="git_commit_message_generator"
              className="min-w-0 sm:w-80"
              onChange={(event) =>
                setNewSkill((current) => ({ ...current, id: event.currentTarget.value }))
              }
            />
          }
        />
        <SettingsRow
          title="Name"
          description="Human-readable label shown in the skills panel."
          control={
            <Input
              value={newSkill.name}
              placeholder="Commit message generator"
              className="min-w-0 sm:w-80"
              onChange={(event) =>
                setNewSkill((current) => ({ ...current, name: event.currentTarget.value }))
              }
            />
          }
        />
        <SettingsRow
          title="Description"
          description="Short description used during discovery."
          control={
            <Input
              value={newSkill.description}
              placeholder="Generate commit messages from diffs"
              className="min-w-0 sm:w-80"
              onChange={(event) =>
                setNewSkill((current) => ({ ...current, description: event.currentTarget.value }))
              }
            />
          }
        />
        <SettingsRow
          title="Permissions"
          description="Comma-separated permissions requested by this skill."
          control={
            <Input
              value={newSkill.permissions}
              placeholder="workspace:read, git:read"
              className="min-w-0 sm:w-80"
              onChange={(event) =>
                setNewSkill((current) => ({ ...current, permissions: event.currentTarget.value }))
              }
            />
          }
        >
          <DialogFooter variant="bare" className="px-0">
            <Button variant="outline" onClick={() => void navigate({ to: "/settings/skills" })}>
              Cancel
            </Button>
            <Button disabled={busy || !newSkill.id.trim()} onClick={() => void handleCreate()}>
              <PlusIcon className="size-4" />
              Create skill
            </Button>
          </DialogFooter>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
