# kankaku-claude

A [Claude Code](https://claude.com/claude-code) plugin that records how long
Claude Code works on each of your prompts, in the same worklog format as the
[kankaku](https://kankaku.io) pi extension.

## What it measures

One record per user prompt, appended to `<KANKAKU_DIR>/worklog.jsonl`:

- **Wall time** — from the moment you submit a prompt to the moment Claude
  Code settles it.
- **Waiting time** — time spent inside an `AskUserQuestion` tool call or
  waiting on a permission dialog.
- **Work time** — wall time minus waiting time.
- **Cost** — the prompt's share of the session's running `total_cost_usd`
  (see "Limitations" below for how this is derived).

Records are written in kankaku's own `WorkRecord` schema
(`WORK_RECORD_SCHEMA = 1`), the exact one the kankaku pi extension writes to
its own `worklog.jsonl`. This means kankaku's existing report and export
tooling can read this plugin's worklog unchanged. kankaku-claude also exposes
manual and best-effort automatic hub sync through kankaku's public hub adapters (below).

## Requirements

- Claude Code with plugin support.
- Node.js >= 24 on `PATH` (this package's `.ts` sources run directly under
  Node's built-in type stripping; there is no build step).

## Install

**From a local path (development).** Clone this repository, then point
Claude Code at it directly:

```bash
claude --plugin-dir /path/to/kankaku-claude
```

If your Claude Code version does not recognize `--plugin-dir`, or plugin
loading has changed since this was written, check your installed version's
own plugin documentation (`claude --help`, or `/plugin` inside a session) for
the current local-install flow.

**From a marketplace.** Once this plugin is published to a marketplace:

```
/plugin marketplace add <marketplace-source>
/plugin install kankaku@<marketplace-name>
```

On install, if `package.json` and `package-lock.json` are both present (as
they are here), Claude Code runs `npm ci --ignore-scripts` for you; a failure
there never blocks the plugin from loading.

## The manual step you cannot skip

Claude Code plugins cannot set `statusLine` for themselves — there is no
programmatic way for a plugin to add a `statusLine` entry to your settings.
The statusline is also the *only* documented source of per-prompt cost
(`cost.total_cost_usd`); hooks never receive it. So, once installed, run:

```
/kankaku:setup
```

and paste the printed `statusLine` block into `~/.claude/settings.json`
(merge it with whatever is already there rather than overwriting the file).
Without this step, kankaku-claude still records wall/waiting/work time, but
every record's cost stays unset.

Because this settings.json entry is global, the statusline command runs in
every Claude Code session on the machine, plugin loaded or not — including
projects that never installed kankaku-claude. It writes only to
`~/.kankaku/claude/cost/<session_id>.json` (never under any project) and
only reads a project's own state file, so an unrelated session never leaves
anything behind in whatever project happens to be open.

## Commands

- `/kankaku:report` — a report of recent work, grouped by day (wraps
  `node src/cli.ts report`).
- `/kankaku:status` — the sessions kankaku-claude currently has state for:
  session id, whether its process is still alive, whether a prompt is open,
  and the last cost the statusline reported (wraps `node src/cli.ts status`).
- `/kankaku:setup` — prints the `statusLine` snippet described above (wraps
  `node src/cli.ts setup`).
- `/kankaku:sync` — manually syncs recent local work records to the hub
  (wraps `node src/cli.ts sync`; the slash command does not forward arguments).
- `/kankaku:sync-status` — inspects local pending counts and sync state
  (wraps `node src/cli.ts sync status`; no hub request or credentials required).
- `/kankaku:sync-all` — requests a full sync (wraps `node src/cli.ts sync all`).

The report, status, and setup subcommands are also available directly via
`node src/cli.ts <report|status|setup>`; `report` accepts `--days N` and
defaults to the last 7 days.

### Manual hub sync

Configure hub credentials with `KANKAKU_PB_URL`, `KANKAKU_PB_EMAIL`, and
`KANKAKU_PB_PASSWORD`, or use `~/.kankaku/credentials.json` (the shared
kankaku hub credential file). Then run `/kankaku:sync` for recent records or
`/kankaku:sync-all` for a full sync in the project whose worklog you want to
upload. Use `/kankaku:sync-status` to inspect local sync state without a hub
request or credentials. The same operations are available directly via CLI:

| Command | Purpose |
|---------|---------|
| `node src/cli.ts sync` | Manually sync the recent window (24 hours by default). |
| `node src/cli.ts sync all` | Request a full sync. |
| `node src/cli.ts sync status` | Inspect local pending counts and sync state; no hub network request or credentials required. |

Optional environment settings:

| Variable | Effect |
|----------|--------|
| `KANKAKU_MACHINE` | Machine label for uploaded records (defaults to the host name). |
| `KANKAKU_SYNC_PROMPT` | Prompt privacy: omitted by default; set `truncated` or `full` to include prompts. |
| `KANKAKU_SYNC_WINDOW_HOURS` | Recent sync window in hours (defaults to 24). |
| `KANKAKU_SYNC_RECORDS` | Set to `0` to disable uploading raw `work_records` children; consolidated `task_entries` still sync. |
| `KANKAKU_SYNC_AUTO` | Set to `0` to disable automatic sync; manual sync remains available. |
| `KANKAKU_SYNC_MIN_INTERVAL_MINUTES` | Minimum interval between automatic per-prompt attempts (defaults to 5; `0` disables throttling). |

### Automatic hub sync

With valid hub credentials, heavy hooks attempt a best-effort sync at session start
(after recovery), after each settled prompt has been appended, and on session end
(after any interrupted record is appended, before cleanup). Missing/invalid
credentials silently skip automatic sync. Failures are reported on stderr but
never prevent local worklog writes or session cleanup. Prompt privacy, machine,
window, and record settings above apply to both manual and automatic sync.
Automatic runs use kankaku's change detection and per-prompt throttle; session
boundaries are not throttled. Set `KANKAKU_SYNC_AUTO=0` to opt out.

## Where the files live

- `<KANKAKU_DIR>/worklog.jsonl` — the append-only log of settled records,
  shared with (and readable by) kankaku's own tooling.
- `<KANKAKU_DIR>/claude/<session_id>.events.jsonl` and
  `<KANKAKU_DIR>/claude/<session_id>.state.json` — kankaku-claude's own
  per-session working files (event log and small state file). These are
  implementation detail, not part of the shared worklog format, and are
  cleaned up once a session ends. Only the hooks ever write this state file;
  the statusline command only reads it (see below).
- `~/.kankaku/claude/cost/<session_id>.json` — the per-session cost the
  statusline last reported, **always under your home directory, never under
  a project.** The statusline command is wired into `~/.claude/settings.json`
  globally, so it runs on every Claude Code session on the machine; writing
  cost next to a project's own state file would litter whatever project
  happens to be open with another session's data. This directory is
  owner-only (`0700`), each cost file is `0600`, and a file older than 7
  days is swept on the next `SessionStart`.

`KANKAKU_DIR` defaults to `.kankaku` (relative to the session's working
directory); set the `KANKAKU_DIR` environment variable to use an absolute
path or a different relative one, exactly as the pi extension does.

## Crash recovery

If Claude Code's process is killed mid-prompt (or mid-session), the next
session's `SessionStart` hook scans for other sessions' state files whose
process is no longer alive. A dead session with an open prompt is replayed
and appended as one `status: "interrupted"` record before its files are
deleted; a dead session with no open prompt just has its files deleted. This
also runs for the current session's own leftover state at `SessionEnd`.

## Limitations

- **`turns` is always 1 per run.** Claude Code hooks give no way to observe
  provider-level retries/turns inside one run; every replayed run reports
  exactly one turn.
- **No token counts.** Hooks never carry input/output/cache token numbers,
  only the statusline's aggregate `total_cost_usd`; per-record `usage` token
  fields stay at zero, cost is the only populated figure.
- **Cost is a per-prompt delta of the session total, from the statusline,
  and needs the manual setup step.** A tiny race is possible: the statusline
  can render after `Stop` has already computed the delta, in which case a
  sliver of one prompt's cost is attributed to the next prompt instead.
- **A permission wait ends at the next hook event, not when you actually
  click.** There is no documented hook that fires the moment you answer a
  permission dialog, so the waiting span closes at whatever hook fires next
  (typically the tool's own `PreToolUse`), not at the click itself.
- **A background `Agent`/`Task` subagent span ends when the tool call
  returns, not when the subagent actually finishes.** Claude Code does not
  document a link between a `SubagentStart`/`SubagentStop` pair and the
  `tool_use_id` that launched it, so kankaku-claude cannot join them; the
  subagent's own time is not separately measured here.
- **Hub sync is best-effort.** Use `/kankaku:sync` to retry recent records or
  `/kankaku:sync-all` to request a full sync. Prompts are omitted from uploads
  unless `KANKAKU_SYNC_PROMPT` is `truncated` or `full`.

See [kankaku.io](https://kankaku.io) for the pi extension this plugin shares
its worklog format with.
