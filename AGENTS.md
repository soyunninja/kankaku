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
  `sync-state-store.ts`), version resolution (`agent-info.ts`, pi's and
  this package's own version, for the hub's "Agent and measurement
  quality" fields), the hub HTTP layer (`pocketbase-client.ts`,
  generic; `pocketbase-catalog.ts`, maps records to domain types;
  `pocketbase-sink.ts`, the `WorkSink` that uploads task rows), sync
  orchestration (`sync-runner.ts`, using the pure `domain/hub-entry.ts` and
  `domain/sync-plan.ts`), report formatting (`report.ts`), and subagent
  detection (`ancestry.ts`, OS ancestor-chain snapshot, including each
  pid's approximate OS start-time identity (`startIdByPid`) and the
  spawn-free `ownStartIdFromUptime` own-identity shortcut;
  `machine-process-registry.ts`, the `ProcessRegistry`; `subagent-startup.ts`,
  the one composition point `extension.ts` calls at factory time to read the
  registry, take an ancestry snapshot only when it could find something
  (F5), and resolve this process's tracked ancestor; `kankaku-dir.ts`'s
  `resolveWritableTarget`, which a verified subagent uses to route its
  `WorkLog`/`InflightStore` straight into its orchestrator's directory
  instead of its own (F1, ADR 0023's rewrite — there is no longer a
  `WorkLog` decorator that reunites a child at read time; write-side
  routing makes that redundant); `file-modes.ts`, the owner-only
  dir/file-mode helpers shared by every adapter writing under `~/.kankaku`;
  `domain/ancestry-match.ts` and `domain/registry-health.ts`, the pure
  identity-matching/sweep-classification logic — see README "Subagents").
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
  child-env-marker, a live tracked ancestor process was found via the
  machine-wide registry, `ports/process-registry.ts`, **and** this process
  is not itself an interactive TUI session — an interactive session is
  never demoted to `uncertain` regardless of its ancestry, since every
  subagent mechanism kankaku recognises launches its child
  non-interactively; see README "Subagents" > "Interactive sessions").
  `KANKAKU_ROLE=orchestrator|subagent` (`config.ts#readRoleOverride`) is an
  explicit escape hatch, but — since R1 — it never beats a *confirmed*
  signal and is never inherited: `GENTLE_PI_AGENTS_CHILD=1` (the automatic
  child marker) always wins over `KANKAKU_ROLE=orchestrator`, so a
  `KANKAKU_ROLE=orchestrator` leaked into the environment (a shell rc,
  tmux, CI) can never turn a genuine subagent into a confirmed,
  independently-billed orchestrator; and `KANKAKU_ROLE=subagent` with no
  confirmed marker is ignored for an interactive (`ctx.mode === "tui"`)
  process — no subagent mechanism kankaku recognises ever launches its
  child interactively, so this is almost always the mirror leak (a genuine
  top-level session about to be silently dropped), and is treated as
  `orchestrator` instead, flagged via `ctx.ui.notify` at `session_start`
  and in `/kankaku doctor` rather than resolved silently. `extension.ts`
  also strips `KANKAKU_ROLE` from its own `process.env` right after reading
  it (`config.ts#stripRoleOverride`), so no child this process spawns ever
  inherits it — see the full precedence table in `config.ts#detectRole`'s
  doc comment and README "Subagents" > "Interactive sessions and
  `KANKAKU_ROLE`". An **uncertain** record never defaults to
  `"orchestrator"`, is never counted as a new task locally, and is never
  synced to the hub as one (ADR 0022) — see README "Subagents".
  `WorkRecord.roleConfidence` (optional, only ever `"uncertain"`) carries
  this; adding it did not bump `WORK_RECORD_SCHEMA`. `role` itself is
  decided once, at factory time (`config.ts#detectRole`, env-only, plus a
  cheap synchronous TTY-based interactivity guess feeding only the
  `KANKAKU_ROLE=subagent`-in-an-interactive-session exception above — never
  ancestry, and never pi's own authoritative `ctx.mode`); `roleConfidence`
  is (separately) deferred and resolved exactly once, at `session_start`
  (`pi-tracker.ts`'s `resolveRoleConfidence`), since
  interactivity is only knowable once pi's own `ExtensionContext` exists —
  and then stays stable for the rest of the process's life.
- A registry match is by **identity, not just pid**: pids are reused by the
  OS, so `domain/ancestry-match.ts#findAncestorEntry` only trusts a
  candidate whose registry-recorded `RegistryEntry.processStartId` agrees
  (within `START_ID_TOLERANCE_MS`) with a fresh re-derivation of that pid's
  live OS start time, taken from the same ancestry snapshot. A pid-only
  match is never sufficient. `domain/registry-health.ts#classifyRegistryEntries`
  is the single source of truth for what the opportunistic sweep (and
  `/kankaku doctor`'s reporting) discards and why (`dead` / `stale-reuse` /
  `over-age`) — an entry with no verifiable `processStartId` is never used
  for matching, but is no longer discarded for that reason alone while its
  pid is alive and within the age ceiling (a live-but-unverifiable entry
  must never be un-registered by an unrelated process's sweep).
  **The registry is a startup-time lookup only**: every process reads it
  (via `adapters/subagent-startup.ts#resolveSubagentStartup`, which also
  skips the ancestry snapshot entirely when the registry has no other
  entries at all — F5) once, at factory time, to resolve its own tracked
  ancestor; nothing reads it again later as a live pointer to chase.
- `project` is a **hint** for joining a subagent to its orchestrator in
  `matchChildren`, never a hard filter (ADR 0021): a same-project candidate
  is preferred, but a cross-project one is eligible because its record
  already lives in the same `worklog.jsonl` this call reads — a verified
  subagent whose orchestrator's directory differs from its own routes its
  `WorkLog` **and** `InflightStore` writes straight into that directory
  instead of its own cwd-relative one (`extension.ts`, using
  `domain/ancestry-match.ts#resolveOrchestratorRef` — which also resolves
  through a subagent-of-subagent chain to the real top-level orchestrator,
  never a middle hop — and `adapters/kankaku-dir.ts#resolveWritableTarget`,
  which falls back to the process's own local directory, surfaced to
  `/kankaku doctor`, when the orchestrator's directory cannot be written
  to). **A record is written to exactly one log, always** — never both,
  never neither. This reunites parent and child before `buildTasks` ever
  runs (ADR 0023), and — unlike the read-time registry-pointer merge this
  replaced — does not depend on that pointer still existing by the time
  `buildTasks` runs: a subagent's own exit cleanup removing its registry
  entry (`process.on("exit")`, `session_shutdown`) changes nothing, and **a
  synced task row must never shrink** on a later sync pass because some
  earlier-discovered pointer is now gone (`buildTaskEntryUpdatePayload`
  recomputes `wall_ms`/`cost`/`subagent_count`/`subagent_linkage` from the
  *current* `TaskView` on every pass — that TaskView can only ever grow or
  stay the same, never lose a record it once had, since the record's
  location on disk never changes after it is written). The interval-union
  aggregation rule (`unionMs`) still lives exactly once, in `buildTasks` —
  the registry/ancestry machinery only ever expands which records that one
  call can see, never re-implements the union itself.
- `.kankaku/worklog.jsonl` is user data. Append only, one `JSON.stringify`
  line per record, tolerate malformed lines when reading, never rewrite it.
- Every file kankaku writes under `~/.kankaku` (the machine-wide registry
  `run/`, the catalog cache) is owner-only: directories `0700`, files
  `0600` (`adapters/file-modes.ts`) — an existing looser mode is tightened,
  best-effort, whenever encountered. Not applied to a project's own
  `<KANKAKU_DIR>` (`worklog.jsonl`, `inflight/`, …), which is project-local
  and frequently committed alongside.
- Bump `WORK_RECORD_SCHEMA` when a persisted field changes meaning or is
  removed. Adding optional fields does not require a bump.
- Tagged tool segments (`segments`) are the union of milliseconds per tag
  within one `WorkRecord`, and the sum of `segments` per tag across a
  task's or session's records — never a union at that level, since segment
  intervals are not persisted to `worklog.jsonl`.
- Each process checkpoints its in-flight record to `.kankaku/inflight/<pid>.json`
  (via `InflightStore`) so a hard crash still leaves an `interrupted` record,
  recovered on the next `session_start`; see README "Crash recovery".
- `sessionDir` (optional, `WorkRecordMetadata`/`TaskView`) is set only when
  pi's session manager reports a *non-default* session directory
  (`adapters/session-dir.ts#readNonDefaultSessionDir`, a guarded duck-typed
  call — `usesDefaultSessionDir` is not part of the `ReadonlySessionManager`
  type `ctx.sessionManager` carries, so an older pi version degrades to "no
  sessionDir," never a crash). Local-only: never sent to the hub today (no
  field for it yet — see README "Roadmap" for the recommended migration).
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
- `agent`/`agent_version`/`plugin`/`plugin_version`/`waiting_quality`/
  `cost_quality`/`subagent_linkage` on a `task_entries` row are
  **measurement** fields, the opposite of assignment: sent on both create
  and update (`domain/hub-entry.ts`'s `HubEntryContext` and
  `buildTaskEntryCreatePayload`), and included in
  `domain/sync-plan.ts#computeTaskContentHash` so a change to either
  quality field (e.g. a background subagent joining later) still triggers
  a resync. `agent_version`/`plugin_version` are resolved once, at
  extension load (`adapters/agent-info.ts`), and omitted — never
  guessed — when they cannot be determined. `WorkRecord.costObserved`
  (optional, set by `domain/work-tracker.ts#onTurnEnd` when any turn
  reports a real finite `cost`) is what `cost_quality` is computed from;
  adding it did not bump `WORK_RECORD_SCHEMA`.

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
