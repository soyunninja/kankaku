# Changelog

All notable changes to kankaku. The format follows Keep a Changelog; versions
follow semver. Dates are the day the version was cut.

## 0.6.0 — 2026-09-24

### Added

- **Compiled, pi-free library entry points** (`kankaku/domain`,
  `kankaku/ports`, `kankaku/hub`) so a plain Node consumer — no pi, no
  TypeScript loader — can import the pure domain, the port interfaces, and
  the hub adapters (PocketBase client/catalog/sink, `runSync`, the JSONL
  work log, the cached catalog, hub credentials). Built by `npm run build`
  (`tsc -p tsconfig.build.json`) to `dist/`, resolved through
  `package.json`'s `exports` map, and required to stay pi-free by
  `tests/public-exports.test.ts` against the compiled output. `npm run
  check` now builds first. `./src/extension.ts` (pi's own load path) is
  unchanged. See README "Using kankaku as a library".

## 0.5.1 — 2026-09-23

### Changed

- **The hub catalog now refreshes on every session start**, not just when
  its 6-hour cache is stale, so a client or project created in the hub
  minutes ago shows up right away instead of waiting for the TTL. Silent
  target resolution (project config / `repo_paths`) still returns without
  waiting for that refresh; only when the picker is actually shown does
  kankaku wait for it, bounded by a new 1.5s deadline
  (`pickerRefreshDeadlineMs`), falling back to the cached snapshot — without
  aborting the refresh — if the hub does not answer in time or the refresh
  fails. `/kankaku target pick` follows the same rule. The no-cache-at-all
  path and `/kankaku catalog refresh` are unchanged.

## 0.5.0 — 2026-09-23

The first release that talks to a hub, and the one that makes subagent time
trustworthy across every mechanism kankaku recognises.

### Added

- **Hub (PocketBase) integration.** kankaku can bill a record to a hub client,
  project and task instead of a free-text label: a session picker
  (`/kankaku target`), a cached catalog, and a sync client that uploads
  consolidated task rows (`/kankaku sync`, `sync all`, `backfill`), with
  automatic sync on `session_start`, `agent_settled` and now `session_shutdown`.
  Assignment fields are create-only, so reassigning a row in the hub is never
  undone by a later sync. Configuration through `KANKAKU_PB_URL`,
  `KANKAKU_PB_EMAIL`, `KANKAKU_PB_PASSWORD`, `KANKAKU_SYNC_AUTO`,
  `KANKAKU_SYNC_MIN_INTERVAL_MINUTES` and `KANKAKU_SYNC_PROMPT`.
- **Measurement quality on every task row.** `agent`, `agent_version`,
  `plugin`, `plugin_version`, `waiting_quality`, `cost_quality` and
  `subagent_linkage` travel with each row so the hub can say how much to
  trust a number. `thinking_level` (the model's reasoning effort) is recorded
  per record and sent along.
- **Generic subagent detection.** A machine-wide process registry
  (`~/.kankaku/run/`) and an OS ancestry snapshot let kankaku find a
  subagent's orchestrator by proven process identity, never by pid alone.
  Built-in profiles for gentle-pi (confirmed child marker, usage
  forwarding), pi's bundled subagent example (ancestry only) and
  pi-subagents (`PI_SUBAGENT_DEPTH`); any other mechanism can be declared
  with `KANKAKU_SUBAGENT_TOOLS` and `KANKAKU_SUBAGENT_CHILD_ENV`.
- **Four-state role model.** Besides orchestrator and subagent (joined or
  orphan), a record can be *uncertain*: a live tracked ancestor was found but
  no recognised marker. Uncertain records never become tasks and never sync
  as orchestrators. `KANKAKU_ROLE=orchestrator|subagent` is an explicit,
  non-inherited escape hatch that never beats a confirmed marker.
- **`/kankaku doctor`.** Reports the process's role and how it was decided,
  the tracked ancestor, active subagent profiles and their matches, sync
  state, hub configuration problems and stale sync tasks.
- **Cross-worktree reunification.** A verified subagent running in another
  checkout writes its records straight into its orchestrator's `.kankaku`
  directory, so parent and child meet before any aggregation runs.
- **Session directory.** A non-default pi session directory is recorded so a
  session can be resumed exactly from the hub.
- Records for runs an extension starts without a user prompt
  (`trigger: "extension"`), so gentle-pi wake-ups are no longer invisible.

### Changed

- Automatic sync is throttled only for `agent_settled`; `session_start` and
  `session_shutdown` always catch up when the log changed. The shutdown sync
  is awaited with a 3 s bound so quitting pi never hangs on an unreachable
  hub.
- Every file kankaku writes under `~/.kankaku` is owner-only (directories
  `0700`, files `0600`); `~/.kankaku` itself is never chmod'd.
- Sync-state hashes are kept for as long as a task exists, so "changed but
  outside the sync window" is reported once, not forever.
- Project is a hint, not a filter, when joining subagents to orchestrators.

### Fixed

- A run that starts before the previous one settles gets its own record; a
  set-aside record is written exactly once at shutdown; duplicate ids are
  deduplicated at the log boundary.
- Forwarded subagent usage is added exactly once, in the task view, and never
  when a joined child confirmed by the same profile already carries it.
- A configured child marker never demotes an interactive session; ambient
  variable names (`PI_`, `TERM`, `LC_`, `NODE_`, `NPM_`, `KANKAKU_` prefixes
  and known pi/shell names) are rejected as markers.
- Process identity is frozen for the life of the OS process, so `/new`,
  `/resume`, `/fork` and `/reload` never re-derive a different role.
- Stale writability-probe files and dead registry entries are swept
  opportunistically; a live-but-unverifiable registry entry is never removed
  by another process.

### Notes

- `WORK_RECORD_SCHEMA` is unchanged: every new persisted field is optional.
- The hub that receives these rows lives in the `kankaku-hub` repository;
  its dashboard shows sessions, tasks, clients and, optionally, Engram
  session narratives.

## 0.4.6 — 2026-09-19

Last release before the hub integration. See the git history for details.
