# kankaku

A [pi](https://pi.dev) extension that measures how long an agent actually
spends working on each prompt, so the time can later be accounted for
(billing, reporting).

## What it measures

For every prompt, kankaku tracks the span from `before_agent_start` to
`agent_settled` (or to `session_shutdown` if pi exits mid-run) and splits it
into:

- **`waitingMs`**: time pi spent blocked on the user — the union of
  `ui_prompt_start/end` spans and the execution spans of configured
  interactive tools (default `ask_user_question`, `ask_user_choice`). Union
  avoids double-counting when a tool internally triggers a UI prompt.
- **`workMs`**: `wallMs - waitingMs`, the actual work time.

Every pi process — the orchestrator and any subagent child spawned by
`subagent_run` — records its own prompt-to-idle spans, tagged with a `role`
(`orchestrator` or `subagent`) and its `pid`/`parentPid`, so records can be
joined later.

## Install

kankaku is a pi package. Pick one source:

```
pi install npm:kankaku                          # from npm
pi install git:github.com/soyunninja/kankaku    # from git (add @v0.1.0 to pin)
pi install /absolute/path/to/kankaku            # local checkout, no copy
```

`pi install` writes to your global `~/.pi/agent/settings.json`, so the
extension loads in every pi process, including the subagent children that
`subagent_run` spawns. Use `-l` to install into a project's `.pi/settings.json`
instead; note that project-local resources load only after the project is
trusted, which a subagent child may not inherit.

To try it without installing: `pi -e /absolute/path/to/kankaku`.

## Record schema

Each line in `worklog.jsonl` is one JSON object:

```json
{
  "schema": 1,
  "id": "uuid",
  "role": "orchestrator",
  "pid": 4242,
  "parentPid": 4000,
  "project": "/abs/project/path",
  "sessionId": "…",
  "sessionFile": "…",
  "mode": "tui",
  "model": "anthropic/claude-opus",
  "client": "acme",
  "sessionName": "billing sprint",
  "sessionDir": "/abs/custom/session/dir",
  "clientId": "pocketbase-record-id",
  "clientName": "Acme",
  "projectId": "pocketbase-record-id",
  "projectName": "Portal",
  "machine": "laptop",
  "prompt": "first 200 chars of the first prompt",
  "startedAt": "2026-09-10T16:00:00.000Z",
  "settledAt": "2026-09-10T16:04:10.000Z",
  "wallMs": 250000,
  "waitingMs": 30000,
  "workMs": 220000,
  "runs": 2,
  "turns": 9,
  "tools": { "bash": 4, "read": 3, "subagent_run": 1, "ask_user_question": 1 },
  "subagents": [{ "toolCallId": "…", "agent": "sdd-explore", "mode": "task", "taskId": "t1", "ms": 90000 }],
  "segments": { "review": 62000 },
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0 },
  "status": "completed",
  "roleConfidence": "uncertain",
  "orchestratorRef": { "pid": 4000, "project": "/abs/other-worktree", "startedAt": "2026-09-10T15:59:00.000Z", "dir": "/abs/other-worktree/.kankaku" }
}
```

`status` is one of `completed`, `aborted` (the last assistant message had
`stopReason: "aborted"`), or `interrupted` (pi shut down while still
running).

`roleConfidence` and `orchestratorRef` are both optional and normally
absent — see "Subagents" below. `roleConfidence` is only ever set to
`"uncertain"`, and only on an `orchestrator`-role record kankaku could not
positively prove top-level; `orchestratorRef` is only ever set on a
`subagent`-role record that discovered its tracked ancestor via the
machine-wide process registry. Its optional `dir` field carries that
orchestrator's resolved kankaku directory — the real top-level one even
across a subagent-of-subagent chain — and is what this process's own
work log and inflight checkpoints were actually routed into when it
differs from this process's own (see "Subagents" > "Cross-worktree write
routing"). Neither field, nor `orchestratorRef.dir`, bumps
`WORK_RECORD_SCHEMA` — a record without them (from an older kankaku build)
remains valid.

`clientId`, `clientName`, `projectId`, `projectName` and `machine` are only
present once a hub is configured (see "Hub (PocketBase)"); every report and
export written before this feature, or by a user without a hub, is
unaffected.

`sessionDir` is present only when pi's session manager reports a
*non-default* session directory (`--session-dir`, or a resumed session
started that way) — exactly the condition under which pi's own printed "To
resume this session: ..." line includes `--session-dir`. Most records never
carry it. `/kankaku doctor` shows it for the current session when set, and
it is available on a task's orchestrator record (`TaskView.sessionDir`) for
anything that wants to reconstruct the exact `pi --session-dir <dir>
--session <id>` resume command locally. When a hub is configured it is also
sent as `session_dir` on every sync (see "Hub (PocketBase)" > "Sync" >
"Agent and measurement quality").

## Task and session views

Each `WorkRecord` still measures one pi process's own prompt-to-idle span.
But a `subagent_run` in `background` mode returns immediately while its
child process keeps working, so the orchestrator's own `wallMs` can
under-report how long the task actually took. Two derived, read-only views
correct for that, built purely from `pid`/`parentPid`/`startedAt`/`settledAt`
already present on every record — no new fields are persisted to
`worklog.jsonl`.

- **Task**: one *confirmed* orchestrator record (see "Subagents" below —
  an orchestrator-role record flagged uncertain never anchors a task) plus
  every subagent record matched to it — `parentPid === orchestrator.pid`
  and the child's `startedAt` falling inside the orchestrator's
  `[startedAt, settledAt]` window; `project` is only a **hint**, preferred
  when it matches but never a hard filter (see "Subagents"). (If a pid is
  reused across runs and several orchestrator records match, a same-project
  candidate is preferred, then the latest-starting one.) A task's `wallMs`
  is the **union** of the orchestrator's interval and every matched child's
  interval — never their sum — so parallel background children are not
  double-counted, and a child that outlives the orchestrator's own settle
  time correctly extends the task's span. `waitingMs` is the orchestrator's
  own waiting time, `workMs = wallMs - waitingMs`, and `usage` is the sum of
  the orchestrator's and every child's token/cost totals.
- **Session**: tasks grouped by `sessionId` (tasks with no `sessionId` are
  grouped under `"unknown"`). A session's `wallMs` is the union of every
  interval — orchestrator and subagent alike — across all of its tasks;
  `waitingMs` is the sum of each task's `waitingMs`, and `workMs = wallMs -
  waitingMs`.
- **Orphan subagents**: a subagent record with no matching orchestrator
  record (for example, its parent's record was lost, or a cross-worktree
  registry entry had already expired) is excluded from every task but is
  not silently dropped — it stays visible so gaps in the log are noticeable
  rather than hidden. See "Subagents" for how a cross-worktree child is
  usually reunited *before* it ever becomes an orphan.

## Subagents

kankaku recognises gentle-pi's `subagent_run` tool as opening a subagent
span (unchanged from before this section); this describes how it decides,
for a process that shows no such marker, whether it is a genuine top-level
session or actually someone's subagent — and how a gentle-pi subagent
running in a *different git worktree* than its orchestrator still gets
correctly counted.

### The role/state model

Every record still carries the same binary persisted `role`
(`"orchestrator"` | `"subagent"`, unchanged — see "Record schema"). On top
of it, kankaku's task/session views and the hub sync apply a four-state
classification:

- **orchestrator** — confirmed top-level: no recognised child-env-marker
  (`GENTLE_PI_AGENTS_CHILD=1`, or an explicit `KANKAKU_ROLE=orchestrator` —
  see "Interactive sessions and `KANKAKU_ROLE`" below) is present, and
  either no live tracked ancestor process was found, or this session is
  itself interactive (see "The registry" and "Interactive sessions" below).
  This is the default for a plain, ordinary `pi` session — unaffected by
  any of this.
- **subagent (joined)** — a gentle-pi child matched to its orchestrator, as
  described in "Task and session views" above.
- **subagent (orphan)** — a gentle-pi child that could not be matched to
  any orchestrator (shown separately, never dropped — `orphanSubagents`).
- **uncertain** — no recognised child-env-marker, a live tracked ancestor
  process *was* found, **and** this process is not itself an interactive
  TUI session: it cannot be proven top-level, so it is never counted as a
  new task locally and never synced to the hub as one, but it is not
  dropped either — `WorkRecord.roleConfidence` is set to `"uncertain"` on
  it, and `/kankaku doctor` (and a one-line hint on the plain `/kankaku`
  summary) surface it so the gap is visible instead of silently wrong.
  This is the fix for a real bug: a subagent mechanism kankaku does not
  specifically recognise (for example, pi's own bundled reference
  `subagent` example, which sets no env marker at all) used to default to
  `"orchestrator"` outright — a phantom top-level task on top of the time
  already measured inside its parent's own tool-call span, billed twice.
  An unrecognised process now degrades to a safe, visible **undercount**
  instead of a silent, unrecoverable **overcount**. An *interactive*
  session is never demoted this way, no matter what its ancestry looks
  like — see "Interactive sessions and `KANKAKU_ROLE`" below for why, and
  for the escape hatch when kankaku still gets it wrong.

An `uncertain` classification is recoverable going forward: once the
mechanism is recognised (for example, by upgrading kankaku, setting
`KANKAKU_ROLE` explicitly, or — in a later version — registering it via a
configured tool/env marker), a later `/kankaku sync all` or `backfill`
picks up the record correctly. It never resolves itself by guessing. A
record that was *already written* `uncertain`, however, cannot be rewritten
after the fact — `worklog.jsonl` is append-only and kankaku never edits a
past line (see AGENTS.md) — so only a run *after* the fix correctly
anchors a task; there is no migration that goes back and reclassifies old
lines.

### The registry

Every kankaku process writes a small entry to
`~/.kankaku/run/<pid>.json` at startup — `pid`, `parentPid`, `role`,
`project`, its resolved (and, for a routed subagent, actually-used —
see "Cross-worktree write routing" below) `KANKAKU_DIR`, `startedAt`, and
`processStartId` (below) — independent of any project's own `KANKAKU_DIR`,
so it survives a project boundary. Both `~/.kankaku/run` and its entry
files are created owner-only (`0700`/`0600` — an existing looser mode, left
by an older kankaku build, is tightened on the next write, best-effort);
they name absolute project paths and session ids. **The registry is a
startup-time lookup only** — "who is my tracked ancestor, and where does
it keep its log" — resolved once, at process factory time, and never
consulted again later as a live pointer (this used to matter: see
"Cross-worktree write routing" below for why it no longer does). This is
what powers both of the following:

- **Uncertain detection**: a process with no child-env-marker walks its own
  OS ancestor chain (one snapshot, see "Ancestor-chain detection" below)
  looking for *any* live registry entry whose identity it can actually
  **prove** — see "Identity, not just pid" below. Finding one means some
  other tracked kankaku process is an ancestor of this one; combined with
  this process *not* being an interactive TUI session (see "Interactive
  sessions and `KANKAKU_ROLE`" below), it is classified `uncertain` rather
  than defaulting to `orchestrator`.
- **Cross-worktree write routing** (ADR 0023, rewritten for a real bug —
  see below): a gentle-pi subagent running in a different git worktree than
  its orchestrator walks its ancestor chain, finds its orchestrator's
  registry entry (identity-verified), and resolves it to an
  `orchestratorRef` (`{ pid, project, startedAt, dir }` — `dir` also
  resolves through a subagent-of-subagent chain to the real, top-level
  orchestrator, never a middle hop). When that orchestrator's directory
  differs from this process's own, the child writes its work log **and**
  its inflight crash-recovery checkpoints straight into the orchestrator's
  directory instead of its own cwd-relative one — so parent and child
  records end up in the *same* `worklog.jsonl` from the moment the child's
  first record is appended, not merely discovered there later. The
  orchestrator's later `buildTasks` call joins them with the same
  `pid`/`parentPid`/project-hint keys it always has; the interval-union
  rule itself is still computed in exactly one place (`buildTasks`) — this
  only changes *where the bytes physically live*, never how they are
  joined. If the orchestrator's directory cannot be created or written to
  (gone, or no permission), the child falls back to its own local
  directory instead of losing the record, and `/kankaku doctor` reports the
  fallback so it can be reunited manually; a record is always written to
  **exactly one** log, never both. Because reunification no longer depends
  on any pointer still being alive at read time, it survives the child's
  own exit cleanup removing its registry entry — which, for gentle-pi's
  main case (a blocking `subagent_run` in task mode), has already happened
  by the time the parent regains control. If ancestry could not be
  established at all (or the write genuinely could not go anywhere), the
  child stays a visible orphan instead — undercounted, never lost, and
  never compensated for by summing two independently synced rows: **the
  hub never sums two unions to recover a missing one**, since that would
  double-count the overlap between parent and child. `project` is
  therefore only ever a *hint* for the join (preferred when it matches),
  never a hard filter.
- The registry is swept opportunistically (when a process writes its own
  entry) — see "Registry cleanup and health" below — so it does not grow
  unbounded and never keeps serving a stale identity.

#### Identity, not just pid — the PID-reuse fix

Matching an ancestor pid to a registry entry by **pid number alone** is not
safe: operating systems reuse pids. A kankaku process that dies without
cleanup (a crash, `kill -9`) can leave its `~/.kankaku/run/<pid>.json`
entry behind; the OS can later hand that same pid to the user's own
interactive shell, and every *genuine* top-level pi session launched from
that shell would then falsely resolve a "tracked ancestor" — silently
misclassified `uncertain` forever, its task never synced. This inverts the
whole guarantee this feature exists for, so identity is proven, not
assumed:

- Every registry entry also carries `processStartId`: an approximate,
  self-consistent epoch-ms estimate of that process's actual OS start time.
  **This process's own** `processStartId` (the one it records about
  itself) is derived cheaply and portably — `Date.now() - process.uptime()
  * 1000`, sampled once at factory time — with **no subprocess spawn and no
  `/proc` read at all**, so it is available on every platform, Windows
  included, and never adds startup cost (see "Startup cost" below).
  Verifying *another* process's (an ancestor's) live identity still needs a
  fresh reading of that specific pid from an OS ancestor-chain snapshot: on
  macOS/BSD, `ps -eo pid,ppid,etime` (`[[dd-]hh:]mm:ss` elapsed time,
  forced through the portable `etime` keyword — BSD `ps` has no `etimes`);
  on Linux, `/proc/<pid>/stat`'s `starttime` (clock ticks since boot)
  combined with `/proc/uptime`, assuming the near-universal `USER_HZ=100` —
  a wrong assumption never causes a false match, since the same (possibly
  wrong) constant is used both when an entry is written and whenever it is
  re-verified, and a process's `starttime` ticks never change during its
  life. `process.uptime()`-derived and `ps`/`/proc`-derived readings of the
  *same* process instance agree within the same tolerance (2000ms, which
  also absorbs each source's own second-granularity rounding) — this is
  cross-checked against a real OS reading by
  `scripts/e2e-cross-worktree-real-processes.ts`. Windows has no supported
  source for a *live ancestor's* start time — see "Ancestor-chain
  detection" — so an ancestor still cannot be identity-verified there, even
  though this process's own id is now always available.
- A match is only trusted when **both** sides prove the same identity: the
  registry entry's own `processStartId` **and** a fresh re-derivation of
  that live pid's start time (from the ancestor's own current snapshot)
  agree within tolerance. A pid with a registry entry but a mismatched — or
  unprovable, on either side — identity is walked past exactly like an
  untracked hop, not treated as a match; if nothing further up the chain is
  provable either, ancestry detection reports "no tracked ancestor," which
  is the same safe fallback as if the registry were empty (this process
  classifies as a confirmed `orchestrator`, never `uncertain`, from an
  unprovable candidate alone).
- A legacy entry with no `processStartId` at all (written by a kankaku
  build predating this field) is never trusted for identity matching or
  kept around: it reads as stale and is removed by the normal sweep the
  next time any process writes its own entry.

#### Registry cleanup and health

- Every kankaku process removes its own entry file on a normal exit and on
  `session_shutdown` (best-effort, verifying the on-disk file's `pid` and
  `processStartId` still match its own before unlinking, so it can never
  remove a file it does not verifiably own) — a crash still leaves the
  entry for the next sweep. Immediately before unlinking a *discarded*
  entry, the sweep also re-reads that file and compares it byte-for-byte
  against what it judged stale: if the pid was reused and a fresh entry
  already written to the same path in the meantime, the file is left alone
  instead of destroying a live registration the sweep never actually
  evaluated.
- The opportunistic sweep (run whenever any process writes its own entry)
  removes: entries for a dead pid; entries whose pid is alive but whose
  recorded identity no longer matches that live process (pid reuse); and,
  as a last resort, entries older than 7 days regardless of
  aliveness/identity. An entry with **no verifiable identity at all**
  (legacy/malformed, no `processStartId`) is *never itself* grounds for
  deletion while its pid is alive and within the age ceiling — such an
  entry is never *used* for ancestor matching either way (matching always
  requires a verifiable `processStartId` on both sides), but deleting it
  outright used to risk un-registering a genuinely live orchestrator whose
  own start-time read happened to fail, at the mercy of an unrelated
  sibling process's sweep. It still gets cleaned up the ordinary way, once
  its pid dies or it ages out. The sweep never removes the entry the
  writing process itself just wrote.
- `/kankaku doctor` reports registry health: how many entries it currently
  trusts, how many it would discard, and why (dead / stale-reuse /
  over-age).

### Ancestor-chain detection

Reading "a live tracked ancestor process" above requires one OS-level
ancestor-chain snapshot. On Linux this is a set of `/proc/<pid>/stat` reads
(ppid and start-time ticks together, plus one `/proc/uptime` read); on
macOS, one `ps -eo pid,ppid,etime` snapshot (ppid and
elapsed-time-since-start together); a shell-wrapper hop with no registry
entry of its own is walked past, not stopped at.

**Startup cost.** This snapshot is taken at most once per process, at
extension startup, never on a later hot path — and, since it is the only
part of startup that ever spawns anything, it is skipped entirely unless
there is something for it to find: the machine-wide registry is read
*first*, and the snapshot is only taken when at least one other entry
exists that could possibly be this process's ancestor. The common case (no
other kankaku process running on the machine at all) therefore never
spawns `ps` or reads `/proc` — this process's own identity
(`processStartId`) is unaffected, since it comes from `process.uptime()`
instead (see "Identity, not just pid" above).

**On a platform or environment where this mechanism cannot run at all** —
Windows (no supported mechanism in this version), or any platform where a
fresh attempt still fails (`ps`/`/proc` missing, timing out, or producing
unreadable output) — ancestor-chain detection degrades gracefully to "no
ancestor found" (never a spawn attempt beyond the one failed try, never a
crash). Critically, this does **not** mean every unmarked process there is
classified `uncertain`: with no way to check, kankaku falls back to the
same marker-only detection it used before this feature existed
(`GENTLE_PI_AGENTS_CHILD=1`/`KANKAKU_ROLE=subagent` → subagent, anything
else → confirmed orchestrator) — the deliberately chosen default, because
marking *every* genuine top-level session `uncertain` on such a platform
would drop all of that user's work, which is far worse than the narrow
overcount risk this guards against elsewhere. The trade-off is visible, not
silent: `/kankaku doctor` reports ancestor-chain detection as unavailable
whenever this happens (distinguishing it from "checked, no tracked
ancestor found" — a separate, always-accurate report never folded into
`roleConfidence`) and names `KANKAKU_ROLE` as the remedy for a genuine
subagent system that needs marking explicitly on such a platform — see
"Interactive sessions and `KANKAKU_ROLE`" below.

### The `/kankaku doctor` diagnostic

`/kankaku doctor` reports, with no network call:

- How many records are orphaned subagents, and why.
- How many are `uncertain`, and why.
- Whether ancestor-chain detection is actually usable right now (see
  above) — and, when it is not, a reminder that an unmarked subagent
  system on this platform/environment may be counted twice, with
  `KANKAKU_ROLE` named as the fix.
- `KANKAKU_ROLE`, when it decided this process's role, as the deciding
  signal — or, when it did not (a confirmed child marker took precedence,
  or an interactive session's `subagent` override was ignored — see
  "Interactive sessions and `KANKAKU_ROLE`" below), the contradiction and
  the resolved outcome instead.
- Whether this process is a subagent that could not write to its
  orchestrator's directory and fell back to its own local one (see
  "Cross-worktree write routing" above) — a hint to go reunite that record
  manually, since `worklog.jsonl` can never be rewritten after the fact.
- Registry health (see "Registry cleanup and health" above).
- The current session's non-default session directory, when set.

The plain `/kankaku` summary also appends a one-line hint (`N uncertain
record(s) excluded from tasks — run /kankaku doctor`) whenever any exist,
so an undercount is never silent.

### Interactive sessions and `KANKAKU_ROLE`

Every subagent mechanism kankaku recognises today launches its child
**non-interactively**, over pipes (gentle-pi's `--mode rpc`, pi's own
bundled `subagent` example's `--mode json -p`, `pi-subagents`) — a human
never sits in front of one. A process running as an **interactive TUI
session** (`ctx.mode === "tui"`, pi's own signal for "a real terminal, a
human is here") is therefore always treated as a genuine top-level session
and is **never** classified `uncertain`, even when some ancestor in its
process chain happens to be a tracked pi process (for example, pi launched
from inside another pi's `bash` tool). Interactivity can only be known once
pi's own `ExtensionContext` is available, at `session_start` — later than
this process's binary `role` (orchestrator vs. subagent) is decided, but
`roleConfidence` is deferred and finalised exactly once, then, and stays
stable for the rest of the process's life.

**`KANKAKU_ROLE=orchestrator` or `KANKAKU_ROLE=subagent`** is an explicit
escape hatch — validated; any other value is ignored, falling back to
normal detection. Use it to force a session kankaku still gets wrong: mark
a genuine subagent system it does not recognise as `subagent` (this is
also the remedy `/kankaku doctor` names when ancestor-chain detection is
unavailable on the current platform), or force a session `orchestrator`
regardless of what its ancestry looks like. It has no effect on a record
already written — see "The role/state model" above.

**Scope it to one invocation. Never export it in a shell rc, tmux config,
or CI environment file.** `process.env` is inherited by every OS child by
default: an exported `KANKAKU_ROLE` reaches every `pi` invocation that
shell/session ever starts, subagents included. Set it only on the one
command it is meant for:

```
KANKAKU_ROLE=orchestrator pi ...
```

**Precedence (rewritten for a real bug — a BLOCKER fix).** `KANKAKU_ROLE`
no longer overrides every other signal unconditionally:

1. A **confirmed child marker** (`GENTLE_PI_AGENTS_CHILD=1`, set only by
   the subagent runner itself, never something a shell rc/tmux/CI
   environment would export) **always wins**, even over an explicit
   `KANKAKU_ROLE=orchestrator`. Without this, a `KANKAKU_ROLE=orchestrator`
   export that leaked into a shell rc — the natural thing to do after
   hitting a false `uncertain` once — would turn every one of that shell's
   later subagent invocations into a confirmed, independently-billed
   orchestrator: systematic multi-counting, invisible until someone
   compares the hub totals against what actually happened.
2. `KANKAKU_ROLE=subagent`, with no confirmed marker, is **ignored for an
   interactive session** (`ctx.mode === "tui"`). No subagent mechanism
   kankaku recognises ever launches its child interactively, so this is
   almost always the *mirror* leak — a globally exported
   `KANKAKU_ROLE=subagent` reaching a genuine top-level terminal session —
   and honouring it would silently drop that session's own work from every
   report and the hub (an orphaned subagent record that never anchors a
   task), with no way to recover it later, since `worklog.jsonl` is
   append-only. Between kankaku's two guiding rules — "undercount is
   recoverable, overcount is not" (which governs the *opposite* risk,
   inventing extra billing, and does not apply to this contradiction) and
   "never silently drop genuine work" — this one is governed by the
   second: the override is ignored, the session is classified
   `orchestrator` (what it structurally must be), and the contradiction is
   surfaced once via `ctx.ui.notify` (a warning) at `session_start` and in
   `/kankaku doctor` — never resolved silently. `KANKAKU_ROLE=orchestrator`
   has no such exception: forcing a session `orchestrator` can never drop
   work, only (rarely) invent a task that should not exist, a risk the
   user accepted by setting it explicitly.
3. Otherwise `KANKAKU_ROLE`, when set to a recognised value, decides — as
   before.

`/kankaku doctor` reports `KANKAKU_ROLE` as the deciding signal only when
it actually decided anything: it flags "override present AND child marker
present" with the resolved outcome (`subagent`, per rule 1) when both are
set, and reports the resolved `orchestrator` outcome (per rule 2) when a
`subagent` override was ignored for an interactive session — in neither
case does it claim the override was the deciding signal.

**Non-propagation.** `KANKAKU_ROLE` decides only the process that reads
it. kankaku strips it from its own `process.env` right after reading it
(before spawning anything), so a child it spawns — a subagent runner, a
tool shell — never inherits it, even when this process's own copy came
from something outside kankaku's control (a shell rc, tmux, CI). This is
a second, independent layer on top of rule 1 above: rule 1 already
neutralises a leaked `KANKAKU_ROLE=orchestrator` for any *recognised*
subagent mechanism (its confirmed marker always wins regardless), but
stripping means the leak can never reach an *unrecognised* one, or any
other child process, either.

### Limitations, honestly

- **In-process subagents are not handled yet.** A subagent mechanism that
  runs entirely inside the same OS process (no separate `pid`) is invisible
  to the registry/ancestry mechanism above; it is a planned, separate
  follow-up.
- **Only gentle-pi's `subagent_run` is recognised as a subagent-opening
  tool call today.** Other ecosystem packages are not yet specifically
  profiled — an unmarked child from one of them is `uncertain`, safely, but
  not automatically joined the way a gentle-pi child is.
- **Windows has no ancestor-chain detection** (an ancestor can never be
  identity-verified there), though this process's own `processStartId` is
  always available regardless of platform — see "Identity, not just pid"
  above. Mark a genuine subagent system explicitly with `KANKAKU_ROLE` on
  such a platform; see "Interactive sessions and `KANKAKU_ROLE`" above.
- **gentle-pi's child cannot currently read its own task id** — the
  cross-worktree join above relies on ancestry plus the registry, not on an
  explicit shared id, because upstream gentle-pi does not hand the child
  process its task id today. If that changes upstream, a future kankaku
  version can upgrade this join to a higher-confidence explicit-id match.
- **Ancestor-chain detection only sees the chain as it exists when a
  process looks.** A detached child reparented to init/launchd before that
  point cannot recover its original ancestry this way — the same limitation
  the existing `pid`/`parentPid` capture already has (see AGENTS.md).
- **A record already written `uncertain` (or already routed to a fallback
  local directory) cannot be rewritten.** `worklog.jsonl` is append-only;
  fixing the underlying cause (upgrading kankaku, setting `KANKAKU_ROLE`,
  restoring access to an orchestrator's directory) only helps a *later*
  run's records, never edits a line already on disk. There is no migration
  planned for this — it follows directly from "never rewrite the log" (see
  AGENTS.md).

## The `/kankaku` command

Run `/kankaku` inside pi to see today's totals (work, waiting, record count)
per role, plus a union-based tasks segment. In the interactive TUI the report
is appended to the chat transcript as a durable card that is never sent to
the LLM; without a UI (print or RPC mode) it falls back to a notification.
Arguments are whitespace-separated and order-insensitive:

- `/kankaku` — today's role totals and tasks segment, each with its estimated cost.
- `/kankaku all` — same, but across every record.
- `/kankaku tasks` — one line per task (time, union wall/work, cost,
  subagent count, truncated prompt) for the **current pi session**. Add `all` for
  every session. If the current session has no `sessionId`, tasks from every
  session are shown instead.
- `/kankaku sessions` — one line per session (id, time range, union
  wall/work, cost, task count) for today. Add `all` for every day.
- `/kankaku client <name>` — set the billing client for the current pi
  session. `/kankaku client` alone shows the effective client and which
  source it came from; `/kankaku client --clear` removes the session-level
  override. See "Billing labels" below. When a hub is configured, `<name>`
  must match a catalog client's code or name (case-insensitive) instead of
  being free text — see "Hub (PocketBase)".
- `/kankaku clients` — one line per client (work/waiting/wall time, cost,
  task count) for today. Add `all` for every day. Tasks with no resolved
  client are grouped under `(none)`.
- `/kankaku doctor` — orphan/uncertain subagent record counts and why,
  plus ancestor-detection platform availability. No network call. See
  "Subagents".

The following are available only when a hub is configured (see "Hub
(PocketBase)" below):

- `/kankaku target` — show the effective client/project and which source
  produced it. `/kankaku target pick` runs the picker again (works
  mid-session; the new target applies to records settled afterwards).
  `/kankaku target clear` clears the session-level target.
- `/kankaku catalog refresh` — force a catalog refresh and report the
  client/project counts.
- `/kankaku projects` — one line per project (work/waiting/wall time, cost,
  task count) for today. Add `all` for every day. Tasks with no resolved
  project are grouped under `(no project)`.

Cost figures are the sum of `usage.cost` as priced by pi's model table
(per-million-token rates in `models.json`, adjustable with `modelOverrides`).
For subscription-based providers this is an estimate at API list prices, not
an invoice.

While an agent is running, pi's status bar shows a `🕒 mm:ss · <client>` indicator (the client part appears only when one resolves); while idle it shows `💼 <client>`, or nothing when no client resolves. The entry is keyed `zz-kankaku` so it sorts last among extension statuses. The running indicator carries
the elapsed time for the current run.

## Billing labels

Every `WorkRecord` can carry a `client` — who the work is billed to — so
reports and exports can be grouped by client. The effective client is
resolved from three sources, in decreasing precedence:

1. **Session** — set with `/kankaku client <name>` (see above), persisted as
   a `kankaku-client` custom session entry and restored on session reload.
2. **`KANKAKU_CLIENT`** — the environment variable, a per-process default.
3. **Project** — `client` in `<KANKAKU_DIR>/config.json` (e.g.
   `{"client": "acme"}`), the project's own default.

A client name must match `/^[A-Za-z0-9._-]{1,64}$/`; anything else (empty,
too long, containing spaces or other characters) is ignored and resolution
falls through to the next source.

A `subagent_run` child process does not resolve its own client — a
subagent's own `WorkRecord` never carries `client`. Instead, the **task**
view (see "Task and session views") exposes the client from its
orchestrator record only, so `/kankaku tasks`, `/kankaku clients`, and the
export all see subagent work grouped under the task's (i.e. the
orchestrator's) client.

`sessionName` is also attached to every record from `pi.getSessionName()`,
so reports can show which named session produced a task.

## Hub (PocketBase)

kankaku can optionally resolve the billing client (and a project) **from a
PocketBase instance** instead of free text, so `cajamar`/`Cajamar`/`cjamar`
can no longer become three different clients. This is phase 1 of the hub
integration (catalog + selection only): nothing is uploaded anywhere.

### Configuration

Set `KANKAKU_PB_URL`, `KANKAKU_PB_EMAIL`, `KANKAKU_PB_PASSWORD`, or write
`~/.kankaku/credentials.json`:

```json
{ "url": "https://pb.example.com", "email": "bot@example.com", "password": "secret" }
```

Environment variables take precedence over the file, field by field. The
hub URL must be HTTPS unless it points at `localhost`/`127.0.0.1`/`::1`; a
plain-HTTP URL for any other host is refused (surfaced once via a
notification). The project's own `<KANKAKU_DIR>/config.json` is never read
for credentials — it is project-local and frequently committed.

`KANKAKU_MACHINE` optionally names this machine (for a multi-machine setup
later); it defaults to the OS hostname and is attached to every record as
`machine` once the hub is configured.

**When no hub is configured, kankaku behaves exactly as it does today** —
this whole feature is additive and every existing behaviour, record shape,
and report stays unchanged.

### Selection

On `session_start`, for the orchestrator role with a UI available:

1. **Session** — restored from the last `kankaku-target` session entry
   (including a remembered "skipped" choice, so a reload does not ask
   again).
2. **Project config** — `clientId`/`projectId` in `<KANKAKU_DIR>/config.json`.
3. **`repo_paths`** — the current working directory matched against each
   project's `repo_paths` (exact match, or a subdirectory of one; the
   longest match wins).
4. Otherwise, a picker: `ctx.ui.select` for the client (active clients,
   sorted by name, plus "— skip —"), then for the project (active projects
   of that client, plus "(no project)" and "— skip —"). Declining at either
   step — "— skip —" or dismissing the dialog — cancels the whole pick and
   is remembered for the session.

After a pick, kankaku asks whether to remember it for this repository; a
"yes" merges `clientId`/`projectId` into `<KANKAKU_DIR>/config.json`.

An id from any source that no longer resolves to an active, non-"unassigned"
catalog entry is treated as absent for that source and resolution falls
through to the next one, exactly like the legacy client precedence.

Once a hub target is active for a run, the legacy `client` label is set to
the target's client `code` (so every existing report/export keeps grouping
correctly), and the record additionally carries `clientId`, `clientName`,
and — when a project is selected — `projectId`/`projectName`. A subagent
never resolves its own target, exactly like the legacy `client` label — the
task view exposes it from the orchestrator record only.

The status bar shows `💼 <client> · <project>` (or just `💼 <client>` without
a project) in place of the legacy client label, both idle and during a run.

### Caching and offline behaviour

The catalog (clients/projects) is cached machine-wide at
`~/.kankaku/catalog.json` with a 6-hour TTL. On startup: a fresh cache is
used as-is; a stale cache is used immediately while a refresh happens in
the background; when there is no cache at all, one refresh is awaited
(bounded by the hub client's own request timeout, 3s by default) before
falling back. If the hub is unreachable and there is no cache, kankaku
notifies once (`kankaku: hub unreachable, using local labels`) and
continues exactly as it would without a hub configured. `/kankaku catalog
refresh` forces a refresh on demand.

### Privacy (catalog)

The catalog itself (clients/projects) is read-only — nothing about *that*
data is ever written back. Whether your own work records ever leave the
machine is a separate, opt-in decision: see "Sync" below.

### Sync

Once a hub is configured, kankaku can push consolidated **task** rows (see
"Task and session views" above) to PocketBase, so a project/task manager
can report AI time and cost per project. This is an outbox pattern:
`worklog.jsonl` stays the local source of truth, append-only and never
rewritten, exactly as without a hub. A separate sync step reads it and
uploads what is pending — nothing in a pi event handler ever waits on the
network.

**What gets uploaded.** One `task_entries` row per task — never raw
`WorkRecord`s re-aggregated on the server. The union-of-intervals rule
(`wallMs`, "Task and session views") is computed exactly once, locally, by
`buildTasks`; the hub only ever sums already-consolidated rows. When
`KANKAKU_SYNC_RECORDS` is not `0` (the default), each task's underlying
`WorkRecord`s are also uploaded as `work_records`, raw per-run detail for
drilling into a task — these rows overlap each other and must never be
summed, unlike `task_entries`.

**Idempotency and the revisit window.** Every task is upserted by its id
(the orchestrator record's `id`), never blindly created — safe to
re-send. A task is not final the moment its orchestrator settles: a
background subagent can settle *after* it and extend the task's union
(`wallMs`, cost, subagent count) for a task that may already be in
PocketBase. So every sync revisits a trailing window behind its own
watermark — `KANKAKU_SYNC_WINDOW_HOURS`, 24h by default — and re-evaluates
every task whose `endedAt` falls inside it. A cheap content hash per task
(`<KANKAKU_DIR>/sync-state.json`) means an unchanged task inside the window
costs nothing: running `/kankaku sync` twice in a row performs zero writes.

The window is anchored to `syncedThrough` (the watermark), never to
current wall-clock time — see "Limitations" below for what that means for
a background subagent that settles long after its orchestrator, and after
the directory has otherwise gone quiet.

**Assignment is create-only.** You (or whoever reassigns work in the hub's
web app) can move a task from one client/project to another directly in
PocketBase — for example, moving a "Sin determinar" row to its real
client once you have identified it. A later re-sync of that same task
**must never undo that**: on create kankaku sends the full row, including
`client`/`project`/`legacy_client_label`; on every subsequent update it
sends measurement fields only (`wall_ms`, `cost`, `status`, ...) and never
touches assignment fields again. If you need kankaku itself to change a
task's assignment, do it in the web app, not by re-syncing.

**Historical ("Sin determinar") records.** A record with no `clientId`, or
whose `clientId` no longer resolves in the catalog, is routed to the hub's
"Sin determinar" (unassigned) client, carrying its old free-text `client`
label (or `clientName`) forward as `legacy_client_label` — the exact
mechanism that lets you bulk-reassign "everything that said `cjamar`" once,
in the web app, from the unassigned queue.

**Agent and measurement quality.** Every `task_entries` row also carries
who produced it and how well each figure was measured, so the hub can
label what it has instead of silently blending incompatible numbers from
different agents: `agent` (`"pi"`), `agent_version` (pi's own version,
when it could be determined — never guessed, omitted otherwise), `plugin`
(`"kankaku"`), `plugin_version` (this package's own version),
`waiting_quality` (always `"measured"` for kankaku/pi — it always
instruments waiting time), `cost_quality` (`"measured"` when the task's
own record or any joined subagent observed a real provider cost figure on
at least one turn; `"unknown"` when none did, e.g. a subscription/OAuth
provider that reports no cost — kankaku has no token-price estimator, so
it never sends `"estimated"`), and `subagent_linkage` (`"not_applicable"`
when the task opened no subagent spans; `"linked"` when at least as many
child records were joined as spans were opened; `"unlinked"` otherwise —
a task-level approximation, since there is no per-span correlation id
today, see "Subagents" > "Limitations"). These are measurement fields, not
assignment: sent on every create *and* update, and included in the sync
content hash, so a background subagent that joins later — improving
`cost_quality`/`subagent_linkage` without changing any other number —
still triggers a resync. An older hub predating these fields simply
ignores them (PocketBase silently drops unrecognized fields on write); no
capability probing is needed.

**Session directory.** `session_dir` carries a task's non-default session
directory (`TaskView.sessionDir`, see "Record schema") to the hub, so a
resumable session can be resumed from the web, not just locally via
`/kankaku doctor`. It is optional — only present when pi reports a
non-default session directory — and, like the fields above, a measurement
field: sent on both create and update, and included in the sync content
hash so a session dir change alone triggers a resync. Like `repo_project`,
it is an absolute local filesystem path (username, disk layout) — the same
category of exposure the hub already accepts for `repo_project`, not a new
one. An older hub predating this field simply ignores it (PocketBase
silently drops unrecognized fields on write).

**Privacy.** `KANKAKU_SYNC_PROMPT` controls whether a task's prompt text
leaves the machine at all: `none` (default — omitted entirely), `truncated`
(first 120 chars plus `…`), or `full`.

**Commands:**

- `/kankaku sync` — push everything pending (new tasks, plus anything
  inside the revisit window that changed).
- `/kankaku sync all` — a full re-evaluation: every task, not just the
  window. Safe and cheap to run — the content hash still skips anything
  unchanged.
- `/kankaku sync status` — the current watermark, a locally-computed
  pending count (no network), how many tasks changed but fall outside the
  current revisit window (needs `sync all` — see "Limitations" below), and
  the last sync error, if any.
- `/kankaku backfill` — a full sync, reported grouped by
  `legacy_client_label`: how many tasks went to "Sin determinar" and under
  which old label, so you know what to reassign in the web app's
  unassigned queue. This never rewrites `worklog.jsonl` locally — the
  reassignment happens once, in PocketBase, and survives every future sync
  (see "Assignment is create-only" above).

**Automatic sync.** Unless `KANKAKU_SYNC_AUTO=0`, kankaku also syncs
fire-and-forget (never awaited, errors never surface as a failure of the
run that triggered them) on `session_start` (orchestrator only, after
crash recovery) and again after `agent_settled`. Both triggers share one
single-flight guard, so they never race each other within a process, and a
lock file (`<KANKAKU_DIR>/sync.lock`, an atomic exclusive-create so two
racing processes can never both acquire it, stale after 5 minutes) keeps
two pi processes from syncing the same directory concurrently. Subagents
never sync. The automatic path never notifies on success; on failure it
notifies at most once per session (`kankaku: sync failed: ...`) — check
`/kankaku sync status` for the details, including on a later run.

The automatic path is cheap on every prompt, not just fire-and-forget: it
skips entirely (no read of `worklog.jsonl`, no network) when the log has
not changed since the last successful sync, and otherwise runs at most
once per `KANKAKU_SYNC_MIN_INTERVAL_MINUTES` (default 5; `0` disables the
throttle) — since right after `agent_settled` the log *has* just changed
(a record was just appended), the throttle is what actually keeps that
trigger cheap. `session_start` gets one exception: it bypasses the
throttle when the previous automatic attempt errored or never happened, so
a stuck hub does not stay silently unsynced across restarts. None of this
ever applies to a manual `/kankaku sync`, `sync all`, or `backfill`.

**Network/validation failures.** A network or server (5xx) error stops a
sync run where it is and does not advance its watermark past the failing
task — nothing is lost, and the next sync (manual or automatic) picks up
exactly there. A task that fails **validation** (e.g. a genuinely malformed
payload) is recorded with its reason and skipped — not retried on every
single run — but is retried automatically the moment its content changes.

**Limitations:**

- Sync state (`sync-state.json`) is per repository/machine, not
  centralized; there is no standalone CLI entry point yet (`npx kankaku
  sync` outside of pi) — see "Roadmap".
- **A late background child, and the revisit window (R3).** A background
  subagent can settle well after its (possibly cross-worktree)
  orchestrator process has already exited — its record still writes
  correctly into the orchestrator's `worklog.jsonl` (see "Subagents" >
  "Cross-worktree write routing"), but nothing *syncs* it until that
  directory is next visited: pi opened there again (`session_start`'s
  auto-sync), or `/kankaku sync`/`sync all` run there manually. Subagents
  themselves never sync (see "Automatic sync" above). Whether an ordinary
  incremental sync, whenever it next runs, actually picks the late child
  up depends on the watermark, not on how much wall-clock time has passed:
  the child's own record bumps the task's `endedAt` forward (the task view
  recomputes it as the max of the orchestrator's and every joined child's
  settle time), which keeps the task inside the revisit window
  (`syncedThrough - windowHours`) for as long as `syncedThrough` itself has
  not advanced past it — even if that next sync happens days later, as
  long as nothing else in that same directory synced in between. If,
  meanwhile, *other* tasks in the same directory kept syncing and pushed
  `syncedThrough` far enough ahead, the late join falls outside the window
  and an ordinary sync silently skips it. `/kankaku sync status` makes
  this visible rather than silent — it reports how many tasks changed but
  currently fall outside the window — and the remedy is always the same:
  run `/kankaku sync all` (or `backfill`), which evaluates every task
  regardless of the window.

## Tagged segments

While a run is open, kankaku can also time tool executions that match a
configured rule and tag the resulting span with a name — for example,
knowing how much of a task went to gentle-ai's review-with-receipts step,
which runs as `gentle-ai review ...` commands through the `bash` tool inside
the prompt's run.

The default rule tags `review`: tool `bash` running a command matching
`/\bgentle-ai review\b/`. Configure rules with `KANKAKU_SEGMENTS`, a
`;`-separated list of `tag=tool:regex` entries, e.g.:

```
KANKAKU_SEGMENTS="review=bash:gentle-ai review;commit=bash:git commit"
```

Setting `KANKAKU_SEGMENTS` replaces the default rule entirely; malformed
entries (missing tag, tool or regex, or an invalid regex) are skipped.
When several rules could match the same tool call, only the first one
applies. A `WorkRecord`'s `segments` field is the **union** of milliseconds
per tag within that one record, so overlapping matching calls are not
double-counted. `TaskView.segments` and `SessionView.segments` are instead
the **sum** of `segments` across the orchestrator and its children (or
across a session's tasks): segment spans are not persisted to
`worklog.jsonl`, so once a record settles there is nothing left to union
across records, only per-record totals to add up.

Note that the reviewer's own token cost is not observable here: gentle-pi
runs it with `--no-extensions`, so kankaku never sees the reviewer's own
prompt/tool events, only the `bash` call the orchestrator makes to invoke
it.

## Crash recovery

While a run is open, each pi process writes a checkpoint of its current
record to `<KANKAKU_DIR>/inflight/<pid>.json` — first as soon as the run
starts (`before_agent_start`), so even a crash on the very first turn still
leaves a checkpoint, and then again after every `turn_end` and
`tool_execution_end` — and removes it on a normal
`agent_settled`/`session_shutdown`. If the process is killed outright
(`kill -9`, power loss) before it can settle, the checkpoint file survives
it. On the next pi start, `session_start` scans `inflight/` for checkpoints
whose owning pid is no longer alive, appends each one to `worklog.jsonl` as
`interrupted`, deletes the checkpoint file, and shows a
`kankaku: recovered N interrupted record(s)` notice. `settledAt` on a
recovered record is the time of its last checkpoint, not the actual crash
time, so `wallMs`/`workMs` are a **lower bound** on the real duration.

The same scan also sweeps `inflight/` for orphaned `.tmp` files: `save`
writes to a temp file before renaming it into place, and a process killed
between those two steps leaves the temp file behind. A stray `.tmp` file is
deleted once its writer pid is no longer alive (or its name cannot be
parsed); one still owned by a live writer — including this very process's
own in-progress write — is left alone.

## Export

`/kankaku export [csv|json] [all]` writes one flat row per task (today's
tasks by default, or every task with `all`) to
`<KANKAKU_DIR>/export/tasks-<YYYY-MM-DD or all>.<csv|json>`, and confirms
with the file's path and row count via the durable report card. Format
defaults to `csv`; each subagent's own time is folded into its task's row
rather than exported separately (see "Task and session views").

Columns (in this order for CSV; the same fields for JSON):

| Column | Meaning |
| --- | --- |
| `id` | Task id (the orchestrator record's `id`). |
| `day` | Local calendar day (`YYYY-MM-DD`) the task started on. |
| `startedAt` / `endedAt` | ISO timestamps of the task's span. |
| `client` | Billing client, or empty when unresolved. |
| `sessionName` | pi session display name, or empty. |
| `sessionId` | pi session id, or empty. |
| `project` | Project cwd. |
| `status` | `completed`, `aborted`, or `interrupted`. |
| `prompt` | First 200 chars of the prompt, newlines collapsed to spaces. |
| `wallMs` / `waitingMs` / `workMs` | Union-based task timings (see "Task and session views"). |
| `cost` | Estimated USD cost, orchestrator plus subagents. |
| `tokensIn` / `tokensOut` / `cacheRead` | Token usage totals. |
| `subagentCount` | Number of subagent records matched to the task. |
| `segments` | JSON-encoded per-tag segment totals (see "Tagged segments"). |
| `model` | The orchestrator record's model, or empty. |

## Environment variables

- `KANKAKU_DIR`: directory for the work log (`worklog.jsonl`) and the
  crash-recovery checkpoints (`inflight/`, see above), relative to the
  project cwd unless given as an absolute path. Defaults to `.kankaku`.
- `KANKAKU_INTERACTIVE_TOOLS`: comma-separated list of tool names whose
  execution span counts as waiting time. Defaults to
  `ask_user_question,ask_user_choice`.
- `KANKAKU_SEGMENTS`: `;`-separated `tag=tool:regex` rules for tagged
  segments (see above). Defaults to the single `review` rule.
- `KANKAKU_ROLE`: `orchestrator` or `subagent` — an explicit escape hatch
  for this process. Any other value is ignored. Scope it to one
  invocation (`KANKAKU_ROLE=orchestrator pi ...`) — **never export it in
  a shell rc, tmux config, or CI environment file**: a confirmed child
  marker always wins over `KANKAKU_ROLE=orchestrator`, `KANKAKU_ROLE=
  subagent` is ignored for an interactive session, and kankaku strips it
  from the environment it passes to any child it spawns, but none of that
  helps if it reaches a session it was never meant for in the first
  place. See "Subagents" > "Interactive sessions and `KANKAKU_ROLE`" for
  the full precedence.
- `KANKAKU_CLIENT`: default billing client for this project (see "Billing
  labels" above). Lower precedence than the session-level
  `/kankaku client` override, higher than `<KANKAKU_DIR>/config.json`.
- `KANKAKU_PB_URL`, `KANKAKU_PB_EMAIL`, `KANKAKU_PB_PASSWORD`: hub
  (PocketBase) credentials (see "Hub (PocketBase)" above). Take precedence,
  field by field, over `~/.kankaku/credentials.json`.
- `KANKAKU_MACHINE`: this machine's display name for the hub, attached to
  every record as `machine` once the hub is configured. Defaults to the OS
  hostname.
- `KANKAKU_SYNC_PROMPT`: prompt privacy for sync — `none` (default, omitted
  entirely), `truncated` (first 120 chars + `…`), or `full`. See "Hub
  (PocketBase)" > "Sync" > "Privacy".
- `KANKAKU_SYNC_WINDOW_HOURS`: how far behind the sync watermark to revisit
  on every run, so a subagent that settles after its orchestrator still
  reaches its task. Defaults to 24; a non-positive or non-numeric value
  falls back to the default.
- `KANKAKU_SYNC_RECORDS`: `0` disables uploading `work_records` (raw
  per-`WorkRecord` detail); `task_entries` are always uploaded regardless.
  Defaults to enabled.
- `KANKAKU_SYNC_AUTO`: `0` disables the automatic `session_start`/
  `agent_settled` sync; `/kankaku sync` still works. Defaults to enabled.
- `KANKAKU_SYNC_MIN_INTERVAL_MINUTES`: how often the automatic
  `session_start`/`agent_settled` sync is allowed to actually run, at
  most — see "Automatic sync" above. Defaults to 5; `0` disables the
  throttle. Never applies to a manual `/kankaku sync`, `sync all`, or
  `backfill`.

## Limitations

- A prompt shown by a tool that does not go through `ctx.ui` and is not
  listed in `KANKAKU_INTERACTIVE_TOOLS` counts as work, not waiting time.
- Subagent totals are reported separately in the per-role summary and are
  **not** summed into the orchestrator's `wallMs` there: task-mode subagents
  run inside the parent's wall clock, and background subagents can outlive
  the parent's idle moment, so naively adding them would double-count or
  misrepresent billable time. Use the task/session views above (union-based,
  never a sum) for a correct combined figure.

## Roadmap

- Hub sync (phase 2): push consolidated task rows to PocketBase (outbox
  pattern, idempotent upsert by task id) so a task/project manager can
  report AI time and cost per project. The catalog/selection layer in "Hub
  (PocketBase)" above is phase 1; sync itself ("Hub (PocketBase)" > "Sync")
  is phase 2 — both already shipped.
- A standalone CLI entry point (`npx kankaku sync`, for a cron/launchd job
  outside of any pi session) is deliberately not included yet: Node refuses
  type stripping for a `.ts` file under `node_modules`, so a bin script
  needs a build step this package does not have yet. `sync-runner.ts` and
  its adapters are already decoupled from pi so that build step is the only
  missing piece.
- Linking a `task_entries` row to an existing `tasks` record (phase 3 in the
  hub's own data model) — kankaku never invents tasks; it would only ever
  link to one created in the manager.
- Generic subagent detection (phase 6): this version (6a) fixes the two
  correctness bugs described in "Subagents" above (a phantom-orchestrator
  double count; a gentle-pi cross-worktree child's work going missing). A
  `SubagentProfile` abstraction recognising other ecosystem packages
  (`KANKAKU_SUBAGENT_TOOLS`/`KANKAKU_SUBAGENT_CHILD_ENV`) and in-process
  subagent usage attribution are planned follow-ups, not built yet.
