import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkRecord, WorkRecordCore } from "kankaku/domain";
import type { SessionState } from "./session-state.ts";
import type { RecordAssignment } from "./work-target.ts";

/** `version` from a `package.json`, or `undefined` when unreadable — never guessed. */
export function readPackageVersion(file: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// Resolved once per hook process; `src/` and `dist/` share the same depth.
const PLUGIN_VERSION = readPackageVersion(
  join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"),
);

/**
 * Attaches the orchestrator metadata a replayed {@link WorkRecordCore}
 * needs to become a persistable {@link WorkRecord}. `assignment` carries the
 * resolved hub target (`clientId`, `clientName`, `projectId`, `projectName`)
 * and the legacy `client` label, stamped exactly as the pi extension does;
 * omitted, the record is unassigned. `model` is the statusline
 * model id (from `src/cost-store.ts#readCost`, since T7 no longer a field
 * of `SessionState`) — passed in explicitly rather than read here, so the
 * caller decides which cost snapshot's model applies.
 *
 * Also stamps who MEASURED the record (`agent`, `plugin`, `pluginVersion`),
 * so a worklog later synced by another tool (the kankaku TUI) keeps the
 * right identity. `agentVersion` is omitted: Claude Code passes its version
 * to no hook payload, and spawning `claude --version` from a hook is not
 * acceptable.
 */
export function buildClaudeRecord(
  core: WorkRecordCore,
  state: SessionState,
  sessionId: string,
  model: string | undefined,
  assignment: RecordAssignment = {},
): WorkRecord {
  const { target, legacyClient } = assignment;
  return {
    ...core,
    role: "orchestrator",
    pid: state.pid,
    parentPid: state.parentPid,
    project: state.cwd,
    sessionId,
    mode: "claude-code",
    agent: "claude-code",
    plugin: "kankaku-claude",
    ...(PLUGIN_VERSION !== undefined ? { pluginVersion: PLUGIN_VERSION } : {}),
    ...(model ? { model: `anthropic/${model}` } : {}),
    ...(legacyClient !== undefined ? { client: legacyClient } : {}),
    ...(target !== undefined
      ? {
          clientId: target.clientId,
          clientName: target.clientName,
          ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
          ...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
        }
      : {}),
  };
}
