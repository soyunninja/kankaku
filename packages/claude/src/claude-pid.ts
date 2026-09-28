import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface PsInfo {
  ppid: number;
  comm: string;
}

const SKIP_COMMS = new Set(["sh", "bash", "zsh", "dash", "fish", "node"]);
const MAX_HOPS = 6;

export interface ResolveClaudePidInput {
  startPid: number;
  runPs: (pid: number) => PsInfo | undefined;
}

/**
 * Walks ancestors from `startPid` (at most `MAX_HOPS` hops), returning the
 * first pid whose `comm` basename is not a shell or `node` — the Claude
 * Code process itself, skipping the shell/node layers a hook can be
 * launched through. Falls back to `startPid` when `ps` fails or nothing
 * qualifies within the hop budget.
 */
export function resolveClaudePid({ startPid, runPs }: ResolveClaudePidInput): number {
  let pid = startPid;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const info = runPs(pid);
    if (!info) return startPid;
    if (!SKIP_COMMS.has(basename(info.comm))) return pid;
    pid = info.ppid;
  }
  return startPid;
}

/** Production `runPs`: `ps -o ppid=,comm= -p <pid>`, bounded to 200ms. */
export function runPsProcess(pid: number): PsInfo | undefined {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      timeout: 200,
      encoding: "utf8",
    });
    const match = out.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return undefined;
    const ppid = Number(match[1]);
    const comm = match[2]?.trim();
    if (!Number.isFinite(ppid) || !comm) return undefined;
    return { ppid, comm };
  } catch {
    return undefined;
  }
}

/**
 * `true` unless `process.kill(pid, 0)` throws with a code other than
 * `EPERM`. A non-positive or non-integer pid is always `false`, without
 * calling `process.kill` at all: `pid` 0 signals the whole process GROUP
 * (T7 — the defect that let a placeholder state file's `pid: 0` read back
 * as alive forever).
 */
export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
