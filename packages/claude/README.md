# kankaku-claude

A [Claude Code](https://claude.com/claude-code) plugin that records how long
Claude Code works on each of your prompts, in the same worklog format as the
[kankaku](https://kankaku.io) pi extension.

This package lives in the [kankaku monorepo](https://github.com/soyunninja/kankaku),
under `packages/claude`.

## What it measures

One record per user prompt, appended to `<KANKAKU_DIR>/worklog.jsonl`:

- **Wall time** — from the moment you submit a prompt to the moment Claude
  Code settles it.
- **Waiting time** — time spent inside an `AskUserQuestion` tool call or
  waiting on a permission dialog.
- **Work time** — wall time minus waiting time.
- **Cost** — the prompt's share of the session's running `total_cost_usd`
  (see "How cost is derived" below).
- **Tokens** — input, output, cache read and cache write tokens, read from
  the session transcript (see "What is read from the transcript").

Records are written in kankaku's own `WorkRecord` schema
(`WORK_RECORD_SCHEMA = 1`), the exact one the kankaku pi extension writes to
its own `worklog.jsonl`. This means kankaku's existing report and export
tooling can read this plugin's worklog unchanged. kankaku-claude also exposes
manual and best-effort automatic hub sync through kankaku's public hub adapters (below).

Every record carries the identity of who measured it: `agent: "claude-code"`,
`plugin: "kankaku-claude"` and `pluginVersion` (this package's version).
A worklog synced by another tool, such as the kankaku TUI, therefore keeps
the right agent on the hub. `agentVersion` is Claude Code's version, read
from the session transcript; it is left unset when the transcript cannot be
read, never guessed. Records written before this version carry no identity
and are labelled by whichever tool syncs them first.

## Requirements

- Claude Code with plugin support.
- Node.js >= 24 on `PATH`. This package ships a compiled `dist/` (`npm
  run build`, `tsc -p tsconfig.build.json`) — Node refuses to type-strip
  a `.ts` file once it sits under a `node_modules` directory
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so every published
  hook/statusline/CLI command runs the built `dist/*.js` file, never the
  `.ts` source. Installed via `kankaku` (below) this needs no action
  from you; a manual `--plugin-dir` checkout must run `npm install && npm
  run build` once before Claude Code can load it (see "Manual/dev"
  below).

## Install

**Recommended: `kankaku`'s setup wizard.** This package lives inside
`kankaku`'s own dependency tree, so installing and running its setup
wizard configures Claude Code for you — statusline and hooks together, in
one step, with no checkout and no `--plugin-dir`:

```bash
npm i -g kankaku
kankaku setup
```

Checking Claude Code in the wizard (or confirming it in `kankaku setup
--yes`) writes `statusLine` and `hooks` into `~/.claude/settings.json`,
resolved from this package's own bundled files, merged with — never
clobbering — whatever else is already there. See `kankaku`'s own
README ("Claude Code") for the full behaviour, the
`--claude-plugin-dir`/`KANKAKU_CLAUDE_PLUGIN_DIR` override, and why you
should drop `--plugin-dir` (below) once this has run.

**Manual/dev: `--plugin-dir`.** Clone this repository, build it once, then point Claude Code
at it directly:

```bash
git clone https://github.com/soyunninja/kankaku.git
cd kankaku/packages/claude
npm install && npm run build
claude --plugin-dir "$PWD"
```

`npm run build` compiles `src/` into `dist/`; the hooks, statusline and
`/kankaku:*` commands all run `dist/*.js`, never `src/*.ts` — a checkout
that skips this step fails at the hook's very first launch with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (or, for `--plugin-dir`
itself, simply nothing recorded). Re-run `npm run build` after pulling
new commits.

If your Claude Code version does not recognize `--plugin-dir`, or plugin
loading has changed since this was written, check your installed version's
own plugin documentation (`claude --help`, or `/plugin` inside a session) for
the current local-install flow. A plugin
wired only through settings.json hooks does not register its commands, so
`kankaku setup` installs the `/kankaku:*` commands separately (see
"Commands").

**Do not combine the two.** If `kankaku setup` has already configured this
machine's `~/.claude/settings.json` hooks, loading the plugin again with
`--plugin-dir` runs the same hooks twice per event and double-writes
worklog records. Use `--plugin-dir` only on a machine `kankaku setup` has
not touched, or drop it once setup has run.

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
(`cost.total_cost_usd`); hooks never receive it. `kankaku setup` (above)
writes it for you automatically; without `kankaku`, run:

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

`kankaku setup` installs these as user commands under
`~/.claude/commands/kankaku/`, so they work without `--plugin-dir`.

- `/kankaku:report` — a report of recent work, grouped by day (wraps
  `node dist/cli.js report`).
- `/kankaku:status` — the sessions kankaku-claude currently has state for:
  session id, whether its process is still alive, whether a prompt is open,
  and the last cost the statusline reported, followed by `recorded $X of
  $Y` (the sum of this session's record costs in this project's worklog
  against the session total). When they differ by more than a cent the line says what the
  difference is: `(this prompt so far $R)` for the open prompt's running
  spend, `(pending $P, goes to the next prompt)` for what was spent since
  the last settle of a session that has a chained baseline, and
  `(never recorded $Z)` for spend from before the session had one (a
  session upgraded mid-way, or resumed without its state) — no later
  prompt carries that part.
  The resolved work target comes first (wraps `node dist/cli.js status`).
- `/kankaku:target` — chooses the client and project this session works
  for (wraps `node dist/cli.js target`); see "Choosing the client and
  project for a session" below.
- `/kankaku:task` — links this session to a hub task (wraps
  `node dist/cli.js task`); see "Linking a task" below.
- `/kankaku:setup` — prints the `statusLine` snippet described above (wraps
  `node dist/cli.js setup`).
- `/kankaku:sync` — manually syncs recent local work records to the hub
  (wraps `node dist/cli.js sync`; the slash command does not forward arguments).
- `/kankaku:sync-status` — inspects local pending counts and sync state
  (wraps `node dist/cli.js sync status`; no hub request or credentials required).
- `/kankaku:sync-all` — requests a full sync (wraps `node dist/cli.js sync all`).
- `/kankaku:doctor` — a read-only local diagnostic of plugin files, session and
  cost visibility, and hub sync state (wraps `node dist/cli.js doctor`).

The report, status, setup, and doctor subcommands are also available directly via
`node dist/cli.js <report|status|setup|doctor>`; `report` accepts `--days N` and
defaults to the last 7 days. Doctor reads only local data; it never contacts the
hub or prints credentials. A missing cost file means cost has not been observed
under the current `HOME` (it does not prove the statusline is misconfigured).
Stored sync error details are withheld because they may contain sensitive data.

### Manual hub sync

Configure hub credentials with `KANKAKU_PB_URL`, `KANKAKU_PB_EMAIL`, and
`KANKAKU_PB_PASSWORD`, or use `~/.kankaku/credentials.json` (the shared
kankaku hub credential file). Then run `/kankaku:sync` for recent records or
`/kankaku:sync-all` for a full sync in the project whose worklog you want to
upload. Use `/kankaku:sync-status` to inspect local sync state without a hub
request or credentials. The same operations are available directly via CLI:

| Command | Purpose |
|---------|---------|
| `node dist/cli.js sync` | Manually sync the recent window (24 hours by default). |
| `node dist/cli.js sync all` | Request a full sync. |
| `node dist/cli.js sync status` | Inspect local pending counts and sync state; no hub network request or credentials required. |

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

### Client and project assignment

Each record is stamped with a hub client and project when one resolves, so
the hub files the task under the right client instead of "Sin determinar".
Sources, in order:

1. the session's own pick, made with `/kankaku:target` (see below);
2. the project's `<KANKAKU_DIR>/config.json` ids (`clientId`, optional
   `projectId`);
3. the cached catalog's `repo_paths`: the active project whose path equals
   the session's working directory, or contains it.

Inactive clients and projects, and the "unassigned" client, are never used.
The catalog is read from the cache file `~/.kankaku/catalog.json` only; a
hook never fetches it and never waits on the network. Every real sync
refreshes that cache, and `kankaku catalog refresh` refreshes it on demand.
Without a readable cache (or without hub credentials, which name the hub the
cache belongs to) no target resolves and records stay unassigned, exactly as
before. The legacy `client` label is the client's code when it is a valid
label; without a hub target it comes from `KANKAKU_CLIENT`, then the
`client` in `config.json`.

The target is resolved when a record is written (`Stop`, `SessionEnd`,
crash recovery), never on the per-tool-call hooks. `/kankaku:status` and
`/kankaku:doctor` print `target: <client> · <project> (source: ...)`, or
`target: none (<reason>)`.

### Choosing the client and project for a session

`/kankaku:target` picks the client and project the records of this session
are filed under, for the cases where the folder does not say (or says the
wrong thing):

- `/kankaku:target` prints the current target and its source (`session`,
  `project config` or `repo_paths`), then the active clients numbered;
  Claude then asks which one you want. The unassigned client is never
  listed.
- `/kankaku:target <number | code | text>` picks a client: from the last
  list shown in this session (a purely numeric argument is always a list
  number), by client code (exact, case-insensitive), or by a unique
  case-insensitive part of its name. It prints `client set to <Client>` and
  that client's active projects numbered. A following
  `/kankaku:target <number | code | text>` that matches one of those
  projects sets the project (`target set to <Client> · <Project>`).
- `/kankaku:target <client> <project>` sets both at once; the project must
  belong to the client, otherwise nothing changes.
- `/kankaku:target clear` removes the pick and prints what the automatic
  resolution gives now.

Text that matches nothing, or several entries, changes nothing (several are
listed so one can be picked by number). Inactive entries are never
selectable.

The pick is session-only, like `/kankaku target pick|clear` in pi: it is
stored in `<KANKAKU_DIR>/claude/<session>.target.json` next to the task
link, removed when the session ends, and **`config.json` is never written**.
For a permanent choice use `kankaku setup` or the project's `config.json`.
Precedence at record time is the library's: session pick, then `config.json`,
then `repo_paths`; a picked client or project that is no longer active in
the catalog falls through to the next source. Records carry the picked
client and project (`clientId`, `clientName`, `projectId`, `projectName`,
and the legacy `client` label = the client code when it is a valid label),
and `/kankaku:status` and `/kankaku:doctor` print `(source: session)`.

Changing or clearing the client or project also decides the task link: it is
kept only when the linked task belongs to the resulting project, and the
command says which happened (`task link kept`, or `task link dropped
(<title> is not in <Project>)`). Picking only a client always drops it,
since no project is chosen yet. `/kankaku:task` lists the tasks of the
resulting project. Listing and picking refresh the catalog first (bounded to
3 seconds) and fall back to the cache (`catalog from cache, <age> old`);
without a cache and without a hub the command says `no catalog` and exits
with 1.

### Linking a task

`/kankaku:task` links the session to one hub task of the project resolved
for the folder, so the records written from then on carry that task:

- `/kankaku:task` lists the project's open tasks (status `open` or `doing`),
  numbered, and marks the linked one; Claude then asks which one you want.
- `/kankaku:task <number>` picks from the last list shown in this session,
  `/kankaku:task <id>` by hub id, and `/kankaku:task <text>` by a unique
  case-insensitive part of the title (several matches are listed and nothing
  changes). A purely numeric argument is always a list number.
- `/kankaku:task clear` removes the link.

The link is session-only, like `/kankaku task pick` in pi: it is stored in
`<KANKAKU_DIR>/claude/<session>.target.json`, never in `config.json`, and is
removed when the session ends. The list refreshes the catalog first (bounded
to 3 seconds) and falls back to the cache, saying how old it is; the hooks
still only read the cache. A record keeps the link only while the task still
belongs to the resolved project in the catalog; otherwise it is dropped and
`/kankaku:status` and `/kankaku:doctor` print
`task: none (linked task "<title>" is not in project <name>)`. Both print
`task: <title>` or `task: none` otherwise.

The CLI finds its session from its own process: it walks up to the Claude
Code process and takes the session state of this project whose `pid` matches
(most recent activity first). Without a session it prints
`no active Claude Code session found for this folder`. Set
`KANKAKU_CLAUDE_SESSION=<session id>` to name the session explicitly (tests,
scripting); it wins over the process lookup. Overriding the client or project
from Claude Code is not supported yet. Assignment is create-only
on the hub: a row already uploaded as unassigned stays that way until it is
reassigned in the web app or from the `kankaku` CLI's Tasks screen; a
later sync does not move it.

## How cost is derived

Claude Code hooks carry no cost. For interactive sessions the only source is
the statusline, whose `cost.total_cost_usd` is the running total of the
session; the statusline command stores the latest value under your home directory (see "Where the
files live").

- **Per-prompt difference.** A prompt's cost is the session total when the
  prompt settles minus the total the prompt is measured from, rounded to
  micro-dollars and never negative.
- **Chained baseline.** The session state keeps `costBaseline`, the session
  total at the last settle. The next prompt is measured from that baseline,
  not from the snapshot at submit, so the records of a session add up to its
  total. A session Claude Code reports as newly started (`SessionStart`
  source `startup`) begins with baseline 0. A resumed session keeps the
  baseline of its state file; with no state file its first prompt is
  measured from the snapshot at submit.
- **Spend between prompts belongs to the next record.** `worklog.jsonl` is
  append-only and the previous record is already written, so anything spent
  after a settle and before the next prompt (background subagents that keep
  running, a statusline refresh that arrives after `Stop`) is added to the
  next record of the same session.
- **Counter reset.** If the total is lower than the value the prompt is
  measured from, the counter was reset: the prompt's cost is the new total
  and the baseline restarts from it.
- **Headless runs take their cost from the transcript.** `claude -p` renders
  no statusline, so the cost comes from the transcript's `cost-state` line
  instead (see "Headless runs" below).
- `/kankaku:status` shows `recorded $X of $Y` per live session so a gap is
  visible.

## What is read from the transcript

Every hook receives `transcript_path`, the JSON Lines file Claude Code keeps
for the session. kankaku-claude reads it for three things, and nothing else:

- **Tokens.** The `input_tokens`, `output_tokens`, `cache_read_input_tokens`
  and `cache_creation_input_tokens` of the assistant messages become the
  record's `usage.input`, `usage.output`, `usage.cacheRead` and
  `usage.cacheWrite`, which is what makes `cache hit` appear for Claude Code
  records in the `kankaku` CLI. Claude Code writes one message over several
  adjacent lines whose usage grows (the earlier lines are partial snapshots;
  subagent transcripts show it clearly), so each `message.id` is counted once,
  by its last line. When a read ends in the middle of a message, the stored
  position remembers the message id and what was counted for it, and the
  next read adds only the growth.
- **The version.** The `version` of the first line read becomes the record's
  `agentVersion`.
- **For headless runs, the cost.** See "Headless runs" below.

Only numbers, the version and the entry point (`cli` or `sdk-cli`) are taken
from a line; prompts, answers, tool inputs and outputs are never kept, copied
or sent anywhere. Subagents do not appear in the session's transcript: each
has its own file under `<session id>/subagents/`, and those files are read
too, so the record of a prompt includes its subagents' tokens.

How it is read:

- **Only what is new.** The session state keeps a read position per
  transcript file. `UserPromptSubmit` only records the current size of each
  file (a `stat`, no read) so a session that already existed does not read
  its history; `Stop`, `SessionEnd` with an open prompt and crash recovery
  read the bytes after the position, count them and advance it. A subagent
  file that appears later is read from its start, and a partial last line is
  left for the next read.
- **Tokens between two prompts are not lost.** Positions only advance when a
  record is settled, so tokens spent after `Stop` and before the next
  settle (a background subagent that keeps running) land in the next record
  of the session, the same rule as cost.
- **The transcript is written asynchronously.** Measured on real runs, the
  last assistant lines reach the disk shortly AFTER the `Stop` hook has
  started (none at 0 ms, present at 50 ms). Before reading at settle,
  `Stop` therefore polls the transcript every 25 ms, measured from when the
  hook process started, and reads once ALL hold: at least 100 ms have
  passed (earlier assistant messages of the same prompt are usually on disk
  long before, and the last one is the late one, so a line being present is
  not enough), the size did not change across two polls, and the new bytes
  hold a complete assistant line. It gives up 300 ms after the hook started
  whatever it sees. Time already spent in the statusline wait counts, so a
  hook that waited 300 ms or more for the statusline does not wait again.
  Usage that still arrives   later is counted by the next settle. A headless session reads once more at
  `SessionEnd` (or in recovery, which does not wait: the file is final) and
  adds what it finds to the last pending prompt, since late lines belong to
  the prompt that just settled.
- **The model.** When the statusline gave no model (headless runs, or no
  statusline), the record's `model` is `anthropic/<message.model>` of the
  last assistant line, the same `anthropic/` prefix the statusline model gets.
  The statusline model wins when there is one.
- **A bound per settle.** At most 16 MiB of transcript is read per settle,
  across all files. If a settle finds more new content than that, it is
  skipped without counting and the record simply has no tokens; the hook
  never risks its timeout on a huge file.
- **Hooks that build no record read nothing.** `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SubagentStart` and `SubagentStop` never touch the
  transcript, and `UserPromptSubmit` only `stat`s it.

The transcript format is internal and undocumented and may change with any
Claude Code release. kankaku-claude therefore treats every part of it as
optional: a missing or unreadable file, a line it does not understand, or a
field of an unexpected type is ignored, and the record is written exactly as
it was before this existed, without the tokens or the version. It never makes
a hook fail.

### Headless runs

A session whose transcript says `entrypoint: "sdk-cli"` (a `claude -p` run)
has no statusline. Claude Code appends a `cost-state` line with the session's
total cost to the transcript only after the last `Stop`, so for these
sessions:

1. `Stop` does not write the record. The settled prompt (times, waiting and
   tokens are final) is kept in the session state as pending.
2. `SessionEnd` reads the last `cost-state`, applies the same chained
   baseline as the statusline cost, and appends the record with the cost and
   `costObserved`. If `SessionEnd` never runs, crash recovery writes the
   pending records the next time another session starts, reading the
   transcript then. Either way each prompt is written exactly once.
3. A `cost-state` with a finite `totalCostUSD` is usable whatever its
   `modelUsage` holds (an empty one included); only
   `hasUnknownModelCost: true` disqualifies it. The cost also needs a start
   baseline: a session Claude Code reports as newly started (`SessionStart`
   source `startup`) begins at 0; without one the cost stays unobserved,
   like the statusline cost.
4. With no `cost-state`, or one flagged `hasUnknownModelCost` (the total is
   then not reliable), the records are written without cost.

**Attribution.** A session with one prompt gets the whole cost. When a
headless session ran several prompts, the total is shared in proportion to
each prompt's token total (equal shares when all are zero), in whole
micro-dollars with the remainder on the last prompt, so the shares add up to
the session cost exactly. Those records carry `costAllocated: true`: the cost
is a share, not a measured difference. The marker stays in the local
worklog and is not sent to the hub. Interactive sessions (entry point `cli`,
or one that cannot be read) are unchanged: the record is written at `Stop`
with the statusline cost.

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
deleted; a dead session with no open prompt just has its files deleted. A
dead headless session that still holds pending prompts gets their records
written, with the cost from its transcript. This also runs for the current
session's own leftover state at `SessionEnd`.

An interrupted prompt is closed at its last recorded activity — the
timestamp of the last event logged for it, or its own start when nothing
followed — never at the moment of recovery, so a session that hung and was
recovered hours later does not report those hours as work. A waiting span
still open is closed at that same instant.

## Limitations

- **`turns` is always 1 per run.** Claude Code hooks give no way to observe
  provider-level retries/turns inside one run; every replayed run reports
  exactly one turn.
- **Token counts come from an undocumented file.** Hooks carry no token
  numbers; they are read from the session transcript, whose format can
  change with any Claude Code release. When it cannot be read or understood
  the record has zero tokens, and a settle that finds more than 16 MiB of
  new transcript skips it. See "What is read from the transcript".
- **Cost is a per-prompt delta of the session total, from the statusline,
  and needs the manual setup step.** See "How cost is derived". Spend that
  lands between two prompts (a late statusline refresh, a background
  subagent still running) is attributed to the next record of the session,
  not lost. Headless `claude -p` runs have no statusline; their cost comes
  from the transcript at `SessionEnd`, and is shared between prompts when
  there are several (see "Headless runs").
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
