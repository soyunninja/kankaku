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
  "status": "completed"
}
```

`status` is one of `completed`, `aborted` (the last assistant message had
`stopReason: "aborted"`), or `interrupted` (pi shut down while still
running).

`clientId`, `clientName`, `projectId`, `projectName` and `machine` are only
present once a hub is configured (see "Hub (PocketBase)"); every report and
export written before this feature, or by a user without a hub, is
unaffected.

## Task and session views

Each `WorkRecord` still measures one pi process's own prompt-to-idle span.
But a `subagent_run` in `background` mode returns immediately while its
child process keeps working, so the orchestrator's own `wallMs` can
under-report how long the task actually took. Two derived, read-only views
correct for that, built purely from `pid`/`parentPid`/`startedAt`/`settledAt`
already present on every record — no new fields are persisted to
`worklog.jsonl`.

- **Task**: one orchestrator record plus every subagent record matched to
  it — same `project`, `parentPid === orchestrator.pid`, and the child's
  `startedAt` falling inside the orchestrator's `[startedAt, settledAt]`
  window. (If a pid is reused across runs and several orchestrator records
  match, the child attaches to the latest-starting one.) A task's `wallMs`
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
  record (for example, its parent's record was lost, or it belongs to a
  different project) is excluded from every task but is not silently
  dropped — it stays visible so gaps in the log are noticeable rather than
  hidden.

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
  pending count (no network), and the last sync error, if any.
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
simple pid+timestamp lock file (`<KANKAKU_DIR>/sync.lock`, stale after 5
minutes) keeps two pi processes from syncing the same directory
concurrently. Subagents never sync. The automatic path never notifies on
success; on failure it notifies at most once per session
(`kankaku: sync failed: ...`) — check `/kankaku sync status` for the
details, including on a later run.

**Network/validation failures.** A network or server (5xx) error stops a
sync run where it is and does not advance its watermark past the failing
task — nothing is lost, and the next sync (manual or automatic) picks up
exactly there. A task that fails **validation** (e.g. a genuinely malformed
payload) is recorded with its reason and skipped — not retried on every
single run — but is retried automatically the moment its content changes.

**Limitations:** sync state (`sync-state.json`) is per repository/machine,
not centralized; there is no standalone CLI entry point yet (`npx kankaku
sync` outside of pi) — see "Roadmap".

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
