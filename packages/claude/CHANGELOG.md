# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- **Tokens on every record.** The input, output, cache read and cache write
  tokens are read from the session transcript (and from each subagent's
  transcript), so `cache hit` now appears for Claude Code records. Only new
  bytes are read at each settle, at most 16 MiB; `UserPromptSubmit` only
  `stat`s the files and the other hooks read nothing.
- **`agentVersion`.** Claude Code's version, taken from the transcript.
- **Cost for headless runs.** A `claude -p` session keeps each settled prompt
  pending and writes its record at `SessionEnd` (or in crash recovery) with
  the transcript's `cost-state` cost, through the same chained baseline as the
  statusline cost. With several prompts the cost is shared in proportion to
  their tokens and each record carries `costAllocated`, kept local and never
  sent to the hub.
- **Late transcript writes are covered.** Claude Code writes the transcript
  asynchronously, after `Stop` has started. `Stop` polls every 25 ms and
  reads once at least 100 ms have passed since the hook started, the size is
  stable and an assistant line is present, giving up at 300 ms (the statusline
  wait counts), so the last message of a prompt is not shifted into the next
  record, a headless
  `SessionEnd` or recovery reads once more and adds late usage to the last
  pending prompt, and the entry point and version are also read from the
  start of the file when no new line carries them.
- **`model` from the transcript** (`anthropic/<message.model>`) when the
  statusline gave none.
- Any surprise in the (undocumented) transcript format leaves the record as it
  was before: written, without tokens, version or cost, and no hook fails.

## 1.2.0 — 2026-09-29

No changes in this package's code; released in lockstep with kankaku 1.2.0.

## 1.1.0 — 2026-09-29

No changes in this package; released in lockstep with kankaku-pi and
kankaku 1.1.0.

## 1.0.2 — 2026-09-29

### Fixed

- **`/kankaku:status` promised a recovery that would not happen.** The
  line compared the session total with the sum of ALL the session's
  records and, when idle, called the whole difference "unrecorded, goes
  to the next prompt". For a session that spent money before it had a
  chained baseline (upgraded mid-way, or resumed without its state) that
  was false: the next prompt only carries what was spent since the last
  settle. The line now separates `this prompt so far`, `pending, goes to
  the next prompt` and `never recorded`. Attribution itself was correct
  in 1.0.1 and is unchanged.

## 1.0.1 — 2026-09-29

### Fixed

- Spend that landed between two prompts was in no record: on a real session
  the statusline total was 461.06 USD while its 134 records summed to
  299.80 USD, so 35 % of the spend was missing. A prompt's cost was measured
  from the statusline snapshot at submit, which left background subagent
  work and late statusline refreshes after a `Stop` unattributed. The
  session state now keeps `costBaseline`, the total at the last settle, and
  each prompt is measured from it (Stop, SessionEnd and crash recovery), so
  the records of a session add up to its total. A new session starts at 0; a
  counter reset records the new total. `/kankaku:status` shows `recorded $X
  of $Y` and flags an unrecorded gap. Headless runs still have no cost.

## 1.0.0 — 2026-09-29

### Changed

- The library dependency is renamed from `kankaku` to `kankaku-pi`, and
  its entry points are imported as `kankaku-pi/domain`, `kankaku-pi/ports`
  and `kankaku-pi/hub`. The package keeps its own name, `kankaku-claude`
  (directory unchanged). No behaviour change.
- `kankaku-claude sync` usage text names `dist/cli.js`, and comments no
  longer point at files that are not in the repository.

## 0.12.1 — 2026-09-29

No changes in this package; released in lockstep with kankaku 0.12.1.

## 0.12.0 — 2026-09-29

### Added

- **`/kankaku:task` links the session to a hub task.** It lists the open
  tasks of the project resolved for the folder, and picks one by number, hub
  id or title text (`clear` removes the link). The link is session-only, kept
  in `<KANKAKU_DIR>/claude/<session>.target.json`, and the records written at
  Stop, SessionEnd and crash recovery carry `hubTaskId` and `hubTaskTitle`
  while the task still belongs to the resolved project. `/kankaku:status` and
  `/kankaku:doctor` print the `task:` line. The CLI finds its session from its
  own process; `KANKAKU_CLAUDE_SESSION` names it explicitly.

## 0.11.0 — 2026-09-29

### Added

- **Records resolve their client and project automatically.** Records
  written at Stop, SessionEnd and crash recovery now carry `clientId`,
  `clientName`, `projectId` and `projectName` (and the legacy `client`
  label) when the project `config.json` ids or the cached catalog's
  `repo_paths` match the session's working directory, so the hub no longer
  files them under the unassigned client. The catalog is read from
  `~/.kankaku/catalog.json` only: no network, no delay, and no target when
  the cache is missing. Records already on disk are not rewritten, and rows
  already uploaded as unassigned stay so until reassigned in the web app.
- `/kankaku:status` and `/kankaku:doctor` print the resolved target and its
  source, or `target: none (<reason>)`.

## 0.10.2 — 2026-09-29

### Fixed

- **Records synced by another tool were attributed to the syncer.** Records
  carried no `agent`/`plugin`, so when the kankaku TUI synced a worklog
  written by Claude Code, the hub row was created as agent `unknown`,
  plugin `kankaku-tui`. Every record (settled, settled at SessionEnd, or
  recovered as `interrupted`) now carries `agent: "claude-code"`,
  `plugin: "kankaku-claude"` and `pluginVersion`. Records already on disk
  are not rewritten.

## 0.10.1 — 2026-09-29

### Fixed

- **A prompt interrupted by a hung session was recorded with the time until
  the next session started.** Crash recovery settled the open prompt at
  recovery time, so a session that hung and was recovered the next morning
  produced a record with a 14.4 h wall time. The prompt is now closed at
  the timestamp of the last event recorded for it (its own
  `UserPromptSubmit` when nothing followed); a waiting span still open is
  closed at the same instant, and the record stays `interrupted`.

## 0.10.0 — 2026-09-28

### Fixed

- **Installed as a dependency, the plugin could not run at all.** This
  package now compiles to `dist/` (`npm run build`, `tsc -p
  tsconfig.build.json`) and ships `dist/` instead of `src/`/`tsconfig.json`
  in `package.json`'s `files`. Every hook/statusline/CLI command
  (`hooks/hooks.json`, `commands/*.md`, the `statusLine` snippet
  `kankaku setup`/`/kankaku:setup` prints) now points at the compiled
  `dist/*.js`, never `src/*.ts` — Node 24 refuses to type-strip a `.ts`
  file once it sits under a `node_modules` directory
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `kankaku-tui`
  install of this package (its dependency, not a checkout) could not run
  a single hook, the statusline, or the CLI before this fix. `npm run
  check`/`prepublishOnly` build first; a manual `--plugin-dir` checkout
  now needs `npm install && npm run build` once (see README "Install").

### Changed

- README "Install": the recommended path is now `npm i -g kankaku-tui &&
  kankaku setup` — `kankaku-tui` depends on this package directly and its
  setup wizard/`--yes` flow writes both `statusLine` and `hooks` into
  `~/.claude/settings.json` in one step, so no checkout or `--plugin-dir`
  is required for the plugin to measure time or report cost.
  `--plugin-dir <checkout>` remains documented as the manual/dev path
  (also the only way to get the `/kankaku:*` slash commands), with a note
  that combining it with a `kankaku setup`-configured machine double-runs
  the hooks and double-writes worklog records.

### Added

- `/kankaku:doctor` and `node src/cli.ts doctor` provide a read-only local
  diagnostic of plugin files, sessions, cost visibility and hub sync state,
  without network requests or credential output.

- `/kankaku:sync-status` and `/kankaku:sync-all` slash commands for local
  sync state inspection and full hub sync, respectively.

- Phase 1: per-prompt work records from Claude Code hooks. Writes one
  `WorkRecord` per user prompt to `<KANKAKU_DIR>/worklog.jsonl`, in the same
  schema the kankaku pi extension writes, so kankaku's existing
  report/export/hub tooling can consume it unchanged.
  - Event sourcing per session (`<KANKAKU_DIR>/claude/<session_id>.events.jsonl`)
    plus pure replay into a fresh `WorkTracker`, since Claude Code hooks are
    fresh short-lived processes with no persistent in-memory state.
  - All 9 documented hook events wired: `SessionStart`, `UserPromptSubmit`,
    `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`,
    `SubagentStop`, `Stop`, `SessionEnd`.
  - Per-prompt cost from the statusline's `cost.total_cost_usd`, as a delta
    across the prompt.
  - Crash recovery: a dead session with an open prompt is recovered as an
    `interrupted` record on the next `SessionStart`.
  - `src/statusline.ts` (a manually wired `statusLine` command) reports the
    open prompt's elapsed clock and the current cost.
  - `node src/cli.ts report|status|setup` and the `/kankaku:report`,
    `/kankaku:status`, `/kankaku:setup` slash commands.

- Manual hub sync via `node src/cli.ts sync [all|status]` and the
  `/kankaku:sync` slash command (default sync only). Prompts are omitted by default.
- Best-effort automatic hub sync on `SessionStart`, `Stop`, and `SessionEnd`;
  disabled with `KANKAKU_SYNC_AUTO=0`. Missing credentials and sync failures
  never block local records or cleanup.

### Fixed

- T7: the statusline command is wired globally in `~/.claude/settings.json`,
  so it runs in every Claude Code session on the machine, plugin loaded or
  not. It used to write cost into the open project's own
  `.kankaku/claude/<session_id>.state.json`, creating a placeholder file
  (`pid: 0`, `cwd: ""`) in whatever project happened to be open and
  recreating it after `SessionEnd` deleted it — and `isAlive(0)`
  (`process.kill(0, 0)` signals the whole process GROUP) reported that
  placeholder alive forever, so crash recovery never swept it.
  - Cost now lives only under `~/.kankaku/claude/cost/<session_id>.json`
    (`src/cost-store.ts`, new; node builtins only), never under a project.
    The statusline only reads a project's state file, read-only, for the
    open-prompt clock; a missing state file renders `kankaku idle` without
    creating anything.
  - `SessionState` no longer has a `cost` field; `mergeCost` is removed.
  - `isAlive` returns `false` for any non-positive or non-integer pid
    without calling `process.kill`; `recoverStaleSessions` treats
    `pid <= 0` as dead independently of `isAlive`'s answer.
  - `SessionEnd` also deletes the session's cost file; `SessionStart`
    (non-`compact`) sweeps cost files older than 7 days.
  - `node src/cli.ts status` reads cost from the cost file.

## 0.9.0 — 2026-09-28

### Changed

- Moved into the kankaku monorepo (`github.com/soyunninja/kankaku`,
  `packages/claude`); versions are now lockstep with the other client
  packages (`kankaku`, `kankaku-tui`). Depends on `kankaku ^0.9.0` (was
  `^0.6.0`). No behaviour change.
