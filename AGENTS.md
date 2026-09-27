# kankaku-tui — agent guidelines

kankaku-tui is a standalone terminal app, built with [Ink](https://github.com/vadimdemedes/ink)
on Node 24, that reads every project's `.kankaku/worklog.jsonl` under a
configurable list of roots and shows the day across projects, plus the hub
catalog and sync status, across four tab-bar screens (Dashboard, Tasks,
Catalog, Sync). It consumes the pi-free `kankaku/domain`, `kankaku/hub` and
`kankaku/ports` library barrels and never reimplements their aggregation,
formatting or sync-planning logic.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no Ink, no React, no `Date.now()`.
  `nav-model.ts` (the four screens, the tab bar, and `NavState` — the
  active screen plus an optional Tasks `projectFilter`, set by
  `openProjectInTasks` and cleared by `clearProjectFilter`), `today-model.ts`,
  `tasks-model.ts` (rows from kankaku's own `buildTasks`, truncated and
  full prompt, waiting time, cache hit and subagent count, newest first),
  `catalog-model.ts` (clients → active projects with open/doing hub-task
  counts, age/staleness from an injected `now`), `sync-model.ts` (rows
  from kankaku's `SyncStatusSnapshot`, one per project) and
  `dashboard-model.ts` (the Dashboard screen's model: today's
  total/per-project rows reused from `today-model.ts#buildTodayRows` with
  an added `share`, a 7-point last-7-days work/cost series via kankaku's
  own `summarize` per day, and the Hub card built from per-project sync
  snapshots plus an optional catalog summary — every "now" is injected,
  never `Date.now()`) and `quick-actions.ts` (the Dashboard's `[ Quick
  actions ]` panel: the fixed `QUICK_ACTIONS` list — `c` refresh catalog,
  `s` sync all projects, `S` full sync all, `r` reload — and
  `formatQuickActionLines`, the panel's own one-line status text for its
  idle/busy/done/unavailable `QuickActionState`) never call a kankaku
  adapter directly — only its `domain`/`hub` barrel types — and
  `setup-plan.ts` (`kankaku setup`/`kankaku doctor`'s domain:
  `detectAgents` turns plain, already-read facts about pi, gentle-shell,
  Claude Code, Codex and OpenCode into one `AgentStatus` per agent —
  `present`/`configured`/`adapterAvailable`/`detail`, with `configured`
  for a pi-family `packages` entry decided by the exported
  `isKankakuPackage`, reused by `adapters/setup/pi.ts` so "is this already
  kankaku" is never defined twice; `planSetup` turns those plus hub/`tui.json`
  facts into an ordered `SetupStep[]` (`done`/`todo`/`unavailable`, an
  `action` description and the exact `file` a `todo` step would change);
  `formatDoctorLines` and `formatSetupPlanLines` render that plan as plain
  text for `doctor` and `setup --dry-run` respectively), and
  `setup-wizard.ts` (`kankaku setup`'s interactive wizard state: one
  `WizardState` — the current `WizardStep` (`detect`/`agents`/`claude`/
  `hub`/`roots`/`review`/`apply`/`done`), the in-progress answers, the
  computed `plan` and the applied `results` — plus reducers
  (`createWizardState` builds it from a `WizardFacts`, reusing
  `detectAgents` and guessing the Claude checkout from an existing
  `statusLine` via `guessClaudeCheckout`; `toggleAgent`/`setClaudeCheckout`/
  `setHubMode`/`setHubField`/`setHubHealth`/`setRoots`/`setLocalCheckout`/
  `setHubLocalManual` update one field each, clearing its own error;
  `next`/`back` validate and step through — skipping the Claude step when
  it isn't needed, and never advancing out of `apply` until every planned
  action has a result; `planFromWizard` diffs the current answers against
  `WizardFacts`' on-disk state into an ordered `WizardAction[]`, computed
  once on `roots` → `review`; `applyResult` appends one `ApplyResult`;
  `hintsForStep` is the footer's own per-step key hints). No I/O — every
  caller (`ui/setup/wizard-screen.tsx`, `cli.tsx`) reads the real files
  and passes plain facts in, exactly like `setup-plan.ts`.
- `src/ports/` holds interfaces only (`ProjectSource` and `Prompter` —
  `confirm`/`text`/`secret`, injected into `kankaku setup`'s interactive
  prompts so a scripted fake can drive it in tests; `--yes` never calls it
  at all).
- `src/adapters/` talks to the filesystem and the hub: `tui-config.ts`,
  `project-discovery.ts`, `worklog-reader.ts` (kankaku's `JsonlWorkLog`),
  `app-info.ts` (`readOwnVersion`, this package's own version for the
  header bar), and `hub.ts` — credentials (`resolveHub`, wrapping kankaku's
  `resolveHubCredentials`), the disk-backed catalog (`createCatalog`/
  `refreshCatalog`, kankaku's `CachedCatalog`), no-network status
  (`computeProjectSyncStatus`, kankaku's `computeSyncStatus`) and a
  per-project sync (`syncProject`, mirroring kankaku-claude's
  `sync-cli.ts#syncConfigured` but scoped to one explicit `ProjectRef`
  rather than `cwd`, stamped `agent: "unknown"`, `plugin: "kankaku-tui"`
  as kankaku's `hub-entry.ts` fallback — an orchestrator record's own
  `agent` still wins when it has one). `adapters/setup/` is `kankaku
  setup`'s own read/write layer, used only by `cli.tsx`'s `setup`/`doctor`
  handlers: `agents.ts` (`readAgentFacts`, never throws — a missing or
  malformed settings file reads as absent, exactly like
  `adapters/tui-config.ts#readTuiConfig`); `json-writer.ts` (the shared
  read-existing-or-`{}`, tmp+rename and one-time `<file>.bak` primitives
  every setup writer below is built on, mirroring kankaku's own
  `project-config.ts#writeProjectTargetIds`); `pi.ts` (`addKankakuPackage`
  — adds `"npm:kankaku"` to a pi-family `packages` array, shared by both
  `~/.pi/agent/settings.json` and `~/.gentle-shell/agent/settings.json`
  since they're the same shape, preserving every other key and its
  order); `claude.ts` (`writeStatusLine` — sets Claude Code's
  `statusLine.command` to run a given `kankaku-claude` checkout's
  `src/statusline.ts`); `hub.ts` (`writeHubCredentials`, 0600, `~/.kankaku`
  created 0700 only when it does not exist yet — an already-existing
  `~/.kankaku` is never chmod'd, mirroring kankaku's own R2 rule since the
  directory is shared with kankaku's worklog storage; `checkHubHealth`,
  `GET <url>/api/health` through an injectable `fetch` under a 5s
  timeout, `false` on any error/non-ok/timeout, never throws); `tui-config.ts`
  (`writeTuiConfig`, this app's own `~/.kankaku/tui.json` writer — reading
  it for normal use stays `adapters/tui-config.ts#readTuiConfig`); and
  `readline-prompter.ts` (`createReadlinePrompter`, the real `Prompter`:
  `node:readline/promises` over given input/output streams; `secret()`
  hides typed input by routing readline's own per-keystroke echo through
  a `Writable` that swallows bytes while muted); `pi.ts`/`claude.ts` also
  export the wizard's own removal writers, `removeKankakuPackage`/
  `removeStatusLine` (a no-op, with no backup and no write, when kankaku
  isn't present); and `local-hub.ts` (the wizard's "install locally" hub
  option, level 1: `findHubCheckout` picks the first candidate path that
  looks like a `kankaku-hub` checkout — has `scripts/dev.sh` and
  `pocketbase/pb_migrations`; `installLocalHub` downloads PocketBase
  (skipped if already present), starts `scripts/dev.sh` detached (pid/log
  under `~/.kankaku/hub/`) through the injected `ScriptRunner`
  (`ports/script-runner.ts`; the real one, `child-process-runner.ts`,
  wraps `node:child_process` — tests always inject a fake, never spawning
  the real hub), polls its health endpoint for up to ~20s, then runs
  `scripts/create-dev-accounts.sh` and returns that script's own
  hardcoded dev service-account credentials; `manualCommands` is the exact
  command list shown when no checkout is found).
- `src/ui/` holds Ink components and the visual system: `theme.ts` (colour
  roles, the default dark/cyan preset, and a `ThemeProvider`/`useTheme`
  context — written with `createElement`, not JSX, so it stays a plain
  `.ts` module), `layout.tsx` (the shared header/sidebar/footer frame,
  responsive to `columns`/`rows` via `useStdout()` or forced props: a
  side-by-side sidebar at 100+ columns, a full-width sidebar stacked above
  main content at 70-99, and a one-line tab strip below 70 — `children` is
  a render function so a screen can size its own panels to the actual
  main-content width), `components/` (`panel.tsx` — a rounded, titled
  frame with the title inside the top border and an optional right-aligned
  header note; `table.tsx` — an aligned table with a `› `-marked selected
  row; `bar.tsx`/`sparkline.tsx` — text bars and block-character
  sparklines, each also exporting a plain-string `render*` helper for
  reuse inside a `Table` cell; `sidebar.tsx`, `header-bar.tsx`,
  `key-hints.tsx`; `text-input.tsx` — a fully-controlled single-line input
  (printable characters insert at the cursor, ←/→/Home/End move it,
  Backspace/Delete remove, Enter calls `onSubmit`, a `▏` cursor marker
  only while `focused`, `masked` renders `•` for every character, e.g. a
  password field); `checklist.tsx` — `[x]`/`[ ]`/`[-] … (note)` rows,
  Space toggles the row at `cursor` (never a disabled one), ↑/↓ call
  `onMove`; `radio.tsx` — `(•)`/`( )` single-select, ↑/↓ select the
  previous/next option directly), `app.tsx` (owns `NavState`, global
  `1`-`4`/`q`, and wires Dashboard's `enter`-on-a-project to Tasks'
  `projectFilter`; also owns `showWizard` — when `AppProps.startInWizard`
  is set, renders `setup/wizard-screen.tsx#SetupWizard` in place of the
  four-screen shell instead, with its own global `useInput` disabled
  (`isActive: !showWizard`) so the wizard owns every keystroke itself;
  `onDone` just drops back to the normal shell — Dashboard's own
  `useState(load)` mounts fresh and reloads on its own, so nothing else
  needs to force a reload),
  `dashboard-screen.tsx` (the home screen: a Today card — it shows today's
  numbers, hence its own title, unrelated to the screen's own name — Last
  7 days sparklines, Projects table with share bars, Hub card and the
  `[ Quick actions ]` panel, wired to its `DashboardActions` prop:
  `refreshCatalog`/`syncAll` from `cli.tsx`, one action at a time, the
  model reloading once it settles), `tasks-screen.tsx` (table left,
  `[ Task ]` detail panel right), `catalog-screen.tsx` (`[ Clients ]`
  left, the selected client's `[ Projects ]` right), `sync-screen.tsx`
  (one card per project in a wrapping grid). Every screen renders its own
  `Layout`, so it stays a self-contained, independently testable unit.
  `setup/wizard-screen.tsx` (`SetupWizard`) is the same idea applied to
  `kankaku setup`: one `Layout` whose sidebar lists the wizard's seven
  named steps (`apply` has no row of its own — it's Review's own
  execution, so it maps to Review's row while running) with `✓` on
  completed ones, and whose main area is one `[ Setup · <Step> ]` `Panel`
  per step, driven entirely by `domain/setup-wizard.ts`'s reducers
  (`useState<WizardState>`). It never talks to the filesystem or network
  directly — everything real goes through its own `WizardActions` prop
  (`apply`, `checkHealth`, `findHubCheckout`, `manualCommands`,
  `installLocalHub`, built by `cli.tsx`). `apply` takes the current
  `WizardState` alongside the planned `WizardAction`, since `file` on a
  `WizardAction` is always the target path, never the value to write —
  `write-claude`/`write-hub`/`write-roots` read the checkout/hub
  fields/roots from `state` instead. The Hub step tracks its own
  `hubFocus` cursor (Tab cycles it) so only one field is ever
  `focused` at a time, and gates `q`/`c`/`m` behind "is a text field
  currently focused" the same way the Claude/Roots steps gate `q` — a
  text input always consumes its own printable keys first.
- `src/cli.tsx` only wires argv parsing to config, discovery, the domain
  model and rendering (`today`/`tasks`/`catalog [refresh]`/
  `sync [status|all] [--project <dir>]`/`setup [--yes] [--dry-run]`/
  `doctor`, plus the interactive default — the `today` subcommand name is
  unrelated to the Dashboard screen's own name and stays as-is).
  `loadDashboard` builds the Dashboard screen's model from the same
  project/record discovery as `loadToday`/`loadTasks`, adding the Hub card
  from local no-network sync status and the cached catalog (never a
  network call on its own). `dashboardActionsDeps` builds its Quick
  actions deps, reusing `adapters/hub.ts`'s `createCatalog`/
  `refreshCatalog`/`syncProject` and kankaku's own `formatCatalogRefreshLines`/
  `formatSyncSummaryLines` for the result message — never reimplemented.
  `runDoctorCommand` gathers plain facts (`adapters/setup/agents.ts`, hub
  resolution/health, `tui.json` existence — the only network call, bounded
  to 5s) and prints `domain/setup-plan.ts#formatDoctorLines` verbatim.
  `runSetupCommand` builds the same plan; `--dry-run` prints
  `formatSetupPlanLines` and returns before any prompt or write; otherwise
  each `todo` step is asked through the injected `Prompter` (`--yes`
  answers every question with its own default instead, never touching the
  prompter) and, when confirmed, written through the matching
  `adapters/setup/*` writer, ending with the same report as `doctor`.
  `setup` opens the interactive wizard instead of this readline flow when
  stdout is a real TTY (`CliDeps.isTTY`) and neither `--yes` nor
  `--dry-run` was given — both flags always keep the non-interactive path
  even on a TTY. `kankaku` with no subcommand does the same the first time
  (no `~/.kankaku/tui.json` yet); `gatherWizardFacts` (read-only, no
  network — the hub's health is checked interactively from the wizard's
  own Hub step) and `buildWizardActions` (wiring every `WizardActions`
  method to the real `adapters/setup/*` writers, `applyWizardAction`
  mapping each `WizardActionKind` to its writer) build `<App>`'s `wizard`
  prop; both are used only from the real `renderApp`, exactly like
  `dashboardActionsDeps`/`catalogScreenDeps`/`syncScreenDeps`. Do not put
  logic there beyond this wiring.
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
  handler itself runs synchronously. Colour is disabled for every test run
  by `tests/setup.mjs` (`--import`ed before tsx in the `test` script), so
  `lastFrame()` is plain text on a TTY and in a pipe alike — on a real
  terminal Ink would otherwise emit ANSI codes and text assertions would
  break. A selection highlight must therefore be a visible text marker
  (e.g. `"› "`), never colour alone.
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
