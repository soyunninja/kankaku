# kankaku-tui

A standalone terminal app, `kankaku`, that reads every project's
`.kankaku/worklog.jsonl` under a configurable list of roots and shows the
day across projects — the one view the [kankaku](https://kankaku.io) pi
panel cannot give, since it only ever sees the one project pi is running
in. Built with [Ink](https://github.com/vadimdemedes/ink) on Node 24. Four
screens — Dashboard, Tasks, Catalog and Sync — share one tab bar, and each
has a plain-text subcommand for scripts and cron.

## Install everything

```
npm i -g kankaku-tui
kankaku setup
```

`kankaku setup` detects every coding agent kankaku knows how to configure
on this machine (pi, gentle-shell, Claude Code — each by its own settings
file) and, for each one that already exists but isn't wired up, offers to
add it: `npm:kankaku` to a pi-family `packages` array, or Claude Code's
`statusLine` pointing at a `kankaku-claude` checkout. It also offers to
configure hub credentials (reusing `~/.kankaku/credentials.json` or the
`KANKAKU_PB_*` environment when either is already set) and writes this
app's own `~/.kankaku/tui.json`. Codex and OpenCode are detected and
reported, but kankaku has no adapter for either yet.

Every question has a sensible default; `kankaku setup --yes` accepts every
default without asking, and `kankaku setup --dry-run` prints the plan —
each step's state (`done`/`todo`/`unavailable`) and the exact file it
would change — without writing anything. Nothing is ever written without
either an explicit prompt answer or `--yes`. Before the first change to
any file, kankaku setup creates a `<file>.bak` next to it; re-running
`kankaku setup` is always safe, since it only ever writes what is still
missing or what you explicitly change.

`kankaku setup` ends with, and `kankaku doctor` prints on its own, the
same read-only report: one line per agent, one for the hub, one for
`tui.json`, and a `next: …` hint for anything still `todo`.

## Install

Until the next kankaku release, this package depends on the sibling
`kankaku` checkout via `file:../kankaku`, so both repos must sit next to
each other on disk. Run `npm install` inside `kankaku-tui/`.

Later, once published: `npm install -g kankaku-tui`. For now, run it from
this repo with `npm run dev`.

## Configuration

`~/.kankaku/tui.json`:

```json
{
  "roots": ["/absolute/path/to/workspace", "~/another-workspace"]
}
```

Each root is either a project itself (it has its own `.kankaku/worklog.jsonl`)
or a directory containing one or more projects as direct subdirectories.
`~` expands to the home directory. Missing or malformed config falls back
to the current working directory as the only root.

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

Every sync uploaded from here is stamped `plugin: kankaku-tui`; a task's
`agent` comes from its own orchestrator record when it carries one (see
kankaku's `hub-entry.ts`), else falls back to `agent: unknown` — this app
never guesses which coding agent produced someone else's worklog.

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
- `kankaku setup [--yes] [--dry-run]` — see "Install everything" above.
- `kankaku doctor` — the same read-only report `kankaku setup` ends with,
  without prompting or writing anything.

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
