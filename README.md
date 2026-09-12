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

Cost figures are the sum of `usage.cost` as priced by pi's model table
(per-million-token rates in `models.json`, adjustable with `modelOverrides`).
For subscription-based providers this is an estimate at API list prices, not
an invoice.

While an agent is running, pi's status bar shows a `⏱ mm:ss` indicator with
the elapsed time for the current run.

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

## Environment variables

- `KANKAKU_DIR`: directory for the work log, relative to the project cwd
  unless given as an absolute path. Defaults to `.kankaku`.
- `KANKAKU_INTERACTIVE_TOOLS`: comma-separated list of tool names whose
  execution span counts as waiting time. Defaults to
  `ask_user_question,ask_user_choice`.
- `KANKAKU_SEGMENTS`: `;`-separated `tag=tool:regex` rules for tagged
  segments (see above). Defaults to the single `review` rule.

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

- Remote sync service: the `id` and `schema` fields are already in place for
  a future `synced` cursor that uploads records to a remote store.
