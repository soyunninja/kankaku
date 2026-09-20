import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";

/**
 * One OS ancestor-chain snapshot: `pid -> ppid` for every process visible to
 * this user at the moment it was taken, plus each pid's approximate OS
 * start-time identity (`startIdByPid`, epoch-ms estimate). The identity map
 * is used to prove a pid still refers to the same process instance a
 * registry entry was written for (see `domain/ancestry-match.ts`); it is
 * empty for a pid whose start time could not be determined (also always
 * empty on Windows), never a reason to fail the ppid-map part of the
 * snapshot.
 */
export interface AncestrySnapshot {
  ppidByPid: Map<number, number>;
  startIdByPid: Map<number, number>;
}

/** One raw `pid -> ppid` and `pid -> startId` read, before either mechanism is chosen. */
export interface ProcSnapshot {
  ppidByPid: Map<number, number>;
  startIdByPid: Map<number, number>;
}

/** Parse `ps -eo pid,ppid[,...]` output (header line plus one `<pid> <ppid> ...` row per line) into a `pid -> ppid` map. Extra trailing columns (e.g. `etimes`) are ignored here. */
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

/**
 * `ps`'s portable elapsed-time column is `etime` (`[[dd-]hh:]mm:ss`), not
 * the GNU-only `etimes` (plain seconds): BSD `ps` — macOS included — has no
 * `etimes` keyword at all and errors out on it, which would silently break
 * ancestor-chain detection everywhere on that platform (the `ps` fallback
 * throws, degrading straight to an empty snapshot) — a real regression
 * caught by testing this against a real `ps` before trusting it. `etime`,
 * by contrast, is supported by both BSD and GNU `ps`.
 */
const ETIME_PATTERN = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;

/** Parse one `ps` `etime` value (`[[dd-]hh:]mm:ss`) into whole seconds, or `undefined` if it does not match the expected shape. */
export function parseEtimeSeconds(etime: string): number | undefined {
  const match = ETIME_PATTERN.exec(etime.trim());
  if (!match) return undefined;
  const days = match[1] !== undefined ? Number(match[1]) : 0;
  const hours = match[2] !== undefined ? Number(match[2]) : 0;
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse the `etime` (elapsed time since start, `[[dd-]hh:]mm:ss`) column
 * out of `ps -eo pid,ppid,etime` output into an approximate start-epoch-ms
 * estimate per pid: `nowMs - etimeSeconds * 1000`. `etime` truncates to
 * whole seconds, so this is accurate to within about a second either way —
 * well within `domain/ancestry-match.ts`'s tolerance.
 */
export function parsePsEtimes(output: string, nowMs: number): Map<number, number> {
  const map = new Map<number, number>();
  const lines = output.split("\n").slice(1);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const pid = Number(parts[0]);
    const etimeSeconds = parts[2] !== undefined ? parseEtimeSeconds(parts[2]) : undefined;
    if (Number.isFinite(pid) && etimeSeconds !== undefined) map.set(pid, nowMs - etimeSeconds * 1000);
  }
  return map;
}

const PPID_LINE = /^PPid:\s*(\d+)/m;

/** Extract the `PPid:` value from one `/proc/<pid>/status` file's contents, or `undefined` when the line is missing/malformed. Kept as a small tested utility; the live snapshot path below reads `/proc/<pid>/stat` instead, since that file carries both ppid and start time in a single read. */
export function parseProcStatus(status: string): number | undefined {
  const match = PPID_LINE.exec(status);
  if (!match) return undefined;
  const ppid = Number(match[1]);
  return Number.isFinite(ppid) ? ppid : undefined;
}

/**
 * Parse one `/proc/<pid>/stat` line: `pid (comm) state ppid ... starttime ...`.
 * `comm` (the process name) is parenthesized and may itself contain spaces
 * or parens, so every field is located relative to the *last* `)` on the
 * line, never by naive whitespace-splitting from the start. `ppid` is field
 * 4 overall (index 1 after the comm) and `starttime` is field 22 overall
 * (index 19) — the number of clock ticks since boot at which this process
 * started, per `proc(5)`.
 */
export function parseProcStat(stat: string): { ppid: number; starttimeTicks: number } | undefined {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen === -1) return undefined;
  const rest = stat.slice(closeParen + 1).trim();
  if (!rest) return undefined;
  const fields = rest.split(/\s+/);
  const ppid = Number(fields[1]);
  const starttimeTicks = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(starttimeTicks)) return undefined;
  return { ppid, starttimeTicks };
}

/** Parse the first number (system uptime in seconds) out of `/proc/uptime`'s contents. */
export function parseProcUptimeSeconds(content: string): number | undefined {
  const first = content.trim().split(/\s+/)[0];
  const value = first !== undefined ? Number(first) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The near-universal Linux `USER_HZ` (clock ticks per second used by
 * `/proc/<pid>/stat`'s `starttime` field), assumed rather than queried
 * (Node has no `sysconf` binding). A wrong assumption never produces a
 * false *match*: the same (possibly wrong) constant is used both when an
 * entry is first written and whenever it is later re-verified, and
 * `starttimeTicks` is fixed for a process's lifetime, so two readings of
 * the *same* process instance still agree closely regardless of the true
 * `USER_HZ` — only the (unused) absolute-epoch interpretation would be
 * off. See `domain/ancestry-match.ts`.
 */
const ASSUMED_USER_HZ = 100;

/** One `ps -eo pid,ppid,etimes` snapshot — a single subprocess spawn regardless of how many ancestor hops are later walked (SUBAGENT-REQ-011), carrying start-time identity alongside the ppid map. */
function readSnapshotViaPs(): ProcSnapshot {
  const output = execFileSync("ps", ["-eo", "pid,ppid,etime"], { encoding: "utf8", timeout: 2000 });
  const nowMs = Date.now();
  return { ppidByPid: parsePsOutput(output), startIdByPid: parsePsEtimes(output, nowMs) };
}

/** `/proc/<pid>/stat` reads — no subprocess spawn at all, cheaper than the `ps` snapshot, Linux-only. Carries start-time identity (`/proc/uptime` + `starttime` ticks) alongside the ppid map, at no extra spawn cost. */
function readSnapshotViaProc(): ProcSnapshot {
  const ppidByPid = new Map<number, number>();
  const starttimeTicksByPid = new Map<number, number>();

  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isFinite(pid)) continue;
    try {
      const parsed = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (parsed) {
        ppidByPid.set(pid, parsed.ppid);
        starttimeTicksByPid.set(pid, parsed.starttimeTicks);
      }
    } catch {
      // The process exited between listing and reading, or is unreadable; skip it.
    }
  }

  const startIdByPid = new Map<number, number>();
  if (starttimeTicksByPid.size > 0) {
    try {
      const uptimeSec = parseProcUptimeSeconds(readFileSync("/proc/uptime", "utf8"));
      if (uptimeSec !== undefined) {
        const bootEpochMs = Date.now() - uptimeSec * 1000;
        for (const [pid, ticks] of starttimeTicksByPid) {
          startIdByPid.set(pid, bootEpochMs + (ticks / ASSUMED_USER_HZ) * 1000);
        }
      }
    } catch {
      // /proc/uptime unavailable: the ppid map above is still useful on its own; start ids just stay empty.
    }
  }

  return { ppidByPid, startIdByPid };
}

export interface SnapshotAncestryDeps {
  /** Defaults to `os.platform()`. Windows (`"win32"`) always yields an empty snapshot — no supported mechanism, never a spawn attempt (SUBAGENT-REQ-012). */
  platform?: NodeJS.Platform;
  /** Injectable for tests, so no test ever reads the real `/proc`. */
  readProc?: () => ProcSnapshot;
  /** Injectable for tests, so no test ever spawns a real `ps`. */
  readPs?: () => ProcSnapshot;
}

/**
 * Take one ancestor-chain snapshot: `/proc` first (cheapest, Linux), falling
 * back to `ps -eo pid,ppid,etimes` (macOS, or a Linux without `/proc`
 * mounted). Windows — and any environment where both mechanisms fail —
 * degrades to an empty snapshot rather than throwing or blocking
 * (SUBAGENT-REQ-012): callers see "no tracked ancestor found," never a
 * crash. `startIdByPid` may legitimately be sparser than `ppidByPid` (a
 * pid whose start time could not be read); callers must treat a missing
 * start id as "unprovable," never as a match.
 */
export function snapshotAncestry(deps: SnapshotAncestryDeps = {}): AncestrySnapshot {
  const osPlatform = deps.platform ?? platform();
  if (osPlatform === "win32") return { ppidByPid: new Map(), startIdByPid: new Map() };

  const readProc = deps.readProc ?? readSnapshotViaProc;
  const readPs = deps.readPs ?? readSnapshotViaPs;

  try {
    return readProc();
  } catch {
    // /proc unavailable (macOS, or a Linux without it mounted); fall through to ps.
  }
  try {
    return readPs();
  } catch {
    return { ppidByPid: new Map(), startIdByPid: new Map() };
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
