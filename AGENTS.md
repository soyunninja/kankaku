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
  the one composition point that reads the registry, takes an ancestry
  snapshot only when it could find something (F5), and resolves this
  process's tracked ancestor; `process-identity.ts`'s
  `resolveProcessIdentity`, which composes `subagent-startup.ts` with
  `config.ts#detectRole`/`readRoleOverride`/`stripRoleOverride` and
  `domain/ancestry-match.ts#resolveOrchestratorRef` into one process's full
  role/ancestry identity, and `process-identity-memo.ts`, which freezes
  that identity for the life of the OS process (G1 — see README "Subagents"
  > "Interactive sessions and `KANKAKU_ROLE`" and "`/new`/`/resume`/`/fork`/
  `/reload` reuse the same OS process"); `kankaku-dir.ts`'s
  `resolveWritableTarget`, which a verified subagent uses to route its
  `WorkLog`/`InflightStore` straight into its orchestrator's directory
  instead of its own (F1, ADR 0023's rewrite — there is no longer a
  `WorkLog` decorator that reunites a child at read time; write-side
  routing makes that redundant), and whose writability probe sweeps its own
  stale marker files (`.kankaku-write-probe.*.tmp` older than a minute,
  R4) opportunistically on every run, so a probe SIGKILLed between its
  write and its own unlink never leaves one behind forever; `file-modes.ts`, the owner-only
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
  child marker) always wins over `KANKAKU_ROLE=orchestrator`. Since 6b
  (`domain/subagent-profile.ts`, ADR 0020) this precedence is no longer
  gentle-pi-specific — `config.ts#detectRole`'s `childMarkers` parameter
  generalises the check to any confirmed BUILT-IN marker from the active
  `SubagentProfile` set (gentle-pi, pi's bundled reference example — no
  marker, ancestry-only — and pi-subagents' `PI_SUBAGENT_DEPTH`), with the
  exact same "always wins" rule; every pre-6b 3-arg `detectRole` call site
  is unaffected (its default `childMarkers` is still exactly
  `GENTLE_PI_AGENTS_CHILD=1` alone). **Since C2, a `KANKAKU_SUBAGENT_CHILD_ENV`-
  configured marker is a SEPARATE, weaker 5th-param tier (`configuredMarkers`)
  — it does NOT get the unconditional "always wins" rule**: it still
  confirms a subagent for a non-interactive process, but never demotes an
  interactive one (see the "Measurement rules" C2 bullet below) — an
  earlier version of this precedence generalised both tiers identically,
  which was the C2 bug: a configured marker present on the user's own
  top-level interactive session silently made it `role: "subagent"` with
  no parent. So a `KANKAKU_ROLE=orchestrator` leaked into the environment
  (a shell rc, tmux, CI) can never turn a genuine subagent into a confirmed,
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
  decided once, **per OS process** (`config.ts#detectRole`, env-only, plus a
  cheap synchronous TTY-based interactivity guess feeding only the
  `KANKAKU_ROLE=subagent`-in-an-interactive-session exception above — never
  ancestry, and never pi's own authoritative `ctx.mode`); `roleConfidence`
  is (separately) deferred and resolved exactly once, at `session_start`
  (`pi-tracker.ts`'s `resolveRoleConfidence`), since
  interactivity is only knowable once pi's own `ExtensionContext` exists —
  and then stays stable for the rest of the process's life.
  **G1**: pi re-invokes the extension factory in the SAME OS process on
  `/new`, `/resume`, `/fork` and `/reload` ("reloads and rebinds
  extensions" — see `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`).
  `role`, `roleOverride` (as read before `stripRoleOverride` removes it —
  a second read would see it already gone), `childMarkerPresent`,
  `hasTrackedAncestor`/the verified ancestor entry, `orchestratorRef`
  (F4), and this process's own F5 start identity are all facts about the
  OS PROCESS, not the pi session running inside it — `extension.ts` reads
  them all through `adapters/process-identity-memo.ts`, which computes
  them once (`adapters/process-identity.ts#resolveProcessIdentity`) and
  freezes the result for every later factory invocation in this process,
  so a second/third/fourth invocation never re-derives (and potentially
  disagrees with) the first, and a confirmed `KANKAKU_ROLE` force is never
  silently lost on `/resume` (the exact bug this fixes). Only what
  genuinely varies per session — interactivity from `ctx.mode`, and this
  session's project/write target (`resolveKankakuDir(config.dir,
  process.cwd())`, since pi can enter a different cwd across a session
  switch in the same process) — is still re-evaluated every invocation.
  The one real per-process singleton this touches, `process.on("exit",
  ...)` for this process's own registry-entry cleanup, is also registered
  at most once across every invocation (`registerExitCleanupOnce`) — never
  once per `/new`/`/resume`/`/fork`/`/reload`, which would otherwise pile
  up one listener per reload for the life of the process.
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
  and frequently committed alongside. **`~/.kankaku` itself is never
  chmod'd (R2)**: when pi runs with `cwd === $HOME`, a project's own
  default `KANKAKU_DIR` (`.kankaku`, relative) resolves to that exact same
  path, so tightening the directory would tighten a project's kankaku dir
  by accident. Only what this package exclusively owns is tightened: the
  `run/` subdirectory (`MachineProcessRegistry`) and the catalog cache
  *file* (`CachedCatalog`, always written 0600 via its own tmp+rename, so
  it needs no separate chmod either) — never the shared parent directory.
  **G3**: this rule cuts both ways — `~/.kankaku` is never chmod'd when it
  already exists, but when `CachedCatalog` is the first writer to create it
  at all (no project has ever put its own `.kankaku` there), it is created
  owner-only (`0700`), not left at the umask default. `mkdirSync`'s `mode`
  option only ever applies to a directory a call actually creates, never
  one that already existed, so passing it unconditionally is safe for both
  cases with no `existsSync` check needed.
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
- A linked hub task (`hubTaskId`/`hubTaskTitle`, `/kankaku task pick`) is
  **session-only** — never written to `config.json`, never prompted at
  `session_start` — and validated against the resolved project by the same
  pure `domain/work-target.ts#resolveWorkTarget` (a task whose project no
  longer matches is dropped, never linked across projects). Sync sends
  `task_entries.task` on create only, exactly like `client`/`project` (see
  `domain/hub-entry.ts#resolveTaskAssignment`) — a reassignment made in the
  hub's web app is never undone by a later sync.
- Hub sync (phase 2, `domain/hub-entry.ts`, `domain/sync-plan.ts`,
  `adapters/sync-runner.ts`) uploads `buildTasks` output — the aggregation
  rule (D6 in `kankaku-pocketbase-proposal.md`) is never re-implemented
  against raw records on the server or in any sync adapter. The revisit
  window (`domain/sync-plan.ts#planSync`) is anchored to the *watermark*
  (`syncedThrough - windowHours`), not to wall-clock time (R3): a task
  whose `endedAt` a late-settling background subagent bumps forward (see
  `task-view.ts`'s `Math.max(parentEnd, ...subagentSettledAt)`) stays
  eligible for an ordinary incremental sync no matter how long the
  directory then goes unsynced, as long as no *other* task's sync has since
  advanced the watermark past it; once it has, only `sync all` picks the
  late join back up — `planSync`'s `staleOutsideWindow` (surfaced by
  `/kankaku sync status` as "N task(s) changed but fall outside the sync
  window") makes that case visible instead of silent, and ONLY when the
  task's content genuinely changed since it was last synced (G2): a task's
  content hash (`computeTaskContentHash`) is kept in `sync-state.json`'s
  `hashes` **for as long as the task itself exists**, never pruned just
  because it fell outside the revisit window
  (`domain/sync-plan.ts#pruneHashes`) — pruning by window used to mean a
  task's hash, once dropped, could never be told apart from "never synced",
  so every task older than the window reported changed forever, training
  users to ignore the count. `hashes` therefore grows with the total number
  of distinct tasks a directory has ever synced, not with time (~50 bytes
  per entry; 10,000 retained hashes serialize to well under 1MB — see
  `tests/sync-plan.test.ts`'s state-size-bound test), which stays small
  even for years of real history. An existing `sync-state.json` needs no
  migration; a task whose hash a pre-fix build already pruned is reported
  stale exactly once more (an unavoidable one-time correction, not a
  recurring flood) and then never again. Nothing in a pi
  event handler awaits the network, with exactly one exception:
  `session_shutdown` (`adapters/pi-tracker.ts`) awaits a single
  time-bounded sync — pi awaits `session_shutdown` handlers with no
  timeout of its own (verified in pi's dist), so the last prompt(s) of a
  session reach the hub before pi exits instead of waiting for the next
  session's `session_start`, and `shutdownSyncTimeoutMs` (default 3000,
  see `PiTrackerDeps`) is the only thing bounding how long quitting can
  take when the hub is unreachable. `session_start`/`agent_settled` sync
  remains fire-and-forget, and `worklog.jsonl` is still never rewritten by
  any of this — sync only reads. The automatic (`session_start`/
  `agent_settled`/`session_shutdown`) path only, never a manual sync, is
  gated by two cheap checks before any `readAll()` or network call, in
  `runSync` (`adapters/sync-runner.ts`): it skips entirely, for every
  automatic trigger, when `WorkLog#version()` is unchanged since the last
  successful sync (persisted as `SyncState.logVersion`); otherwise it
  throttles to at most once per `KANKAKU_SYNC_MIN_INTERVAL_MINUTES`
  (default 5, `0` disables; persisted as `SyncState.lastRunAt` so it holds
  across processes) — but only `agent_settled` is ever throttled, since it
  fires once per prompt. `session_start` and `session_shutdown` always
  bypass the throttle: a session boundary is worth catching up on
  regardless of how recently the last automatic run happened, and the
  shutdown one is awaited and time-bounded on its own anyway.
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
- **An ambiguous subagent-profile match contributes nothing that affects
  money or joins** (C1). When 2+ profiles register the same tool name and
  neither can be told apart (`domain/subagent-profile.ts#resolveToolProfile`,
  SUBAGENT-REQ-005), the span still opens (best-effort agent/mode via
  `mergeAgreeingLaunchInfo` — kept only when every candidate that reports
  one agrees), but `usage`, `taskId` and `profile` are never taken from any
  candidate (`safeAmbiguousResultInfo`). Forwarded usage in general is
  never folded into the triggering `WorkRecord`'s own `usage` at write time
  any more — it lives on the span as `SubagentSpan.forwardedUsage`
  (`domain/work-tracker.ts#onToolEnd`), and `domain/task-view.ts#buildTasks`
  is the only place (ADR 0006: aggregation stays in exactly one place) that
  adds it to a task's total, and only when this task has no joined child
  record confirmed by the **same** profile — closing the documented
  "configured profile with both a marker and usage forwarding" double-count
  risk (`buildConfiguredProfile`'s doc comment) with a runtime guard, not
  just a README warning.
- **A configured child-env marker never demotes an interactive session**
  (C2). `KANKAKU_SUBAGENT_CHILD_ENV` markers are validated at load time
  (`config.ts#validateSubagentChildEnvMarkers`): a name that looks
  pi/shell/OS/npm-owned (`PI_CODING_AGENT`, `AI_AGENT`, generic shell/OS
  vars, or a `PI_`/`TERM`/`LC_`/`NODE_`/`NPM_`/`KANKAKU_` prefix) is
  rejected outright and never reaches the configured profile
  (`KankakuConfig.rejectedSubagentChildEnvMarkers`, surfaced once via
  `ctx.ui.notify` and `/kankaku doctor`). This denylist cannot enumerate
  every possible ambient variable, so `config.ts#detectRole` also treats a
  user-configured marker as a SEPARATE, weaker tier from the built-in ones
  it hardcodes: like `KANKAKU_ROLE=subagent`, a configured marker matched
  on an interactive process is ignored, never honoured
  (`configuredMarkerIgnoredInteractive`) — a built-in marker
  (`GENTLE_PI_AGENTS_CHILD`, `PI_SUBAGENT_DEPTH`) keeps its unconditional
  precedence, since no built-in mechanism kankaku recognises ever launches
  its child interactively. `adapters/process-identity.ts#resolveProcessIdentity`
  only ever attributes `profile` when this process's `role` actually ended
  up `"subagent"` — a configured marker present but ignored for
  interactivity must never leave an `orchestrator` record carrying
  `profile: "configured"`. See README "Subagents" > "Subagent profiles
  (phase 6b)" for the user-facing rules.

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
- The public library surface is exactly the three compiled barrels
  (`src/domain/index.ts`, `src/ports/index.ts`, `src/hub/index.ts`,
  published as `kankaku/domain`, `kankaku/ports`, `kankaku/hub`). Nothing
  reachable from any of them may import `@earendil-works/*` (a pi package
  type) — `tests/public-exports.test.ts` enforces this against the
  compiled `dist/` output. `npm run check` builds (`tsc -p
  tsconfig.build.json`) before typechecking and testing, so a barrel that
  newly reaches a pi-touching adapter fails `check`, not just a separate
  lint step. See README "Using kankaku as a library".

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
