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
  one prompt's events into a fresh `WorkTracker` (from `kankaku/domain`)
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
  never import `kankaku` (see "Rules" below). `Stop`, `SessionStart` and
  `SessionEnd` are the only handlers that load `replay.ts`, `record.ts` and
  `kankaku/hub` — always through a dynamic `import()`, never a top-level one
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
  light-hook `kankaku` import ban below. `UserPromptSubmit` reads the cost
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
  (`role`, `pid`, `parentPid`, `project`, `sessionId`, `mode`, `model`) to a
  replayed `WorkRecordCore`.
- `src/paths.ts` — `resolvePaths`/`resolveKankakuDir`/`listStateFiles`: where
  everything lives under `<KANKAKU_DIR>/claude/`.
- `src/session-state.ts` — `readState`/`writeState`/`updateState`, the
  atomic per-session state file (no `cost` field since T7).
- `src/cost-store.ts` — `readCost`/`writeCost`/`deleteCost`/
  `sweepStaleCostFiles`, the per-session cost file under
  `~/.kankaku/claude/cost/`. Node builtins only, no `kankaku` import.
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
  `buildTasks` from `kankaku/domain`.
- `src/cli-core.ts` / `src/cli.ts` — `runCli(argv, deps)` (`report`,
  `status`, `setup`) and its thin `process.argv`/`process.exit` wrapper.
- `hooks/hooks.json` — registers the compiled `dist/hook.js` for all 9
  hook events (see "Build step" below).
- `commands/*.md` — the `/kankaku:report`, `/kankaku:status` and
  `/kankaku:setup` slash commands, each running the CLI via the `!` shell
  prefix.

## Rules (do not break)

- **The light hook path must never import `kankaku`.** `PreToolUse`,
  `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop` and
  `UserPromptSubmit` run once per tool call; loading `kankaku/domain` or
  `kankaku/hub` on that path would slow down every tool call in every
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
  `JsonlWorkLog(kankakuDir).append(record)` (from `kankaku/hub`). It is never
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
- **A non-positive pid is always dead.** `isAlive` returns `false` for pid
  `<= 0` (or non-integer) without calling `process.kill` at all, and
  `recoverStaleSessions` treats `state.pid <= 0` as dead independently of
  what `isAlive` reports — belt and suspenders against the exact T7 defect
  above, so a future placeholder-shaped state file can never look alive
  again through either path.

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
- `kankaku` is a runtime dependency (the published `kankaku/domain`,
  `kankaku/ports` and `kankaku/hub` entrypoints); do not import from its
  internal `src/` paths.
- Code, comments, docs and commit messages are in English, neutral register.

## Build step

This package ships a compiled `dist/` (`npm run build`, `tsc -p
tsconfig.build.json`, mirroring `packages/kankaku`/`packages/tui`'s own
`tsconfig.build.json` pattern): every hook/statusline/CLI command Claude
Code or `kankaku setup` actually runs points at `dist/*.js`, never
`src/*.ts`. This is required, not cosmetic — Node refuses to type-strip a
`.ts` file once it sits under a `node_modules` directory
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `src/`-only publish
cannot run at all once installed as a dependency (e.g. via `kankaku-tui`).
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
