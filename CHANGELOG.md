# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
