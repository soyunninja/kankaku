# kankaku-tui

A standalone terminal app, `kankaku`, that reads every project's
`.kankaku/worklog.jsonl` under a configurable list of roots and shows the
day across projects — the one view the [kankaku](https://kankaku.io) pi
panel cannot give, since it only ever sees the one project pi is running
in. Built with [Ink](https://github.com/vadimdemedes/ink) on Node 24.

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

## Usage

- `kankaku` — opens the interactive TUI, showing today's work across every
  discovered project.
- `kankaku today [--roots a,b]` — prints the same rows as plain text, for
  scripts and cron; `--roots` overrides the configured roots for this run.

## Keys (TUI)

- `r` — refresh
- `q` — quit

The TUI is read-only: it never writes to disk.
