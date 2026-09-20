# kankaku — agent guidelines

kankaku is a [pi](https://pi.dev) extension package that records how long
agents work on each user prompt. It writes append-only JSONL records to
`.kankaku/worklog.jsonl` and derives task and session views from them.
Read `README.md` for behaviour and the record schema before changing code.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no `Date.now()`, no pi imports. Time comes
  from the injected `Clock` port. `WorkTracker` is the only stateful domain
  object and it must stay deterministic under test.
- `src/ports/` holds interfaces only (`Clock`, `WorkLog`, `Catalog`,
  `WorkSink`, `ProcessRegistry` — the machine-wide `~/.kankaku/run/`
  registry, see README "Subagents").
- `src/adapters/` talks to the outside world: pi events and UI
  (`pi-tracker.ts`, wiring `status-bar.ts` for the footer clock/client
  status, `session-client.ts` for the session billing-client override,
  `session-target.ts` and `target-picker.ts` for the hub client/project
  picker, and `kankaku-command.ts` for the `/kankaku` command), the
  filesystem (`jsonl-work-log.ts`, `lazy-jsonl-work-log.ts`,
  `project-config.ts`, `cached-catalog.ts`, `hub-credentials.ts`,
  `sync-state-store.ts`), the hub HTTP layer (`pocketbase-client.ts`,
  generic; `pocketbase-catalog.ts`, maps records to domain types;
  `pocketbase-sink.ts`, the `WorkSink` that uploads task rows), sync
  orchestration (`sync-runner.ts`, using the pure `domain/hub-entry.ts` and
  `domain/sync-plan.ts`), report formatting (`report.ts`), and subagent
  detection (`ancestry.ts`, OS ancestor-chain snapshot;
  `machine-process-registry.ts`, the `ProcessRegistry`;
  `registry-aware-work-log.ts`, the `WorkLog` decorator that reunites a
  cross-worktree child before `buildTasks` runs — see README "Subagents").
- `src/extension.ts` only wires config, tracker, log and adapter together.
  Do not put logic there.
- Dependencies point inwards: adapters import domain and ports; domain
  imports nothing outside `src/domain/` and `src/ports/`.

## Measurement rules (do not break)

- One record per pi process per prompt, from `before_agent_start` to
  `agent_settled`. Several agent runs (retry, follow-up) belong to the same
  record; `runs` counts them.
- `waitingMs` is the union of UI-prompt spans and interactive-tool spans.
  Waiting spans opened by a tool are closed only by that tool's `toolCallId`.
- `workMs = wallMs - waitingMs`. Never sum parallel spans; use interval
  unions (`src/domain/intervals.ts`).
- Subagent time is linked through `pid`/`parentPid` and reported separately.
  Task and session views compute wall time as the union of orchestrator and
  child intervals.
- Role classification is four-state, applied by `domain/task-view.ts`
  (`buildTasks`, `uncertainRecords`) on top of the still-binary persisted
  `role`: **orchestrator** (confirmed), **subagent-joined**,
  **subagent-unjoined** (orphan), and **uncertain** (no recognised
  child-env-marker, but a live tracked ancestor process was found via the
  machine-wide registry, `ports/process-registry.ts`). An **uncertain**
  record never defaults to `"orchestrator"`, is never counted as a new task
  locally, and is never synced to the hub as one (ADR 0022) — see README
  "Subagents". `WorkRecord.roleConfidence` (optional, only ever
  `"uncertain"`) carries this; adding it did not bump
  `WORK_RECORD_SCHEMA`.
- `project` is a **hint** for joining a subagent to its orchestrator in
  `matchChildren`, never a hard filter (ADR 0021): a same-project candidate
  is preferred, but a cross-project one is eligible when it reaches the
  matched array via `adapters/registry-aware-work-log.ts`'s
  registry-corroborated cross-worktree merge (ADR 0023). The interval-union
  aggregation rule (`unionMs`) still lives exactly once, in `buildTasks` —
  the registry/ancestry machinery only ever expands which records that one
  call can see, never re-implements the union itself.
- `.kankaku/worklog.jsonl` is user data. Append only, one `JSON.stringify`
  line per record, tolerate malformed lines when reading, never rewrite it.
- Bump `WORK_RECORD_SCHEMA` when a persisted field changes meaning or is
  removed. Adding optional fields does not require a bump.
- Tagged tool segments (`segments`) are the union of milliseconds per tag
  within one `WorkRecord`, and the sum of `segments` per tag across a
  task's or session's records — never a union at that level, since segment
  intervals are not persisted to `worklog.jsonl`.
- Each process checkpoints its in-flight record to `.kankaku/inflight/<pid>.json`
  (via `InflightStore`) so a hard crash still leaves an `interrupted` record,
  recovered on the next `session_start`; see README "Crash recovery".
- `client` (billing target) resolves session > `KANKAKU_CLIENT` env >
  project `config.json`, via the pure `domain/client-label.ts#resolveClient`;
  a subagent record never carries its own `client` — only the task view
  exposes it, inherited from the orchestrator record. See README "Billing labels".
- Hub identity (`clientId`/`projectId`) is an **id, not a name** — never
  free-text when the hub is configured. Resolution is session > project
  `config.json` > catalog `repo_paths` match for the cwd > none, via the
  pure `domain/work-target.ts#resolveWorkTarget`; an id that no longer
  resolves to an active, non-"unassigned" catalog entry falls through to
  the next source, exactly like `client`. A subagent never resolves its own
  target — only the task view exposes `clientId`/`clientName`/`projectId`/
  `projectName`, inherited from the orchestrator record. When a hub target
  is active, the legacy `client` label is set to the target's `code` (kept
  valid against `CLIENT_PATTERN`, or omitted rather than breaking the
  record) so every existing report/export keeps grouping correctly. See
  README "Hub (PocketBase)".
- Hub sync (phase 2, `domain/hub-entry.ts`, `domain/sync-plan.ts`,
  `adapters/sync-runner.ts`) uploads `buildTasks` output — the aggregation
  rule (D6 in `kankaku-pocketbase-proposal.md`) is never re-implemented
  against raw records on the server or in any sync adapter. Nothing in a pi
  event handler awaits the network: sync is a separate, later step
  (`/kankaku sync`, or fire-and-forget on `session_start`/`agent_settled`),
  and `worklog.jsonl` is still never rewritten by it — sync only reads.
  The automatic (`session_start`/`agent_settled`) path only, never a
  manual sync, is gated by two cheap checks before any `readAll()` or
  network call, in `runSync` (`adapters/sync-runner.ts`): it skips entirely
  when `WorkLog#version()` is unchanged since the last successful sync
  (persisted as `SyncState.logVersion`), and otherwise throttles to at most
  once per `KANKAKU_SYNC_MIN_INTERVAL_MINUTES` (default 5, `0` disables;
  persisted as `SyncState.lastRunAt` so it holds across processes) —
  `session_start` bypasses the throttle only when the last attempt errored
  or never happened.
- Task assignment (`client`/`project`/`task`/`legacy_client_label` on a
  `task_entries` row) is **create-only**: `domain/hub-entry.ts`'s
  `buildTaskEntryUpdatePayload` must never include those fields, so a
  re-sync can never undo a reassignment made directly in the hub's web app.
  Only `buildTaskEntryCreatePayload` sends them, exactly once, when the row
  does not exist yet. See README "Hub (PocketBase)" > "Sync" > "Assignment
  is create-only".

## Code conventions

- TypeScript run directly by Node 24 (type stripping): no enums, namespaces,
  or parameter properties; `import type` for types; relative imports include
  the `.ts` extension; `verbatimModuleSyntax` is on.
- Strict TDD: write the failing test in `tests/` first, then implement.
  Every module with behaviour has a matching `tests/<name>.test.ts`;
  type-only files and the thin `src/extension.ts` wiring are the exceptions.
- Tests use `node:test` and `node:assert/strict`, fake clocks and fake pi
  objects; no real timers, no real pi process, no network.
- Event handlers registered with `pi.on` must never throw. Wrap them with
  `guarded` and report failures through `ctx.ui.notify` only when
  `ctx.hasUI` is true.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are
  dev dependencies for types only; pi provides them at runtime. Do not add
  runtime dependencies without a reason written in the pull request.
- Code, comments, docs and commit messages are in English, neutral register.

## Verification before calling work done

```
npm run check   # tsc --noEmit + node --test tests/*.test.ts
```

For behaviour changes also run a headless smoke test and confirm a record
is written:

```
KANKAKU_DIR=/tmp/kankaku-smoke pi -p --no-session "Reply with exactly the word OK."
```

## Git

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not commit `.kankaku/`, `.codegraph/`, or `node_modules/`.
