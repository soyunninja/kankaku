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

## Keys (TUI)

Tab bar: `1` Today, `2` Tasks, `3` Catalog, `4` Sync. `q` quits from any
screen.

- **Today** — `r` refresh.
- **Tasks** — `a` toggle today/all, `↑`/`↓` move the selection, `r` refresh.
- **Catalog** — `r` refresh from the hub.
- **Sync** — `↑`/`↓` move the selection, `s` sync the selected project,
  `f` full-sync the selected project, `S` sync every project. Each
  action's summary shows inline next to its row while it runs and once
  it settles.

The TUI never writes to disk on its own — Today, Tasks and read-only
Catalog views write nothing at all; Catalog's `refresh` and Sync's
`s`/`f`/`S` write only through kankaku's own adapters (`CachedCatalog`,
`SyncStateStore`, the hub itself), exactly as kankaku's own sync paths do.
