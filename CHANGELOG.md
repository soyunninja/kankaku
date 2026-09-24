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
