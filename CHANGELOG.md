# Changelog

All notable changes to kankaku-tui. The format follows Keep a Changelog;
versions follow semver. Dates are the day the version was cut.

## Unreleased

### Changed

- **The setup wizard has no sidebar and merges Detect into Agents**: the
  wizard starts on Agents, whose checklist rows now carry each agent's
  detection state directly (`configured (<path>)` / `not configured` for
  pi, gentle-shell and Claude Code; `no adapter yet` / `not installed` for
  the disabled Codex/OpenCode rows), and `esc` on that first step quits
  instead of going back. The left step list is gone; the panel's own
  title carries progress instead (`[ Setup · Agents 1/5 ]`,
  `[ Setup · Claude Code 2/5 ]`, …), numbering only the steps a given run
  will actually show — Claude Code drops out of the count when it's
  skipped. `Setup · Done` carries no number.
- **Roots are searched in depth**: `kankaku today`/`tasks`/the wizard's
  Roots step now search each configured root recursively, up to 5
  directory levels below it by default, instead of only its direct
  children — a directory with `.kankaku/worklog.jsonl` is a project, the
  search still continues below it (a stray worklog in a parent directory
  never hides the projects beneath), and `node_modules`, `.git` and
  hidden directories are skipped along the way.

## 0.3.0 — 2026-09-28

### Added

- **`kankaku setup` is now an interactive wizard**: on a real terminal
  (and with neither `--yes` nor `--dry-run`), `kankaku setup` opens as a
  full-screen, step-by-step wizard in the same sidebar/panel look as the
  rest of the app — Detect, Agents (a checklist you drive, instead of
  setup acting on whatever it finds pending; unchecking a configured
  agent removes kankaku from it), Claude Code checkout, Hub (use an
  existing hub, install one locally, or skip), Roots, Review and Apply,
  ending with the Dashboard opening in place. `kankaku` with no arguments
  offers the same wizard the very first time, when no `~/.kankaku/tui.json`
  exists yet. `kankaku setup --yes` and `--dry-run` are unchanged:
  non-interactive, and never open the wizard even on a TTY.

## 0.2.1 — 2026-09-27

### Fixed

- **`kankaku setup` reports what it does**: every file it writes is
  announced (`wrote <file>`, or `unchanged <file>` when nothing needed
  changing), and refreshing the catalog prints the same result line as
  `kankaku catalog refresh`. Previously the only feedback was the final
  doctor report.

## 0.2.0 — 2026-09-27

### Added

- **`kankaku setup` and `kankaku doctor`**: `kankaku setup` detects every
  coding agent kankaku knows how to configure on this machine (pi,
  gentle-shell, Claude Code — Codex and OpenCode are detected and reported
  but have no adapter yet), offers to install or configure kankaku for
  each one that isn't wired up yet, configures hub credentials, and writes
  this app's own `~/.kankaku/tui.json`. `--yes` accepts every question's
  own default without prompting; `--dry-run` prints the plan (each step's
  `done`/`todo`/`unavailable` state and the exact file it would change)
  and writes nothing. Every write is preceded by a `<file>.bak` the first
  time that file is touched, and re-running is always safe: only what is
  still missing, or what is explicitly confirmed, is ever written.
  `kankaku doctor` prints the same plain-text report on its own, read-only.

## 0.1.2 — 2026-09-27

### Fixed

- **An installed `kankaku` did nothing**: npm runs the binary through the
  `node_modules/.bin/kankaku` symlink, so the entrypoint's main-module
  guard compared the link path with the real file and never ran. Real
  paths are compared now; a regression test runs the CLI through a
  symlink, and the packed tarball was verified through npm's own bin.

## 0.1.1 — 2026-09-27

### Fixed

- **Tests failed on a real terminal**: Ink emits ANSI colour codes when
  stdout is a TTY or `COLORTERM` is set, so `npm test` (and therefore
  `npm publish`, through `prepublishOnly`) failed with 34 text assertions
  outside a plain pipe. Colour is now disabled for every test run by
  `tests/setup.mjs`, loaded before the test files. No change to the app.

## 0.1.0 — 2026-09-27

### Added

- **The `kankaku` binary**: `kankaku` opens a fullscreen terminal
  dashboard built with Ink; `kankaku today`, `kankaku tasks [--all]`,
  `kankaku catalog [refresh]` and `kankaku sync [status|all] [--project
  <dir>]` print the same data for scripts and cron.
- **Projects across roots**: every `<root>/*/.kankaku/worklog.jsonl` under
  the roots in `~/.kankaku/tui.json` (or the current directory) is a
  project, read with kankaku's own log reader.
- **Dashboard**: today's work, waiting, cost and cache hit; the last seven
  days as sparklines; projects with their share of the day; the hub card
  (pending, stale, last sync, catalog size); and Quick actions (`c` refresh
  the catalog, `s` sync all projects, `S` full sync, `r` reload).
- **Tasks**: today's or every task per project with client, project, hub
  task, times, cost and prompt, plus a detail panel; opened from the
  dashboard filtered to one project.
- **Catalog**: the cached hub catalog, clients and their projects with open
  task counts, refreshed from the hub on demand.
- **Sync**: one card per project with its sync status and normal or full
  sync per project or for all, mirroring the pi extension's sync wiring.
- **Look and feel**: a sidebar, titled panels, aligned tables, bars and
  sparklines, key hints per zone; the pi themes Gentleman-Sexy (default),
  Gentleman-Cute and Gentle (`--theme`, `KANKAKU_TUI_THEME`); fullscreen
  layout that never exceeds the terminal, scrolling lists with
  PageUp/PageDown/Home/End, and focus zones between the sidebar and the
  content.
- Built on the published `kankaku` 0.8.0 library entry points
  (`kankaku/domain`, `kankaku/hub`); no aggregation or hub payload logic is
  reimplemented here.
