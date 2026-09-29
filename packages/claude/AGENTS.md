# kankaku-claude — agent guidelines

kankaku-claude is a [Claude Code](https://claude.com/claude-code) plugin that
writes one `WorkRecord` per user prompt to `<KANKAKU_DIR>/worklog.jsonl`, in
exactly the schema the [kankaku](https://kankaku.io) pi extension writes
(`WORK_RECORD_SCHEMA = 1`), so every existing kankaku report/export/hub path
can consume it unchanged. Read `odd/tasks/hook-tracking.md` for the full
design and the verified Claude Code facts it is built on before changing the
hook or replay layer.

## Architecture

Claude Code has no in-process extension API: a hook is a fresh, short-lived
Node process per event, given JSON on stdin, with no channel back into a
running session. There is therefore no in-memory `WorkTracker` the way the pi
extension has one. Instead:

- **Event sourcing + replay.** Every hook invocation appends one line to
  `<KANKAKU_DIR>/claude/<session_id>.events.jsonl` (`src/events.ts`,
  `src/event-log.ts`). `src/prompts.ts#splitPrompts` groups that stream into
  one group per user prompt. `src/replay.ts#replayPrompt` is pure: it feeds
  one prompt's events into a fresh `WorkTracker` (from `kankaku-pi/domain`)
  whose `Clock` returns the event's own recorded `ts`, and returns the
  resulting `WorkRecordCore`. No wall-clock time and no live process state
  is read during replay.
- **Small per-session state.** `<KANKAKU_DIR>/claude/<session_id>.state.json`
  (`src/session-state.ts`) holds `pid`, `parentPid`, `cwd` and the currently
  open prompt (if any). It is rewritten atomically (tmp file + rename) on
  every change, and **only a hook ever writes it** — the statusline only
  reads it (see "Cost" below; T7, `odd/tasks/hook-tracking.md`).
- **Light hooks vs. heavy hooks.** `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SubagentStart`, `SubagentStop` and `UserPromptSubmit`
  only append one event line and touch a couple of state fields; they must
  never import `kankaku-pi` (see "Rules" below). `Stop`, `SessionStart` and
  `SessionEnd` are the only handlers that load `replay.ts`, `record.ts` and
  `kankaku-pi/hub` — always through a dynamic `import()`, never a top-level one
  — because only they need to replay a prompt or write to `worklog.jsonl`.
- **Cost lives under HOME, never a project (T7).** Claude Code hooks never
  receive token counts or cost. The statusline command (`src/statusline.ts`,
  built on the pure `src/statusline-core.ts`) is the only source: it reads
  `cost.total_cost_usd` from its stdin JSON on every render and writes it to
  `~/.kankaku/claude/cost/<session_id>.json` (`src/cost-store.ts`) — never to
  a project's state file. This matters because the `statusLine` entry lives
  in `~/.claude/settings.json`, so the statusline command runs on *every*
  Claude Code session on the machine, plugin loaded or not; a
  project-relative cost file would litter whatever project happened to be
  open. `src/cost-store.ts` imports only node builtins, so it stays off the
  light-hook `kankaku-pi` import ban below. `UserPromptSubmit` reads the cost
  file for the baseline (`promptOpen.costAtStart`); `Stop` polls it (bounded)
  for a fresh-enough write and computes the delta; `SessionEnd` deletes it;
  `SessionStart` (non-`compact`) sweeps cost files older than 7 days
  (`sweepStaleCostFiles`).
- **Crash recovery.** `src/inflight-recovery.ts#recoverStaleSessions`, run at
  `SessionStart`, scans every other session's state file: a dead pid with an
  open prompt becomes one `interrupted` record; a dead pid's files (state,
  events, cost) are always cleaned up. A non-positive `pid` counts as dead
  regardless of `isAlive`'s answer — see "Rules" below. `SessionEnd` does the
  same for the session it belongs to.

## Files

- `src/events.ts` — the event union, `parseEventLine`/`serializeEvent`,
  tolerant of malformed lines.
- `src/prompts.ts` — `splitPrompts`, grouping a session's event stream into
  per-prompt groups.
- `src/replay.ts` — `replayPrompt`, the pure event-to-`WorkRecordCore`
  replay, and the plugin's Claude-Code-specific `SubagentProfile`
  (`Agent`/`Task` tools, `subagent_type` as the agent name).
- `src/record.ts` — `buildClaudeRecord`, attaching orchestrator metadata
  (`role`, `pid`, `parentPid`, `project`, `sessionId`, `mode`, `model`, plus the
  measuring identity `agent`, `plugin`, `pluginVersion`) to a replayed
  `WorkRecordCore`. Identity is stamped on every record so another syncer
  (the TUI) cannot relabel it. `agentVersion` and `costAllocated` come in as
  `extras`; `agentVersion` is Claude Code's version read from the transcript
  and stays unset when it is unknown. `stampTokens` puts the transcript token
  counts on a replayed record.
- `src/transcript.ts` — the transcript reader: pure `parseTranscriptChunk`,
  `readTranscriptSince` (complete lines only, per-file byte bound),
  `listSubagentTranscripts`, `statTranscriptSize`. Node builtins only.
- `src/transcript-settle.ts` — session-level use of it: `trackTranscriptAtSubmit`
  (stat only) and `settleTranscripts` (main + subagent files, shared bound).
- `src/headless.ts` — `allocateCost` and `buildHeadlessRecords`, the records
  of a finished `sdk-cli` session. Heavy path only.
- `src/work-target.ts` — `resolveClaudeWorkTarget` (project `config.json` ids
  > cached catalog `repo_paths`, through the library's `resolveWorkTarget`),
  `RecordAssignment` and `formatTargetLine`. Imports `kankaku-pi`, so heavy
  paths only.
- `src/session-target-store.ts` — `readSessionTarget`/`writeSessionTarget`,
  the session-only task link `<KANKAKU_DIR>/claude/<session>.target.json`
  (`hubTaskId`, `hubTaskTitle`, `projectId`, `pickedAt`, `lastList`), tmp+rename
  writes, malformed reads treated as absent. Node builtins only.
- `src/find-session.ts` — `findSession`: `KANKAKU_CLAUDE_SESSION` wins, else
  the CLI pid is walked to the Claude process (`resolveClaudePid`) and matched
  to the state file `pid`, most recent activity first.
- `src/task-select.ts` — pure list/pick logic (open = status not `done`,
  the project's tasks only, a numeric argument is always a list number).
- `src/task-cli.ts` — `runTaskCli`, the `task` subcommand (list, pick, clear);
  the only CLI path that fetches, bounded by `catalogTimeoutMs` (3 s).
- `src/paths.ts` — `resolvePaths`/`resolveKankakuDir`/`listStateFiles`: where
  everything lives under `<KANKAKU_DIR>/claude/`.
- `src/session-state.ts` — `readState`/`writeState`/`updateState`, the
  atomic per-session state file (no `cost` field since T7).
- `src/cost-chain.ts` — `settleCost`, the pure chained per-prompt cost rule.
- `src/cost-store.ts` — `readCost`/`writeCost`/`deleteCost`/
  `sweepStaleCostFiles`, the per-session cost file under
  `~/.kankaku/claude/cost/`. Node builtins only, no `kankaku-pi` import.
- `src/event-log.ts` — `appendEvent`/`readEventLog`/`dropSettledPrompts`.
- `src/claude-pid.ts` — `resolveClaudePid` (ancestor walk via an injected
  `ps` runner) and `isAlive` (`false` for any non-positive or non-integer
  pid, without calling `process.kill`).
- `src/inflight-recovery.ts` — `recoverStaleSessions`, crash recovery.
- `src/handle-hook.ts` — `handleHook(input, deps)`, the pure dispatcher over
  injected fs/clock/sleep/log dependencies; one branch per hook event.
- `src/hook.ts` — the actual hook entry point: reads stdin, calls
  `handleHook`, always exits 0.
- `src/statusline-core.ts` / `src/statusline.ts` — the pure statusline
  renderer and its stdin-to-stdout entry point.
- `src/report.ts` — `formatReport`, a minimal day-grouped report built on
  `buildTasks` from `kankaku-pi/domain`.
- `src/cli-core.ts` / `src/cli.ts` — `runCli(argv, deps)` (`report`,
  `status`, `setup`) and its thin `process.argv`/`process.exit` wrapper.
- `hooks/hooks.json` — registers the compiled `dist/hook.js` for all 9
  hook events (see "Build step" below).
- `commands/*.md` — the `/kankaku:report`, `/kankaku:status`,
  `/kankaku:task` and `/kankaku:setup` (and sync/doctor) slash commands, each running the CLI via the `!` shell
  prefix.

## Rules (do not break)

- **The light hook path must never import `kankaku-pi`.** `PreToolUse`,
  `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop` and
  `UserPromptSubmit` run once per tool call; loading `kankaku-pi/domain` or
  `kankaku-pi/hub` on that path would slow down every tool call in every
  session. This is enforced by a test: `tests/handle-hook.test.ts` walks
  every module statically reachable from `src/hook.ts` through relative
  imports and rejects any top-level runtime `from "kankaku` line. `Stop`,
  `SessionStart` and `SessionEnd` load those modules with a dynamic
  `import()` inside their own branch only.
- **Hooks always exit 0 with empty stdout.** A hook must never block Claude
  Code or print anything that could be mistaken for hook output. `hook.ts`
  wraps the handler in try/catch, writes errors to stderr only, and always
  calls `process.exit(0)` in a `finally`. `handleHook` itself never throws
  for malformed input — it logs to `deps.stderr` and returns.
- **`worklog.jsonl` is append-only.** Every write goes through
  `JsonlWorkLog(kankakuDir).append(record)` (from `kankaku-pi/hub`). It is never
  rewritten or truncated; only the plugin's own per-session
  `*.events.jsonl` files are ever rewritten (via `dropSettledPrompts`, tmp +
  rename), to drop a settled prompt's events.
- **The statusline never writes under a project.** It writes cost only
  through `src/cost-store.ts#writeCost`, to
  `~/.kankaku/claude/cost/<session_id>.json`; it only ever READS a project's
  state file (for the open-prompt clock), and a missing state file renders
  as `idle` rather than creating one. `writeCost` never overwrites a newer
  cost (last writer wins only by `updatedAt`, not by call order). This is
  the T7 fix: before it, the statusline is wired globally, so it used to run
  in every session on the machine and litter whatever project was open with
  a placeholder state file (`pid: 0`, `cwd: ""`) that `isAlive(0)` — via
  `process.kill(0, 0)`, which signals the whole process GROUP — reported
  alive forever, so recovery never swept it.
- **Cost is chained, never re-based at submit.** A prompt's `costAtStart`
  is `state.costBaseline` (the session total at the last settle) when the
  state has one, and only otherwise the statusline snapshot at submit.
  `SessionStart` with `source: "startup"` and no state sets the baseline to
  0; any other or absent source sets none. Every settle (`Stop`,
  `SessionEnd` with an open prompt, `recoverStaleSessions`) goes through
  `settleCost` (`src/cost-chain.ts`): cost = total - start in
  micro-dollars, a lower total is a counter reset (cost = total), and the
  baseline becomes the total; with no finite total the cost stays
  unobserved and the baseline does not move. Spend between two prompts
  belongs to the next record. A `Stop` or `SessionEnd` with no open prompt
  writes nothing and never moves the baseline. Handlers that rebuild the
  state must carry `costBaseline` over.
- **A non-positive pid is always dead.** `isAlive` returns `false` for pid
  `<= 0` (or non-integer) without calling `process.kill` at all, and
  `recoverStaleSessions` treats `state.pid <= 0` as dead independently of
  what `isAlive` reports — belt and suspenders against the exact T7 defect
  above, so a future placeholder-shaped state file can never look alive
  again through either path.

- **Target resolution happens only where a record is built.** `Stop`,
  `SessionEnd` and `recoverStaleSessions` (and the `status`/`doctor` CLI)
  call `resolveClaudeWorkTarget`; `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SubagentStart/Stop` and `UserPromptSubmit` never do
  (a test counts calls). It reads the cache file `~/.kankaku/catalog.json`
  only: never fetch, refresh or wait on the network from a hook, and never
  throw. A missing or unusable cache means no target (today's unassigned
  behaviour). Stamping mirrors pi-tracker: `clientId`, `clientName`,
  `projectId`, `projectName`, and the legacy `client` label = client code
  when valid against `CLIENT_PATTERN`; without a target it falls back to
  `KANKAKU_CLIENT` > `config.json` client. The plugin writes no separate
  subagent records, so none carries its own target (the task view inherits
  the orchestrator's). Assignment is create-only on the hub; never rewrite
  records already on disk.

- **The transcript is an undocumented, changeable format: read it only to
  measure, and only where a record is built.** Tokens, the version, the
  entry point and the `cost-state` total are the only things taken from it;
  never keep, log or copy message content. `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SubagentStart` and `SubagentStop` never read it, and
  `UserPromptSubmit` only `stat`s it (`trackTranscriptAtSubmit`). Positions
  (`state.transcript.offsets`) advance only at settle (`Stop`, `SessionEnd`
  with an open prompt, recovery), so tokens between prompts land in the next
  record; a settle reads at most `MAX_SETTLE_BYTES` (16 MiB) across all files
  and, beyond it, skips to the end and stamps no tokens. Any failure in this
  path is swallowed: the record is written as it would be without it.
  Claude Code writes the transcript ASYNCHRONOUSLY: at Stop the last
  assistant lines are often not on disk yet (measured: none at 0 ms, there at
  50 ms). `Stop` (interactive and headless) calls `waitForTranscript` after
  the statusline wait (25 ms polls; ends when >= 100 ms since the hook
  process started AND the size was stable across two polls AND an assistant
  line is present; gives up at 300 ms since the hook started, so time spent
  in the statusline wait counts; injected clock and sleep, and the start
  time is the hook's `ts`). A line already on disk must not end the wait
  early: the prompt's last message is the late one;
  usage arriving later is counted by the next settle. A headless
  `SessionEnd` and recovery re-read and add the tokens to the LAST pending
  prompt (`withLateTokens`) before building records, and recovery never
  waits. The entry point and version fall back to `readTranscriptHead`
  because the read position is already past the first lines. The record's
  `model` is the statusline model, else `anthropic/` + the transcript's
  `message.model`.
  A message's lines are adjacent and grow, so a message counts by its LAST
  line; a position stores `lastMessageId` and `lastMessageUsage` so a message
  split across two reads adds only its growth (a legacy position without the
  usage skips that message's head lines instead).
  Handlers that rebuild the state must carry `transcript` and `pending`
  over (`carriedOver`). Tests use synthetic fixtures that copy only the
  shapes; never put real transcript content in a fixture, test or doc.
- **Headless sessions (`entrypoint: "sdk-cli"`) defer their record.** `Stop`
  moves the settled prompt into `state.pending` and writes nothing (and does
  not wait for a statusline cost); `SessionEnd` and `recoverStaleSessions`
  turn the pending list into records through `buildHeadlessRecords`: the last
  `cost-state` through `settleCost`, shared by token totals when there are
  several prompts (`costAllocated`). A `cost-state` with
  `hasUnknownModelCost` is not used. The pending list is dropped from the
  state right after the append, and the state files are deleted by
  whichever path runs first, so a prompt is written once.

## Conventions (mirrored from kankaku)

- TypeScript run directly by Node 24 (type stripping): no enums,
  namespaces, or parameter properties; `import type` for types; relative
  imports include the `.ts` extension; `verbatimModuleSyntax` is on.
- Strict TDD: write the failing test in `tests/` first, then implement.
  Every module with behaviour has a matching `tests/<name>.test.ts`; the
  thin `src/hook.ts`, `src/cli.ts` and `src/statusline.ts` entry points are
  the exceptions (they are exercised manually — see README "Verification" —
  because they read real stdin/argv/exit codes).
- Tests use `node:test` and `node:assert/strict`, temp directories under
  `os.tmpdir()`, fake clocks and injected `ps`/`isAlive`/fs dependencies; no
  real Claude Code process is ever launched from a test.
- `kankaku-pi` is a runtime dependency (the published `kankaku-pi/domain`,
  `kankaku-pi/ports` and `kankaku-pi/hub` entrypoints); do not import from its
  internal `src/` paths.
- Code, comments, docs and commit messages are in English, neutral register.

## Build step

This package ships a compiled `dist/` (`npm run build`, `tsc -p
tsconfig.build.json`, mirroring `packages/pi`/`packages/cli`'s own
`tsconfig.build.json` pattern): every hook/statusline/CLI command Claude
Code or `kankaku setup` actually runs points at `dist/*.js`, never
`src/*.ts`. This is required, not cosmetic — Node refuses to type-strip a
`.ts` file once it sits under a `node_modules` directory
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `src/`-only publish
cannot run at all once installed as a dependency (e.g. via `kankaku`).
`package.json`'s `files` therefore ships `dist/`, not `src/` or
`tsconfig.json`; `npm run check` (below) and `prepublishOnly` both build
first. Tests still run directly against `src/*.ts` (`node --test
tests/*.test.ts`, never through `node_modules`, so type stripping applies
normally there) and need no prior build.

## Verification before calling work done

```
npm run check   # tsc -p tsconfig.build.json + tsc --noEmit + node --test tests/*.test.ts
```

For hook or statusline changes, also run a manual smoke check (never as an
automated test — see README "Limitations" and the SessionStart/Stop
sequencing this depends on):

```
echo '{"session_id":"demo","cwd":"'$(mktemp -d)'","model":{"id":"claude-sonnet-5"},"cost":{"total_cost_usd":0.1234}}' | node src/statusline.ts
node src/cli.ts setup
```

This writes a real `demo.json` under your actual `~/.kankaku/claude/cost/`
(T7: cost always lives under `HOME`, never a project) — override `HOME` to
an isolated temp directory first if you want to avoid that.

## Git

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not commit `.kankaku/`, `.codegraph/`, `odd/`, or `node_modules/`.
