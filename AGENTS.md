# kankaku — agent guidelines

kankaku is a [pi](https://pi.dev) extension package that records how long
agents work on each user prompt. It writes append-only JSONL records to
`.kankaku/worklog.jsonl` and derives task and session views from them.
Read `README.md` for behaviour and the record schema before changing code.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no `Date.now()`, no pi imports. Time comes
  from the injected `Clock` port. `WorkTracker` is the only stateful domain
  object and it must stay deterministic under test.
- `src/ports/` holds interfaces only (`Clock`, `WorkLog`).
- `src/adapters/` talks to the outside world: pi events and UI
  (`pi-tracker.ts`), the filesystem (`jsonl-work-log.ts`,
  `lazy-jsonl-work-log.ts`), and report formatting (`report.ts`).
- `src/extension.ts` only wires config, tracker, log and adapter together.
  Do not put logic there.
- Dependencies point inwards: adapters import domain and ports; domain
  imports nothing outside `src/domain/` and `src/ports/`.

## Measurement rules (do not break)

- One record per pi process per prompt, from `before_agent_start` to
  `agent_settled`. Several agent runs (retry, follow-up) belong to the same
  record; `runs` counts them.
- `waitingMs` is the union of UI-prompt spans and interactive-tool spans.
  Waiting spans opened by a tool are closed only by that tool's `toolCallId`.
- `workMs = wallMs - waitingMs`. Never sum parallel spans; use interval
  unions (`src/domain/intervals.ts`).
- Subagent time is linked through `pid`/`parentPid` and reported separately.
  Task and session views compute wall time as the union of orchestrator and
  child intervals.
- `.kankaku/worklog.jsonl` is user data. Append only, one `JSON.stringify`
  line per record, tolerate malformed lines when reading, never rewrite it.
- Bump `WORK_RECORD_SCHEMA` when a persisted field changes meaning or is
  removed. Adding optional fields does not require a bump.
- Tagged tool segments (`segments`) are the union of milliseconds per tag
  within one `WorkRecord`, and the sum of `segments` per tag across a
  task's or session's records — never a union at that level, since segment
  intervals are not persisted to `worklog.jsonl`.
- Each process checkpoints its in-flight record to `.kankaku/inflight/<pid>.json`
  (via `InflightStore`) so a hard crash still leaves an `interrupted` record,
  recovered on the next `session_start`; see README "Crash recovery".

## Code conventions

- TypeScript run directly by Node 24 (type stripping): no enums, namespaces,
  or parameter properties; `import type` for types; relative imports include
  the `.ts` extension; `verbatimModuleSyntax` is on.
- Strict TDD: write the failing test in `tests/` first, then implement.
  Every module with behaviour has a matching `tests/<name>.test.ts`;
  type-only files and the thin `src/extension.ts` wiring are the exceptions.
- Tests use `node:test` and `node:assert/strict`, fake clocks and fake pi
  objects; no real timers, no real pi process, no network.
- Event handlers registered with `pi.on` must never throw. Wrap them with
  `guarded` and report failures through `ctx.ui.notify` only when
  `ctx.hasUI` is true.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are
  dev dependencies for types only; pi provides them at runtime. Do not add
  runtime dependencies without a reason written in the pull request.
- Code, comments, docs and commit messages are in English, neutral register.

## Verification before calling work done

```
npm run check   # tsc --noEmit + node --test tests/*.test.ts
```

For behaviour changes also run a headless smoke test and confirm a record
is written:

```
KANKAKU_DIR=/tmp/kankaku-smoke pi -p --no-session "Reply with exactly the word OK."
```

## Git

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not commit `.kankaku/`, `.codegraph/`, or `node_modules/`.
