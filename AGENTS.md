# kankaku-tui — agent guidelines

kankaku-tui is a standalone terminal app, built with [Ink](https://github.com/vadimdemedes/ink)
on Node 24, that reads every project's `.kankaku/worklog.jsonl` under a
configurable list of roots and shows the day across projects, plus the hub
catalog and sync status, across four tab-bar screens (Today, Tasks,
Catalog, Sync). It consumes the pi-free `kankaku/domain`, `kankaku/hub` and
`kankaku/ports` library barrels and never reimplements their aggregation,
formatting or sync-planning logic.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no Ink, no React, no `Date.now()`.
  `nav-model.ts` (the four screens and the tab bar), `today-model.ts`,
  `tasks-model.ts` (rows from kankaku's own `buildTasks`, truncated
  prompt, newest first), `catalog-model.ts` (clients → active projects
  with open/doing hub-task counts, age/staleness from an injected `now`)
  and `sync-model.ts` (rows from kankaku's `SyncStatusSnapshot`, one per
  project) never call a kankaku adapter directly — only its `domain`/`hub`
  barrel types.
- `src/ports/` holds interfaces only (`ProjectSource`).
- `src/adapters/` talks to the filesystem and the hub: `tui-config.ts`,
  `project-discovery.ts`, `worklog-reader.ts` (kankaku's `JsonlWorkLog`),
  and `hub.ts` — credentials (`resolveHub`, wrapping kankaku's
  `resolveHubCredentials`), the disk-backed catalog (`createCatalog`/
  `refreshCatalog`, kankaku's `CachedCatalog`), no-network status
  (`computeProjectSyncStatus`, kankaku's `computeSyncStatus`) and a
  per-project sync (`syncProject`, mirroring kankaku-claude's
  `sync-cli.ts#syncConfigured` but scoped to one explicit `ProjectRef`
  rather than `cwd`, stamped `agent: "unknown"`, `plugin: "kankaku-tui"`
  as kankaku's `hub-entry.ts` fallback — an orchestrator record's own
  `agent` still wins when it has one).
- `src/ui/` holds Ink components: `app.tsx` (the tab bar + active screen,
  global `1`-`4`/`q`), `today-screen.tsx`, `tasks-screen.tsx`,
  `catalog-screen.tsx`, `sync-screen.tsx`.
- `src/cli.tsx` only wires argv parsing to config, discovery, the domain
  model and rendering (`today`/`tasks`/`catalog [refresh]`/
  `sync [status|all] [--project <dir>]`, plus the interactive default).
  Do not put logic there.
- Dependencies point inwards: adapters and ui import domain and ports;
  domain imports nothing outside `src/domain/` and `src/ports/`.

## Build step

Node 24 can type-strip plain TypeScript directly but cannot strip JSX, so
this repo has a build step: `npm run build` runs `tsc -p tsconfig.build.json`
into `dist/`, and the `kankaku` bin points at `dist/cli.js`. Tests run
through `tsx` (`node --import tsx --test`), which does transform JSX, so
`npm test` needs no prior build.

## Code conventions

- Strict TDD: write the failing test in `tests/` first, then implement.
- Tests use `node:test` and `node:assert/strict`; UI tests use
  `ink-testing-library` (`render`, `lastFrame`, `stdin.write`). No real
  timers, no network (hub-facing adapter/CLI tests inject a fake `fetch`
  that never touches the real hub).
- **Ink-testing-library gotcha**: a `stdin.write(...)` that triggers a
  `setState` is followed by an async render flush (`useEffectEvent`
  scheduling plus Ink's own commit) — `lastFrame()` read synchronously
  right after `stdin.write` can still show the pre-update frame. A test
  asserting on the rendered frame after a key press must `await` a short
  `setTimeout` first; a test that only asserts on a side channel (e.g. a
  `load`/`syncOne` call being recorded) does not need to, since the
  handler itself runs synchronously. `ink-testing-library`'s stub stdout
  also never emits ANSI codes, so a selection highlight must be a visible
  text marker (e.g. `"› "`), not `<Text inverse>`/`bold` alone.
- Relative imports include the `.ts`/`.tsx` extension; `verbatimModuleSyntax`
  is on.
- No runtime dependencies beyond `ink`, `react` and `kankaku`.
- Code, comments, docs and commit messages are in English, neutral register.

## Verification before calling work done

```
npm run check   # build + tsc --noEmit + node --test tests/*
```

## Git

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not commit `.kankaku/`, `dist/`, `node_modules/`, or `odd/`.
