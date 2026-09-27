# kankaku-tui — agent guidelines

kankaku-tui is a standalone terminal app, built with [Ink](https://github.com/vadimdemedes/ink)
on Node 24, that reads every project's `.kankaku/worklog.jsonl` under a
configurable list of roots and shows the day across projects. It consumes
the pi-free `kankaku/domain` and `kankaku/hub` library barrels and never
reimplements their aggregation or formatting logic.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no Ink, no React, no `Date.now()`.
- `src/ports/` holds interfaces only (`ProjectSource`).
- `src/adapters/` talks to the filesystem: config, project discovery, and
  reading worklogs through kankaku's `JsonlWorkLog`.
- `src/ui/` holds Ink components.
- `src/cli.tsx` only wires argv parsing to config, discovery, the domain
  model and rendering. Do not put logic there.
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
  timers, no network.
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
