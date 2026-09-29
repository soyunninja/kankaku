# Changelog

All notable changes to kankaku (formerly kankaku-tui). The format follows Keep a Changelog;
versions follow semver. Dates are the day the version was cut.

## Unreleased

### Changed

- The package is renamed from `kankaku-tui` to `kankaku` (directory
  `packages/tui` → `packages/cli`); `npm install -g kankaku` now installs
  the `kankaku` command. The `kankaku` bin is unchanged. The library
  dependency is renamed from `kankaku` to `kankaku-pi` and its entry
  points are imported as `kankaku-pi/domain`, `kankaku-pi/hub` and
  `kankaku-pi/ports`. Records synced from this app keep the hub context
  `plugin: "kankaku-tui"`. Local checkouts of the pi package under
  `packages/pi` are now recognised in pi settings, alongside the previous
  `kankaku` path form.

## 0.12.1 — 2026-09-29

No changes in this package; released in lockstep with kankaku 0.12.1.

## 0.12.0 — 2026-09-29

### Changed

- Bundles the next `kankaku-claude`, which adds `/kankaku:task` to link a
  Claude Code session to a hub task. `kankaku setup` installs the new command
  file with no change in this package's own code; `kankaku doctor` reports
  `commands missing: task` until setup runs again.

## 0.11.0 — 2026-09-29

### Changed

- Bundles `kankaku-claude` 0.11.0: Claude Code records now resolve their
  client and project automatically (the project's `config.json`, then the
  cached catalog's `repo_paths` match for the working directory), so they
  no longer land on the hub's unassigned client. `/kankaku:status` and
  `/kankaku:doctor` show the resolved target. No change in this package's
  own code.

## 0.10.2 — 2026-09-29

### Changed

- Bundles `kankaku-claude` 0.10.2, whose records carry their own agent and
  plugin identity: a Claude Code worklog synced from this app is no longer
  labelled `unknown` / `kankaku-tui` on the hub. No change in this
  package's own code.

## 0.10.1 — 2026-09-29

### Added

- **`kankaku setup` installs the `/kankaku:*` slash commands.** Claude Code
  only offers a plugin's commands when it loads kankaku as a plugin, but
  setup wires the hooks and statusLine through `~/.claude/settings.json`,
  so `/kankaku:report` and the rest did not exist. Setup now generates
  `~/.claude/commands/kankaku/<name>.md` from the plugin's `commands/*.md`
  (the plugin root filled in for `${CLAUDE_PLUGIN_ROOT}`), reports each
  file as `wrote`/`unchanged`/`removed`, and unchecking Claude Code removes
  them (and the directory once empty). Files it did not generate are never
  overwritten or removed. `setup --dry-run` prints the directory and
  file count. Re-run `kankaku setup` after the install path changes (e.g.
  switching Node versions).

### Fixed

- **Claude Code was judged configured from its root alone.** A deleted or
  edited command, a missing hook event (`Stop`/`SessionEnd` settle the
  records) or a hook whose command, matcher or timeout changed left
  `kankaku doctor` at `done` and `kankaku setup` writing nothing, and the
  same happened on every upgrade that added a command or hook event. Claude
  Code is now configured only when the installed statusLine, hook entries
  and command files equal what the plugin at the resolved root expects, with
  no stale generated file; otherwise `doctor` reports `todo` naming the
  drift (`hooks missing: Stop, SessionEnd; commands missing: sync; commands
  outdated: status`, or `plugin unresolved: …`), and `kankaku setup --yes`
  reconciles a selected Claude Code every time, printing `wrote`/`unchanged`
  per file. Foreign hook entries and foreign files in `commands/kankaku/`
  are left untouched. A failed atomic write no longer leaves a `.tmp` file.

## 0.10.0 — 2026-09-28

### Fixed

- **The Claude Code hooks and statusLine `kankaku setup` wrote could not
  run once installed.** `kankaku setup` used to write commands pointing
  at `kankaku-claude`'s `.ts` sources (`node ".../src/hook.ts"`); Node 24
  refuses to type-strip a `.ts` file under a `node_modules` directory
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so every hook and the
  statusline failed at launch for anyone who installed `kankaku-tui`
  rather than working from a git checkout. `kankaku-claude` now ships a
  compiled `dist/` (see its own changelog), and `kankaku setup` writes
  `node ".../dist/hook.js"` / `.../dist/statusline.js"` instead.
  `domain/claude-integration.ts` still recognizes the legacy `/src/*.ts`
  form as ours (so an already-configured machine gets its entries
  replaced, or removed on uncheck, instead of left stale and duplicated);
  "configured" (`doctor`/`setup --dry-run`/the wizard) now requires the
  current `dist` form specifically — a legacy `src` form at the same root
  is reported `outdated statusLine`/`outdated hooks` and setup rewrites
  it. `adapters/setup/claude-plugin.ts#locateClaudePlugin` validates a
  `--claude-plugin-dir`/`KANKAKU_CLAUDE_PLUGIN_DIR` override the same
  way: a checkout missing `dist/hook.js` now fails with "run npm run
  build in `<dir>` first" instead of silently writing a broken command.
  A new integration test (`tests/claude-hook-dist-integration.test.ts`)
  spawns the real `dist/hook.js` command against the workspace
  `kankaku-claude` package with an isolated `HOME` and a real
  `SessionStart` payload, asserting exit code 0 — the class of test that
  would have caught this defect, since every prior test only imported
  `src/*.ts` directly and never spawned the actual command as a child
  process.

### Changed

- **`kankaku setup`'s Claude Code step no longer asks for a checkout
  path.** `kankaku-tui` now depends directly on `kankaku-claude`
  (`^0.9.0`), so the plugin's files ship inside every `kankaku-tui`
  install; setup resolves their location itself
  (`adapters/setup/claude-plugin.ts#locateClaudePlugin`, the same
  `require.resolve` pattern `hub-manager/package.ts` already used for
  `kankaku-hub`). Checking Claude Code now writes both `statusLine` and
  `hooks` (read from the plugin's own `hooks/hooks.json`) into
  `~/.claude/settings.json` in one step, merged with — never clobbering —
  every other key, foreign hook and event already there; unchecking it
  removes exactly kankaku's own entries. "Configured" now means both the
  statusLine and hooks are present and point at the same root; a partial
  state (only one of the two, or pointing at different roots) is reported
  with a detail (`doctor`/`setup --dry-run`) instead of being reported as
  done. The wizard's separate Claude Code step is gone (renumbered:
  Agents → Hub → Roots → Review → Apply → Done); a new
  `--claude-plugin-dir <dir>` flag (`setup`, `--yes`, `--dry-run`, and the
  wizard) and `KANKAKU_CLAUDE_PLUGIN_DIR` env var override the resolved
  plugin root for local development or a non-bundled checkout.

## 0.9.0 — 2026-09-28

### Changed

- Moved into the kankaku monorepo (`github.com/soyunninja/kankaku`,
  `packages/tui`); versions are now lockstep with the other client
  packages (`kankaku`, `kankaku-claude`). Depends on `kankaku ^0.9.0`. No
  behaviour change.

## 0.4.1 — 2026-09-28

### Fixed

- **`kankaku hub install`/`start`/`upgrade` no longer provision accounts
  against a foreign process holding the port**: when another process (not
  ours) already answers on the configured port, these commands used to
  spawn our own PocketBase anyway — it died immediately on the bind
  conflict, but `waitForHealth` kept polling the *foreign* server's
  `/api/health`, saw it answer, and went on to provision accounts against
  it, failing with a confusing `superuser authentication failed: HTTP
  400` and leaving a stale pid file pointing at a dead process. Before
  spawning, we now check that no pid of ours is alive and that
  `/api/health` doesn't already answer; if it does, the step fails
  immediately with `port <N> is already in use by another process — pass
  --port <N> or stop it`, without touching accounts or the pid file —
  reported as its own `start hub` step (which `install` now always
  prints, `done` on success), so a hub that cannot start is never
  mislabelled as an accounts problem. If
  the spawned process itself dies during startup (the same bind-conflict
  crash, or any other early exit), we stop waiting immediately instead of
  polling out the full 20s timeout, report the last `hub.log` line (e.g.
  `the hub exited during startup: listen tcp 127.0.0.1:8090: bind:
  address already in use`), and remove the stale pid file rather than
  leaving it claiming a dead process.
- **A previous hub's credentials could leak through the `.bak` backup**:
  `~/.kankaku/credentials.json` is written 0600, but the one-time backup
  `setup`'s writers make before overwriting an existing file
  (`json-writer.ts#backupOnce`) was created at the platform's default
  (umask-derived, typically world-readable) mode — so re-running `kankaku
  hub install`/`setup` left the *previous* hub's service account password
  readable by any local user in `credentials.json.bak`, even though the
  live file stayed owner-only. The backup now mirrors a 0600 source's
  mode, and an existing `.bak` from before this fix is tightened,
  best-effort, the next time its 0600 source is backed up again.

## 0.4.0 — 2026-09-28

### Added

- **Local hub**: `kankaku hub install [--port N] [--owner-email E]
  [--owner-password P]` installs and runs a real PocketBase hub under
  `~/.kankaku/hub/` — downloads and SHA256-verifies the PocketBase binary
  for this OS/CPU from the installed `kankaku-hub` package, copies its
  migrations/hooks/public into `app/<version>/`, provisions a superuser
  and the owner/service accounts, and leaves it running; idempotent on
  re-run. `kankaku hub start|stop|status|upgrade|logs [-n N]` round out
  the lifecycle (`upgrade` keeps `pb_data` untouched). The setup wizard's
  Hub step's `install locally` option now runs this same installer
  (asking for the owner email/password inline) instead of a checkout-based
  dev flow; that older flow is kept only behind `kankaku setup
  --from-checkout <dir>` for hub developers. The Dashboard's Hub card
  shows `local hub · running`/`stopped` for a local install, with a
  matching `h` quick action to start or stop it.

## 0.3.1 — 2026-09-28

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
