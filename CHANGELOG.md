# Changelog

All notable changes to kankaku-tui. The format follows Keep a Changelog;
versions follow semver. Dates are the day the version was cut.

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
