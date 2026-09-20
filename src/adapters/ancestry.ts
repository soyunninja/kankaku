import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";

/** One OS ancestor-chain snapshot: `pid -> ppid` for every process visible to this user at the moment it was taken. */
export interface AncestrySnapshot {
  ppidByPid: Map<number, number>;
}

/** Parse `ps -eo pid,ppid` output (header line plus one `<pid> <ppid>` row per line) into a `pid -> ppid` map. */
export function parsePsOutput(output: string): Map<number, number> {
  const map = new Map<number, number>();
  const lines = output.split("\n").slice(1); // drop the header line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid, ppid);
  }
  return map;
}

const PPID_LINE = /^PPid:\s*(\d+)/m;

/** Extract the `PPid:` value from one `/proc/<pid>/status` file's contents, or `undefined` when the line is missing/malformed. */
export function parseProcStatus(status: string): number | undefined {
  const match = PPID_LINE.exec(status);
  if (!match) return undefined;
  const ppid = Number(match[1]);
  return Number.isFinite(ppid) ? ppid : undefined;
}

/** One `ps -eo pid,ppid` snapshot — a single subprocess spawn regardless of how many ancestor hops are later walked (SUBAGENT-REQ-011). */
function readPpidMapViaPs(): Map<number, number> {
  const output = execFileSync("ps", ["-eo", "pid,ppid"], { encoding: "utf8", timeout: 2000 });
  return parsePsOutput(output);
}

/** `/proc/<pid>/status` reads — no subprocess spawn at all, cheaper than the `ps` snapshot, Linux-only. */
function readPpidMapViaProc(): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isFinite(pid)) continue;
    try {
      const ppid = parseProcStatus(readFileSync(`/proc/${entry}/status`, "utf8"));
      if (ppid !== undefined) map.set(pid, ppid);
    } catch {
      // The process exited between listing and reading, or is unreadable; skip it.
    }
  }
  return map;
}

export interface SnapshotAncestryDeps {
  /** Defaults to `os.platform()`. Windows (`"win32"`) always yields an empty snapshot — no supported mechanism, never a spawn attempt (SUBAGENT-REQ-012). */
  platform?: NodeJS.Platform;
  /** Injectable for tests, so no test ever reads the real `/proc`. */
  readProc?: () => Map<number, number>;
  /** Injectable for tests, so no test ever spawns a real `ps`. */
  readPs?: () => Map<number, number>;
}

/**
 * Take one ancestor-chain snapshot: `/proc` first (cheapest, Linux), falling
 * back to `ps -eo pid,ppid` (macOS, or a Linux without `/proc` mounted).
 * Windows — and any environment where both mechanisms fail — degrades to an
 * empty snapshot rather than throwing or blocking (SUBAGENT-REQ-012):
 * callers see "no tracked ancestor found," never a crash.
 */
export function snapshotAncestry(deps: SnapshotAncestryDeps = {}): AncestrySnapshot {
  const osPlatform = deps.platform ?? platform();
  if (osPlatform === "win32") return { ppidByPid: new Map() };

  const readProc = deps.readProc ?? readPpidMapViaProc;
  const readPs = deps.readPs ?? readPpidMapViaPs;

  try {
    return { ppidByPid: readProc() };
  } catch {
    // /proc unavailable (macOS, or a Linux without it mounted); fall through to ps.
  }
  try {
    return { ppidByPid: readPs() };
  } catch {
    return { ppidByPid: new Map() };
  }
}

const DEFAULT_MAX_HOPS = 20;

/**
 * Walk from `startPid` (typically this process's own `parentPid`) upward
 * via `ppidByPid`, collecting ancestor pids in order, nearest first.
 * Stops at `maxHops`, at pid 0/1 (the OS/init root), or when the chain
 * leaves the snapshot (a pid with no known ppid) — a non-tracked
 * intermediate hop (e.g. a thin shell wrapper) is walked past, not stopped
 * at, since it simply has no entry of its own in the caller's registry
 * lookup (SUBAGENT-REQ-011).
 */
export function walkAncestry(startPid: number, ppidByPid: Map<number, number>, maxHops: number = DEFAULT_MAX_HOPS): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>();
  let current: number | undefined = startPid;

  for (let hop = 0; hop < maxHops && current !== undefined && current > 1 && !seen.has(current); hop++) {
    ancestors.push(current);
    seen.add(current);
    current = ppidByPid.get(current);
  }

  return ancestors;
}
