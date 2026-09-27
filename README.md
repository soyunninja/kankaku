# kankaku-tui

A standalone terminal app, `kankaku`, that reads every project's
`.kankaku/worklog.jsonl` under a configurable list of roots and shows the
day across projects — the one view the [kankaku](https://kankaku.io) pi
panel cannot give, since it only ever sees the one project pi is running
in. Built with [Ink](https://github.com/vadimdemedes/ink) on Node 24. Four
screens — Today, Tasks, Catalog and Sync — share one tab bar, and each has
a plain-text subcommand for scripts and cron.

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

- `kankaku` — opens the interactive TUI on the Today screen.
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

`--roots` (on `today`/`tasks`) overrides the configured roots for that run.

## Screens

One visual system drives all four screens: a left sidebar for navigation,
titled bordered panels, aligned tables with a highlighted selection, text
bars and sparklines, a header line and a footer of key hints — all driven
by a single theme of colour roles (`src/ui/theme.ts`). The app runs
fullscreen, in the terminal's alternate screen buffer: the frame fills the
whole terminal height, resizing live with the terminal. The sidebar sits
beside the screen at 100+ terminal columns, stacks full-width above it at
70-99 columns, and collapses to a one-line tab strip below 70 columns; a
selected row or card is always marked with a visible `›`, never colour
alone.

Any list that can grow past the available height (the Tasks table, the
Catalog Clients/Projects lists, the Today Projects table, the Sync card
grid) scrolls instead of overflowing the terminal: the viewport follows
the current selection, and a `↑ N more` / `↓ N more` line marks rows
hidden above or below it.

Today is a dashboard: a Today card (work/wait/cost/tasks/cache hit), a
Last 7 days card (work and cost sparklines with weekday labels), a
Projects table (work, cost and a share bar per project) and a Hub card
(pending/stale, last sync time, catalog summary):

```
 >_ kankaku 0.1.0                              hub ● kankaku.soyun.ninja · synced 08:20
┌──────────────┐ ╭─[ Today ]────────────────────╮ ╭─[ Last 7 days ]──────────────────╮
│ › Today      │ │   work   1h 42m               │ │ work  ▂▅▇▃▁▆█   cost  ▁▃▆▂▁▅█    │
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

Tab bar: `1` Today, `2` Tasks, `3` Catalog, `4` Sync. `q` quits from any
screen. The app fills the whole terminal; every scrolling list (Tasks,
Catalog's Clients/Projects, Today's Projects, Sync's cards) additionally
takes `PageUp`/`PageDown` to move a full window at a time and `Home`/`End`
to jump to the first/last row.

- **Today** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the Projects
  selection, `enter` opens the selected project in Tasks (filtered to
  it), `r` refresh.
- **Tasks** — `a` toggle today/all, `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End`
  move the selection, `r` refresh, `esc` clears a project filter set from
  Today.
- **Catalog** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the client
  selection, `r` refresh from the hub.
- **Sync** — `↑`/`↓`/`PageUp`/`PageDown`/`Home`/`End` move the selection,
  `s` sync the selected project, `f` full-sync the selected project, `S`
  sync every project. Each action's summary shows inline in its card
  while it runs and once it settles.

The TUI never writes to disk on its own — Today, Tasks and read-only
Catalog views write nothing at all; Catalog's `refresh` and Sync's
`s`/`f`/`S` write only through kankaku's own adapters (`CachedCatalog`,
`SyncStateStore`, the hub itself), exactly as kankaku's own sync paths do.
