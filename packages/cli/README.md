# kankaku

A standalone terminal app, `kankaku`, that reads every project's
`.kankaku/worklog.jsonl` under a configurable list of roots and shows the
day across projects — the one view the [kankaku](https://kankaku.io) pi
panel cannot give, since it only ever sees the one project pi is running
in. Built with [Ink](https://github.com/vadimdemedes/ink) on Node 24. Four
screens — Dashboard, Tasks, Catalog and Sync — share one tab bar, and each
has a plain-text subcommand for scripts and cron.

This package lives in the [kankaku monorepo](https://github.com/soyunninja/kankaku),
under `packages/cli`. It was published as `kankaku-tui` up to 0.12.1; the
`kankaku` npm name is now this package (the pi extension moved to
`kankaku-pi`).

## Install everything

```
npm i -g kankaku
kankaku setup
```

`npm i -g kankaku` installs the `kankaku` command, the bundled Claude Code
plugin (`kankaku-claude`) and the pi extension. The extension is carried
inside the tarball, under `vendor/kankaku-pi/`, and the package's `pi`
manifest points at it, so `pi install npm:kankaku` also works and loads
exactly the extension `kankaku-pi` ships. It is vendored rather than
declared as a dependency because pi installs npm packages into one shared
directory with a flat `node_modules`: a dependency of `kankaku` would not
sit next to it, and pi could not find the extension.

If you only use pi and do not want the dashboard, install the light
package instead: `pi install npm:kankaku-pi`.

### Do not load the extension twice

The extension is reachable through several sources: `npm:kankaku-pi`,
`npm:kankaku`, the `git:github.com/soyunninja/kankaku` repository and a
local checkout. Listing more than one of them in the same pi settings file
loads the extension more than once and doubles every measurement.
`kankaku doctor` reports it (`pi: todo — loaded 2 times: npm:kankaku,
npm:kankaku-pi`), and `kankaku setup` repairs it, keeping exactly one
source by this precedence: a local path, then `npm:kankaku-pi`, then a
`git:` source, then `npm:kankaku`. Nothing else in the file is touched and
the original is saved once as `settings.json.bak`. An install with only
`npm:kankaku` is configured and is left as it is; new installs write
`npm:kankaku-pi`. Entries in pi's object form
(`{ "source": "npm:kankaku-pi", "extensions": [...] }`) count as well.
Unchecking pi in the wizard removes every kankaku source.

### Migrating from `kankaku-tui`

`kankaku-tui` is retired and its package is deprecated in favour of
`kankaku`. Both packages provide the `kankaku` command, so uninstall the
old one first, then install the new one and run setup again:

```
npm uninstall -g kankaku-tui
npm i -g kankaku
kankaku setup
```

On a real terminal, `kankaku setup` opens as a full-screen wizard — one
step at a time, in the same header/panel/footer look as the rest of the
app (there's no sidebar in the wizard itself: the panel's own title
tracks progress instead, e.g. `Setup · Agents 1/4`). `kankaku` with no
arguments does the same the very first time (no `~/.kankaku/tui.json`
yet); after that first run it opens straight into the Dashboard as usual.

The wizard's steps, `enter` to advance and `esc` to go back throughout
(`esc` at the first step, Agents, quits):

1. **Agents** — a checklist (`space` toggles) that also carries detection
   for every agent kankaku knows about: pi, gentle-shell and Claude Code
   each show `configured (<path, shortened with ~>)` or `not configured`;
   pre-checked means already configured, and unchecking a configured
   agent schedules removing kankaku from it, not just skipping it. Codex
   and OpenCode are listed but disabled, showing `no adapter yet` (found,
   but kankaku can't write its config) or `not installed` (not found).
   Checking Claude Code needs no extra step or path — see "Claude Code"
   below.
2. **Hub** — `use an existing hub` (URL, email, masked password, a `c`
   inline health check, reusing the current credentials as the default),
   `install locally`, or `skip`. Installing locally asks for the owner's
   email and password and a `port` (digits only, 1024-65535), then runs
   the same installer as `kankaku hub install` (see "Local hub" below): no
   `kankaku-hub` checkout is needed. The port field starts at the first
   free port from 8090 upwards (or at the port of an existing install)
   and rejects a port that is in use inline (`port <N> is in use`). The
   Review step says what happens to the sync credentials: either
   `sync credentials → the local hub`, or `sync credentials stay on <url>
   (switch later with kankaku hub use)` when this machine already syncs to
   another hub.
3. **Roots** — the comma-separated project roots, defaulting to the
   current `tui.json` (or the parent of the current directory the first
   time). See "Configuration" below for how deep each root is searched.
4. **Review** — the plan: one line per change, with the exact file it
   touches. `enter` applies it.
5. **Apply** — runs each change and shows its result
   (`wrote`/`unchanged`/`removed`/`started`/`error: …`) as it happens.
6. **Done** — a summary, then `enter` opens the Dashboard in place — no
   restart.

### Claude Code

Checking Claude Code (in the wizard, or answering yes in `kankaku setup`'s
non-interactive flow) writes two things into `~/.claude/settings.json`,
merged in — every other key, every foreign hook and every other event is
left untouched — and installs the slash commands:

- `statusLine.command`, so Claude Code reports per-prompt cost.
- `hooks` for every event the bundled `kankaku-claude` plugin declares
  (`packages/claude/hooks/hooks.json`), so the plugin actually measures
  time even when Claude Code is started as plain `claude` — **no
  `--plugin-dir` flag needed**.

It also installs the `/kankaku:*` slash commands (`/kankaku:report`,
`/kankaku:status`, `/kankaku:task`, `/kankaku:sync`, …) as user commands under
`~/.claude/commands/kankaku/<name>.md`, generated from the plugin's own
`commands/*.md` with the plugin's absolute install path filled in. Setup
lists each file it wrote or left unchanged; `kankaku doctor` reports Claude
Code as configured only when the installed state equals what the plugin
expects: the exact statusLine command, every hook event in the plugin's
`hooks/hooks.json` with the same command, matcher and timeout, and every
command file byte-identical to the generated one, with no stale generated
file left. Anything else is `todo`, and the note names what is wrong (for
example `hooks missing: Stop, SessionEnd; commands missing: sync; commands
outdated: status`), including after an upgrade that adds a command or hook
event. `kankaku setup --yes` reconciles a selected Claude Code every time,
so a damaged or outdated install is repaired. A file in that directory that kankaku did not
generate is never overwritten or removed, and setup says so. **Re-run
`kankaku setup` if the install path changes** — for example after switching
Node versions, which moves the global `node_modules`.

`kankaku` depends on `kankaku-claude` directly (lockstep, same as its
`kankaku-pi`/`kankaku-hub` dependencies), so the plugin's files ship inside
every `kankaku` install; setup resolves their location on disk itself.
There is nothing to check out and no second `npm install`.

**If you previously ran Claude Code with `--plugin-dir <checkout>` to load
kankaku-claude, drop that flag once `kankaku setup` has configured Claude
Code** — the hooks it now writes into `settings.json` run on every Claude
Code launch regardless, so a `--plugin-dir` load on top of that would run
the hooks twice and double-write worklog records. The `/kankaku:*` slash
commands do not need it either: setup installs them as user commands.

Unchecking Claude Code (or removing it from an already-configured
machine) removes exactly kankaku's own statusLine and hooks entries,
leaving everything else in `settings.json` untouched, and removes the
generated command files (plus the `kankaku/` directory once it is empty,
and never anything else under `~/.claude/commands`).

**Overriding the plugin root.** For local development, or to point at a
different kankaku-claude checkout, pass `--claude-plugin-dir <dir>` to
`kankaku setup`/`kankaku setup --yes`/`kankaku setup --dry-run`, or set
`KANKAKU_CLAUDE_PLUGIN_DIR`. The flag/env value must be a directory
containing `hooks/hooks.json` and a built `dist/hook.js` (i.e. a
`kankaku-claude` checkout or `packages/claude` in a kankaku monorepo
checkout, after `npm install && npm run build` in it — Node cannot run a
plugin's `.ts` sources directly once they are outside a fresh checkout,
so setup reports "run npm run build in `<dir>` first" when the build is
missing). Without either, setup resolves the bundled package
automatically — most users never need this.

`kankaku setup --yes` and `kankaku setup --dry-run` stay exactly as
before: non-interactive, driven by argv/env only, never opening the
wizard (even on a TTY). `--yes` accepts every question's own default
without asking; `--dry-run` prints the plan — each step's state
(`done`/`todo`/`unavailable`) and the exact file it would change —
without writing anything. Nothing is ever written without either an
explicit answer (in the wizard or the `--yes`/readline flow) or `--yes`
itself. Before the first change to any file, kankaku setup creates a
`<file>.bak` next to it; re-running `kankaku setup` in any form is always
safe, since it only ever writes what is still missing or what you
explicitly change.

`kankaku setup` ends with, and `kankaku doctor` prints on its own, the
same read-only report: one line per agent, one for the hub, one for
`tui.json`, and a `next: …` hint for anything still `todo`.

## Install

```
npm install -g kankaku
```

Then run `kankaku setup` (or just `kankaku` the first time) to configure
the coding agents on this machine, the hub and your project roots. The
package depends on the published `kankaku-pi` library (`kankaku-pi/domain`,
`kankaku-pi/hub`), on `kankaku-hub` for the local hub installer, and on
`kankaku-claude` for the bundled Claude Code plugin files (see "Claude
Code" above); nothing else needs to be checked out. To work on this repo
itself, run `npm install` inside it and `npm run dev`.

## Configuration

`~/.kankaku/tui.json`:

```json
{
  "roots": ["/absolute/path/to/workspace", "~/another-workspace"]
}
```

### Projects across roots

Each root is searched recursively for projects, up to 5 directory levels
below it by default: a directory is a project once it has its own
`.kankaku/worklog.jsonl` — including the root itself — and the search
still continues below it, so a stray worklog in a parent directory (a pi
session run once in `~/desarrollo`) never hides the projects beneath;
every directory is listed at most once. Subdirectories are searched one
level deeper, skipping `node_modules`, `.git` and any hidden
(dot-prefixed) directory. This lets one root cover a whole workspace, e.g.
`~/desarrollo` finding every project under `~/desarrollo/<client>/<project>`
without listing each one. Projects are deduped by real (symlink-resolved)
path and sorted by name — the directory's basename, or the last two path
segments joined with `/` when two discovered projects share a basename
(e.g. `clientA/shared` and `clientB/shared`). `~` expands to the home
directory. Missing or malformed config falls back to the current working
directory as the only root.

### Hub credentials (Catalog and Sync)

The Catalog and Sync screens (and their subcommands) talk to the same
PocketBase hub kankaku itself syncs to, through kankaku's own
`resolveHubCredentials`: `~/.kankaku/credentials.json`

```json
{
  "url": "https://your-hub.example.com",
  "email": "you@example.com",
  "password": "…"
}
```

or the environment (env takes precedence per field over the file):

- `KANKAKU_PB_URL`, `KANKAKU_PB_EMAIL`, `KANKAKU_PB_PASSWORD`
- `KANKAKU_SYNC_WINDOW_HOURS` — revisit window for `sync`/`sync status` (default 24)
- `KANKAKU_SYNC_PROMPT` — `none` (default), `truncated` or `full`
- `KANKAKU_SYNC_RECORDS` — set to `0` to skip uploading individual `work_records`
- `KANKAKU_MACHINE` — overrides the reported hostname

Without credentials, the Catalog and Sync screens show a one-line note
instead of a list; `kankaku catalog` and `kankaku sync status` print the
same note and exit 0 (no network attempted); `kankaku catalog refresh` and
`kankaku sync`/`kankaku sync all` print an error and exit 1.

Every sync uploaded from here is stamped `plugin: kankaku-tui` (the identifier is kept from before the rename so existing rows stay consistent); a task's
`agent` comes from its own orchestrator record when it carries one (see
kankaku's `hub-entry.ts`), else falls back to `agent: unknown` — this app
never guesses which coding agent produced someone else's worklog.

### Local hub

Instead of pointing at someone else's PocketBase, `kankaku hub install`
sets up and runs your own hub on this machine, under `~/.kankaku/hub/`:

- `bin/pocketbase` — the PocketBase binary for this OS/CPU, downloaded
  from the `kankaku-hub` npm package's manifest and SHA256-verified.
- `pb_data/` — the hub's own database; never touched by an upgrade.
- `app/<version>/` — a fresh copy of that package version's migrations,
  hooks and static files (never a symlink, so `npm update` can't change a
  running hub out from under it); `current` names the active version.
- `hub.json` — the installed port and versions.
- `accounts.json` (owner-only, `0600`) — the PocketBase superuser email
  and generated password, and the owner account's email. The owner logs
  into the hub's own web admin UI with that owner account.
- `service.json` (owner-only, `0600`) — the generated `service` account
  (`kankaku-sync@kankaku.local`) as `{ url, email, password }`. Install
  always writes it.

Install never repoints where this machine syncs on its own.
`~/.kankaku/credentials.json` (the file this app and kankaku's own sync
read) is written by install only when it does not exist yet, or when its
`url` already is this local hub's (same host and port). When it points at
another hub it is left untouched, and the install report says so with a
`sync credentials` step: `this machine syncs to <url>; run 'kankaku hub
use' to switch to the local hub`. `kankaku hub use` is the explicit
switch.

Commands (macOS and Linux only — PocketBase ships no other build):

- `kankaku hub install [--port N] [--owner-email E] [--owner-password P]`
  — installs (or, run again, verifies) the hub and leaves it running. On
  a real terminal, a missing owner email/password is prompted for
  (masked); without a TTY, both flags are required. Idempotent: re-running
  with everything already in place changes nothing, and an existing
  install keeps its recorded port. Without `--port`, a fresh install uses
  8090 when it is free; when it is not, install fails (exit 1) with `port
  8090 is already in use — try: kankaku hub install --port <first free>`
  and never picks a port silently. A `--port` that is taken fails the same
  way, with the existing message plus the suggestion; a `--port` that is
  not a whole number between 1 and 65535 is a usage error. The check binds
  `127.0.0.1:<port>` before anything is downloaded or created, and the
  pre-spawn health check still runs after it. `start` and `upgrade` refuse
  with `port <N> is already in use by another process — pass --port <N> or
  stop it` when a foreign process holds the recorded port. Re-running
  install on a hub made by an older version, which has no `service.json`,
  writes it when the service password is still known (it is in
  `credentials.json`); otherwise it says the password is not recoverable
  and does not invent one.
- `kankaku hub use` — points `~/.kankaku/credentials.json` at the local
  hub, from `service.json` (the previous file is kept once as
  `credentials.json.bak`, mode `0600`) and prints `sync now points at
  <local url> (was <previous url>)`. Running it again reports `unchanged`.
  It fails (exit 1) when no local hub is installed or `service.json` is
  missing.
- `kankaku hub start` / `kankaku hub stop` — start or stop the server
  process; `stop` is a no-op when it isn't running.
- `kankaku hub status` — `local hub: running 0.2.0 (PocketBase 0.40.4) at
  http://127.0.0.1:8090 · pb_data 1.2 MB`, `stopped`, or `not installed`,
  followed by where this machine's sync points: `sync: local hub`,
  `sync: <other url>` or `sync: not configured`.
- `kankaku hub upgrade` — copies a fresh `app/<version>/` from the
  currently installed `kankaku-hub` package, downloads a new PocketBase
  binary only if that version changed, and restarts — `pb_data` is never
  touched.
- `kankaku hub logs [-n N]` — the last `N` (default 50) lines of
  `hub.log`.

The Dashboard's Hub card shows `local hub · running`/`stopped` when the
configured hub is this machine's own local install, with a matching `h`
quick action to start or stop it. The setup wizard's Hub step's
`install locally` option runs this same installer (asking for the owner
email/password inline); the older checkout-based dev install
(`kankaku-hub`'s own `scripts/dev.sh`) is still available for hub
developers via `kankaku setup --from-checkout <dir>`.

## Usage

- `kankaku` — opens the interactive TUI on the Dashboard screen.
- `kankaku today [--roots a,b]` — today's work per project, plain text.
- `kankaku tasks [--all]` — every task's line (kankaku's own `formatTasks`),
  grouped under a `== <project> ==` header per project; restricted to
  today unless `--all`.
- `kankaku catalog [refresh]` — without `refresh`, reports the locally
  cached client/project counts (no network); `refresh` fetches a fresh
  snapshot from the hub and caches it to `~/.kankaku/catalog.json`.
- `kankaku sync [status|all] [--project <dir>]` — `status` reports the
  pending count and last sync per project, no network; with no argument,
  syncs the pending window; `all` does a full resync. Defaults to every
  discovered project, sequentially; `--project <dir>` restricts to one.
- `kankaku setup [--yes] [--dry-run] [--from-checkout <dir>]` — see
  "Install everything" above; `--from-checkout` is the hub-developer-only
  checkout-based local hub install, see "Local hub" above.
- `kankaku doctor` — the same read-only report `kankaku setup` ends with,
  without prompting or writing anything.
- `kankaku hub install|use|start|stop|status|upgrade|logs` — the local
  hub's lifecycle; see "Local hub" above.
- `kankaku --version`, `kankaku -v` or `kankaku version` — prints `kankaku
  <version>` and, indented, the version of each package it carries
  (`kankaku-pi`, `kankaku-claude`, `kankaku-hub`), or `not found` for one
  that cannot be resolved; exit 0.

`--roots` (on `today`/`tasks`) overrides the configured roots for that run.

`--theme <name>` picks one of the three built-in colour presets for the
interactive TUI; `KANKAKU_TUI_THEME=<name>` does the same through the
environment (the flag wins when both are given). The valid names are
`gentleman-sexy` (the default), `gentleman-cute` and `gentle` — resolved
hex values copied from [gentle-pi](https://github.com/Gentleman-Programming/gentle-pi)'s
own themes (MIT), so this TUI matches the owner's pi panel instead of an
unrelated default. An unknown name prints a usage error listing the valid
names and exits 1 without opening the TUI.

## Screens

One visual system drives all four screens: a left sidebar for navigation,
titled bordered panels, aligned tables with a highlighted selection, text
bars and sparklines, a header line and a footer of key hints — all driven
by a single theme of colour roles (`src/ui/theme.ts`, see `--theme` above
for the three built-in presets). The app runs fullscreen, in the
terminal's alternate screen buffer: the frame fills the whole terminal
height, resizing live with the terminal. The sidebar sits beside the
screen at 100+ terminal columns, stacks full-width above it at 70-99
columns, and collapses to a one-line tab strip below 70 columns; a
selected row or card is always marked with a visible `›`, never colour
alone. The sidebar itself shows which zone has focus: its border switches
to the active border colour and the active item gets a full-row highlight
when it has focus, dropping back to a plain `›` marker with no highlight
once focus moves to the screen's own content.

Every panel in the main area is sized to a fixed height derived from the
terminal's own height, so it never grows with its content and shifts the
rest of the screen — a long value (e.g. the Tasks screen's full prompt)
is wrapped and, if it still doesn't fit the panel's fixed height, clipped
with a trailing `… N more lines` note instead of silently overflowing or
pushing the header out of view.

Any list that can grow past the available height (the Tasks table, the
Catalog Clients/Projects lists, the Dashboard Projects table, the Sync
card grid) scrolls instead of overflowing the terminal: the viewport
follows the current selection, and a `↑ N more` / `↓ N more` line marks
rows hidden above or below it.

Dashboard is the app's home screen: a Today card (work/wait/cost/tasks/
cache hit — it shows today's numbers, hence its own title), a Last 7 days
card (work and cost sparklines with weekday labels), a Projects table
(work, cost and a share bar per project), a Hub card (pending/stale, last
sync time, catalog summary) and a Quick actions panel (`c` refresh the
catalog, `s` sync every project, `S` full-sync every project, `r` reload):

```
 >_ kankaku 0.1.0                              hub ● kankaku.soyun.ninja · synced 08:20
┌──────────────┐ ╭─[ Today ]────────────────────╮ ╭─[ Last 7 days ]──────────────────╮
│ › Dashboard  │ │   work   1h 42m               │ │ work  ▂▅▇▃▁▆█   cost  ▁▃▆▂▁▅█    │
│   Tasks      │ │   wait      6m   cost  $9.83  │ │ mon tue wed thu fri sat sun       │
│   Catalog    │ │   tasks 12       cache hit 68%│ ╰──────────────────────────────────╯
│   Sync       │ ╰──────────────────────────────╯ ╭─[ Hub ]──────────────────────────╮
│              │ ╭─[ Projects ]────────────────────────────╮ │ pending 1 · stale 0     │
│              │ │ project       work    cost   share      │ │ last sync ok 08:20      │
│              │ │ kankaku       1h 02m  $6.49  ████████░░ │ │ catalog 9 clients ·     │
│              │ │ kankaku-tui     31m   $2.10  █████░░░░░ │ │         17 projects     │
│              │ │ kankaku-hub      9m   $1.24  ██░░░░░░░░ │ ╰─────────────────────────╯
│              │ ╰─────────────────────────────────────────╯
├──────────────┤
│ roots 1      │
│ projects 3   │
└──────────────┘
 ↑↓ move   enter open   r refresh   1-4 screens   q quit
```

The Quick actions panel sits below the Hub card in wide mode (100+
columns), or right after the Projects table in stacked mode (70-99
columns):

```
╭─[ Quick actions ]────────────────╮
│ c  refresh catalog               │
│ s  sync all projects             │
│ S  full sync all                 │
│ r  reload                        │
│ catalog: 9 clients · 17 projects │
╰──────────────────────────────────╯
```

The bottom line is the status line: empty until the first action runs,
`… <label>` while one is running, its result message once it settles
(e.g. the catalog refresh above, or a sync summary), `error: <message>`
if it failed, or `hub not configured (~/.kankaku/credentials.json)` when
the hub has no credentials — in which case `c`/`s`/`S` do nothing.

- **Tasks** — a table (time, project, work, cost, prompt) with a
  highlighted row on the left, and a `[ Task ]` detail panel on the right
  showing the selected row's full prompt, client, project, hub task,
  wall/work/wait time, cost, cache hit and subagent count.
- **Catalog** — `[ Clients ]` on the left; the selected client's
  `[ Projects ]`, with open/doing hub task counts, on the right. The
  Clients panel header shows the cache's age and a `(stale)` flag.
- **Sync** — one card per project in a wrapping grid; the selected card is
  highlighted, and each action's result line shows inside its card while
  it runs and once it settles.

## Keys (TUI)

The app has two focus zones — the sidebar and the active screen's own main
content — and one of them always has focus (`domain/nav-model.ts`'s
`NavState.focus`, starting on the sidebar). `1`-`4` switch the Dashboard/
Tasks/Catalog/Sync tab bar and `q` quits from anywhere, in either zone; every
other key belongs to whichever zone currently has focus, so a screen's own
list never moves by accident while you are still picking a screen.

- **Sidebar focused** (the app's own starting state) — `↑`/`↓` move
  between screens, and the screen switches as you move, so you see each
  one before committing to it. `enter`, `→` or `Tab` focus the main zone
  (the screen you last landed on).
- **Main zone focused** — the active screen's own keys work as below.
  `←` or `Tab` return focus to the sidebar. `esc` also returns to the
  sidebar, unless the screen consumes it first: on Tasks with a project
  filter set (from Dashboard's `enter`), the first `esc` clears the filter
  and the next `esc` returns to the sidebar.

The focused zone is visible in the frame: the sidebar's active-item marker
is in the accent colour when the sidebar is focused and muted otherwise,
the focused screen's primary panel gets the accent border, and the footer
key hints change — the sidebar's own hints while it is focused, the
screen's hints plus `← menu` while the main zone is focused.

The app fills the whole terminal; every scrolling list (Tasks, Catalog's
Clients/Projects, Dashboard's Projects, Sync's cards) additionally takes
`PageUp`/`PageDown` to move a full window at a time and `Home`/`End` to
jump to the first/last row.

- **Dashboard** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the
  Projects selection, `enter` opens the selected project in Tasks
  (filtered to it), `r` refresh; the Quick actions panel additionally
  takes `c` (refresh catalog), `s` (sync all projects) and `S` (full sync
  all) — one at a time, ignored while another is running.
- **Tasks** — `a` toggle today/all, `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End`
  move the selection, `r` refresh, `esc` clears a project filter set from
  Dashboard.
- **Catalog** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the client
  selection, `r` refresh from the hub.
- **Sync** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the selection,
  `s` sync the selected project, `f` full-sync the selected project, `S`
  sync every project. Each action's summary shows inline in its card
  while it runs and once it settles.

The TUI never writes to disk on its own — Dashboard, Tasks and read-only
Catalog views write nothing at all; Catalog's `refresh`, Sync's
`s`/`f`/`S` and Dashboard's Quick actions `c`/`s`/`S` write only through
kankaku's own adapters (`CachedCatalog`, `SyncStateStore`, the hub
itself), exactly as kankaku's own sync paths do.
