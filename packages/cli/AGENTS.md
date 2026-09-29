# kankaku (CLI) — agent guidelines

The `kankaku` package (formerly `kankaku-tui`; the hub context identifier
`plugin: "kankaku-tui"` is kept on purpose) is a standalone terminal app, built with [Ink](https://github.com/vadimdemedes/ink)
on Node 24, that reads every project's `.kankaku/worklog.jsonl` under a
configurable list of roots and shows the day across projects, plus the hub
catalog and sync status, across four tab-bar screens (Dashboard, Tasks,
Catalog, Sync). It consumes the pi-free `kankaku-pi/domain`, `kankaku-pi/hub` and
`kankaku-pi/ports` library barrels (package `kankaku-pi`) and never reimplements their aggregation,
formatting or sync-planning logic.

## Architecture (hexagonal)

- `src/domain/` is pure: no I/O, no Ink, no React, no `Date.now()`.
  `nav-model.ts` (the four screens, the tab bar, and `NavState` — the
  active screen plus an optional Tasks `projectFilter`, set by
  `openProjectInTasks` and cleared by `clearProjectFilter`, and an optional
  `modal` flag, set by `setModal` while the Tasks screen's reassignment
  picker is open), `today-model.ts`,
  `tasks-model.ts` (rows from kankaku's own `buildTasks`, truncated and
  full prompt, waiting time, cache hit and subagent count, newest first),
  `catalog-model.ts` (clients → active projects with open/doing hub-task
  counts, age/staleness from an injected `now`), `sync-model.ts` (rows
  from kankaku's `SyncStatusSnapshot`, one per project) and
  `reassign-model.ts` (the Tasks screen's reassignment planner:
  `planReassignment` validates a `{ clientId, projectId?, hubTaskId? }`
  selection against the catalog — client active, project active and of
  that client, task of that project and not done — and rejects the whole
  plan with a message on any inconsistency, never returning a payload for
  it; otherwise it returns one line per asked task: `reassign` (names
  `from` → `to` plus the `{ client, project, task }` payload, `""` for an
  empty relation), `unchanged` (the row already has exactly that
  assignment) or `skipped` (`not on the hub yet — sync first`, or, in
  `bulk` mode, `already assigned` for a row not on the catalog's
  unassigned client); `describeAssignment` and `eligibleForBulk` are
  shared with the UI; user-facing strings carry names, never ids),
  `reassign-picker.ts` (the picker's state machine: steps client →
  project → task → review → applying → result, options per step from the
  catalog, the task step skipped for `no project`, wrap-free
  `moveSelection`/`jumpSelection`, `advance`/`back` returning `undefined`
  when the picker closes, the review plan computed by `advance`, plus the
  heading, list rows and footer hints of every step — the list itself is
  windowed by `ui/components/table.tsx`, which uses `list-window.ts`),
  `dashboard-model.ts` (the Dashboard screen's model: today's
  total/per-project rows reused from `today-model.ts#buildTodayRows` with
  an added `share`, a 7-point last-7-days work/cost series via kankaku's
  own `summarize` per day, and the Hub card built from per-project sync
  snapshots plus an optional catalog summary — every "now" is injected,
  never `Date.now()`, and — when the configured hub is this machine's own
  local install — a `localHub` field carrying its `running`/`stopped`
  state, injected by `cli.tsx#loadDashboard` from `hub-manager/process.ts`'s
  pid liveness, never a network call) and `quick-actions.ts` (the
  Dashboard's `[ Quick actions ]` panel: the fixed `QUICK_ACTIONS` list —
  `c` refresh catalog, `s` sync all projects, `S` full sync all, `r`
  reload — plus `LOCAL_HUB_ACTION` (`h` start/stop local hub), appended by
  `quickActionsFor(showLocalHub)` only when the Dashboard's
  `DashboardActions.localHub` is present, and `formatQuickActionLines`,
  the panel's own one-line status text for its idle/busy/done/unavailable
  `QuickActionState`) never call a kankaku adapter directly — only its
  `domain`/`hub` barrel types — and `local-hub-model.ts` (pure local-hub
  domain, shared by the CLI's `kankaku hub *` commands and the setup
  wizard's `install locally` option: `parseHubManifest`/`parseHubConfig`
  validate `kankaku-hub`'s `hub-manifest.json`/the installed `hub.json`;
  `assetKeyFor` maps `process.platform`/`arch` to the manifest's
  PocketBase asset key; `hubLayout` is the `~/.kankaku/hub/` on-disk
  layout — `bin/pocketbase`, `pb_data/`, `app/<version>/`, `current`,
  `hub.json`, `accounts.json`, `pid`, `hub.log`; `serveArgs` is the
  `pocketbase serve` argv for one app version/port; `classifyStatus`
  turns plain installed/pid-alive/health facts into one `HubStatus`
  (`not-installed`/`stopped`/`running`/`unhealthy`); `generatePassword` is
  the injected-RNG, 24-char password policy shared by every account this
  package creates) and `setup-plan.ts` (`kankaku setup`/`kankaku doctor`'s domain:
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
  `WizardState` — the current `WizardStep` (`agents`/`claude`/`hub`/
  `roots`/`review`/`apply`/`done` — Detect was merged into Agents:
  `agents` is the first step, its checklist rows carry detection for
  every agent via `detectAgents`, and `esc` from it quits instead of
  going back), the in-progress answers, the computed `plan` and the
  applied `results` — plus reducers (`createWizardState` builds it from a
  `WizardFacts`, reusing `detectAgents` and guessing the Claude checkout
  from an existing `statusLine` via `guessClaudeCheckout`;
  `toggleAgent`/`setClaudeCheckout`/`setHubMode`/`setHubField`/
  `setHubHealth`/`setRoots` update one field each, clearing its own error
  — the Hub step's `local` mode asks for `ownerEmail`/`ownerPassword`
  (also via `setHubField`, `HubField` extended with those two keys) since
  installing locally now runs the real `hub-manager/install.ts#installHub`
  on the port the Hub step's `port` field holds (`WizardHubState.port`, digits only 1024-65535, `parseHubPort`; prefilled with the first free port from `DEFAULT_HUB_PORT` (8090) upwards or an existing install's own `WizardHubFacts.localPort`; `setHubPortInUse` flags an occupied one), not a checkout path; a `WizardAction.note` is an extra Review line — `install-local-hub` says whether the sync credentials move to the local hub or stay on the existing one; `next`/`back` validate and step
  through — skipping the Claude step when it isn't needed (`claudeStepNeeded`,
  exported so `ui/setup/wizard-screen.tsx` can number only the steps a run
  will actually show), and never advancing out of `apply` until every
  planned action has a result; `planFromWizard` diffs the current answers
  against `WizardFacts`' on-disk state into an ordered `WizardAction[]`,
  computed once on `roots` → `review`; `applyResult` appends one
  `ApplyResult`; `hintsForStep` is the footer's own per-step key hints;
  `shortenHome` replaces a leading `WizardFacts.homeDir` with `~` for a
  displayed file path — pure, so the home directory is threaded in rather
  than read from `node:os`). No I/O — every caller
  (`ui/setup/wizard-screen.tsx`, `cli.tsx`) reads the real files and
  passes plain facts in, exactly like `setup-plan.ts`.
- `src/ports/` holds interfaces only (`ReassignActions` — the Tasks
  screen's hub side, `prepare` and `apply`, neither throwing; `ProjectSource` and `Prompter` —
  `confirm`/`text`/`secret`, injected into `kankaku setup`'s interactive
  prompts so a scripted fake can drive it in tests; `--yes` never calls it
  at all).
- `src/adapters/` talks to the filesystem and the hub: `tui-config.ts`,
  `project-discovery.ts` (`discoverProjects` searches each root
  recursively, up to `options.maxDepth` directory levels below it
  (default 5): a directory with `.kankaku/worklog.jsonl` is a project,
  and the search still continues below it — a pi session run once in a
  parent such as `~/desarrollo` leaves a worklog there that must never
  hide the projects beneath; every directory is listed at most once;
  subdirectories are searched one level deeper, skipping `node_modules`,
  `.git` and any hidden directory; deduped by real/symlink-resolved path, `name` is the
  basename or, when two discovered projects share one, the last two path
  segments joined with `/`; never throws on an unreadable or missing
  directory), `worklog-reader.ts` (kankaku's `JsonlWorkLog`),
  `app-info.ts` (`readOwnVersion`, this package's own version for the
  header bar), `package-versions.ts` (`readCarriedVersions`, the versions of `kankaku-pi`/`kankaku-claude`/`kankaku-hub` for `kankaku --version`, text from `domain/version-info.ts`), `hub-reassign.ts` (the hub side of the Tasks screen's `a`/`A`, through the published `kankaku-pi/hub` client so auth, the 401 re-auth and the per-request time bound are the client's own: `fetchHubRows` finds `task_entries` rows by `task_id` in chunks of 30 with the exported `escapeFilterValue` and maps them by kankaku task id, tolerating empty relations; `applyReassignment` sends one `PATCH /api/collections/task_entries/records/<rowId>` per `reassign` line with exactly `{ client, project, task }` — `""` for an empty relation, never `legacy_client_label` or any measurement field — one row after the other, a failure recorded per row (`describeHubError` gives a plain reason, no URL or id) without stopping the rest; `createReassignActions` builds the `ports/reassign-actions.ts` `ReassignActions` the UI receives: `prepare` reads the rows and refreshes the catalog under one overall bound, `apply` patches and then refreshes the catalog; sync stays create-only, this is the only path that changes an existing row's assignment), and `hub.ts` — credentials (`resolveHub`, wrapping kankaku's
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
  `src/statusline.ts`); `claude-commands.ts` (`writeClaudeCommands`/
  `removeClaudeCommands` — generate and remove the `/kankaku:*` user
  commands under `~/.claude/commands/kankaku/` from the plugin's
  `commands/*.md`, touching only files recognised as ours by
  `domain/claude-integration.ts#ourCommandFileRoot` and reporting the
  rest as foreign); `hub.ts` (`writeHubCredentials`, 0600, `~/.kankaku`
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
  isn't present); and `local-hub.ts` (the hub-developer-only, checkout-based
  install kept behind `kankaku setup --from-checkout <dir>` — never part
  of the interactive wizard any more, see H4 below: `findHubCheckout`
  picks the first candidate path that looks like a `kankaku-hub` checkout
  — has `scripts/dev.sh` and `pocketbase/pb_migrations`; `installLocalHub`
  downloads PocketBase (skipped if already present), starts
  `scripts/dev.sh` detached (pid/log under `~/.kankaku/hub/`) through the
  injected `ScriptRunner` (`ports/script-runner.ts`; the real one,
  `child-process-runner.ts`, wraps `node:child_process` — tests always
  inject a fake, never spawning the real hub), polls its health endpoint
  for up to ~20s, then runs `scripts/create-dev-accounts.sh` and returns
  that script's own hardcoded dev service-account credentials;
  `manualCommands` is the exact command list shown when no checkout is
  found). `adapters/hub-manager/` is the real local-hub lifecycle (used by
  `kankaku hub *` and the wizard's `install locally` option): `package.ts`
  (`locateHubPackage`, resolves the installed `kankaku-hub` npm package
  via `require.resolve`/an injected resolver and reads/validates its
  `hub-manifest.json`); `download.ts` (`downloadPocketBase`, fetches a
  release zip, verifies its SHA256 against the manifest, extracts the
  single `pocketbase` entry via a tiny zip reader — `node:zlib`
  `inflateRaw` for a deflated entry, no dependency — and writes it mode
  0755 via temp file + rename; `zip.ts`'s `extractSingleEntry` is the
  reader); `process.ts` (`startDetached` spawns detached and writes a pid
  file; `readPid`/`isAlive` — an `EPERM` counts as alive, a different
  owner still on this machine; `stopProcess` — SIGTERM with a bounded
  poll, SIGKILL as a last resort, always removes the pid file;
  `waitForHealth` polls a URL until it responds ok or times out); and
  `credentials.ts` (`readServiceAccount`/`writeServiceAccount` — the local hub's service account in `service.json`, 0600, always written by install — and `useLocalHub`, `kankaku hub use`: points `~/.kankaku/credentials.json` at it, one-time `.bak`; install itself writes `credentials.json` only when none exists or it already points at the local hub, decided by the pure `shouldWriteCredentials`); `port-probe.ts` (`isPortFree`/`firstFreePort` — bind `127.0.0.1:<port>` through an injectable `PortBinder`, `HubManagerDeps.portBinder`; only one test uses the real binder); and `accounts.ts` (`upsertSuperuser` shells `pocketbase superuser upsert`
  through a `ScriptRunner`, offline, no running server needed; `createUser`
  authenticates as that superuser over REST and idempotently creates an
  owner/service application user). `install.ts` orchestrates all of the
  above plus `domain/local-hub-model.ts` into `installHub`/`startHub`/
  `stopHub`/`hubStatus`/`upgradeHub`/`hubLogs` — see "Local hub" in
  README for the exact on-disk layout and idempotency contract; every
  step's outcome (`done`/`unchanged`/`error`) is reported so `cli.tsx`'s
  `kankaku hub *` commands and the wizard's apply step can show it
  verbatim.
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
  model reloading once it settles; `localHub`, present only when the
  configured hub is this machine's own local install, adds the `h` quick
  action and its own extra Hub-card line — `showLocalHub` (from
  `actions.localHub !== undefined`) threads through `quickActionsFor`/
  `hubPanelRows`/`quickActionsPanelRows` so the panel heights only grow
  when a local hub is actually configured, keeping every existing
  no-local-hub layout byte-for-byte unchanged), `reassign-panel.tsx` (the reassignment picker drawn as one fixed-height `Panel` over the Tasks content zone: two heading lines and a windowed `Table`, so a long list scrolls inside it) and `tasks-screen.tsx` (table left,
  `[ Task ]` detail panel right; `t` toggles today/all, `a` reassigns the
  selected task and `A` every task of the view that is unassigned on the
  hub, through its `reassign` prop (`ReassignActions`) — `prepare` first,
  a progress message in the footer meanwhile (`Layout`'s `footerNote`,
  which replaces the key hints on the same one-line footer), then the
  picker; the picker is modal: while it is open or the hub is being asked,
  every other key of the screen is inert and `onModalChange` tells
  `app.tsx` to set `NavState.modal`, under which the app-level
  `esc`/`←`/`Tab`/`1`-`4` do nothing and only `q` still quits; the hub's
  assignment for the rows asked about shows as a `hub …` line in the
  detail panel; `esc clear filter` is in the footer hints only while a
  filter is set, so the line stays within 100 columns), `catalog-screen.tsx` (`[ Clients ]`
  left, the selected client's `[ Projects ]` right), `sync-screen.tsx`
  (one card per project in a wrapping grid). Every screen renders its own
  `Layout`, so it stays a self-contained, independently testable unit.
  `setup/wizard-screen.tsx` (`SetupWizard`) is the same idea applied to
  `kankaku setup`, but renders its own header/panel/footer frame directly
  instead of `Layout` — there is no sidebar in the wizard: its progress
  lives in the panel's own title instead (`[ Setup · Agents 1/5 ]`,
  numbering only the steps this run will actually show via
  `domain/setup-wizard.ts#claudeStepNeeded` — Claude Code is dropped from
  the count when it isn't needed; `apply`/`done` render unnumbered, `apply`
  being Review's own execution rather than a step the user navigates to).
  One `[ Setup · <Step> [n/total] ]` `Panel` per step, driven entirely by
  `domain/setup-wizard.ts`'s reducers (`useState<WizardState>`). It never
  talks to the filesystem or network
  directly — everything real goes through its own `WizardActions` prop
  (just `apply` and `checkHealth`, built by `cli.tsx`). `apply` takes the
  current `WizardState` alongside the planned `WizardAction`, since `file`
  on a `WizardAction` is always the target path (or, for
  `install-local-hub`, the local hub's URL) never the value to write —
  `write-claude`/`write-hub`/`write-roots` read the checkout/hub
  fields/roots from `state` instead, and `install-local-hub` reads
  `state.hub.ownerEmail`/`ownerPassword` and runs the real
  `hub-manager/install.ts#installHub` (`cli.tsx`'s `applyWizardAction`),
  reporting every install step in the result detail. The Hub step tracks
  its own `hubFocus` cursor (Tab cycles it) so only one field is ever
  `focused` at a time, and gates `q`/`c` behind "is a text field currently
  focused" the same way the Claude/Roots steps gate `q` — a text input
  always consumes its own printable keys first; `c` (health check) only
  applies to `existing` mode now, since `local` mode has nothing running
  yet to check.
- `src/cli.tsx` only wires argv parsing to config, discovery, the domain
  model and rendering (`today`/`tasks`/`catalog [refresh]`/
  `sync [status|all] [--project <dir>]`/`setup [--yes] [--dry-run]
  [--from-checkout <dir>]`/`doctor`/`hub install|use|start|stop|status|upgrade|logs`/`--version`,
  plus the interactive default — the `today` subcommand name is unrelated
  to the Dashboard screen's own name and stays as-is).
  `loadDashboard` builds the Dashboard screen's model from the same
  project/record discovery as `loadToday`/`loadTasks`, adding the Hub card
  from local no-network sync status and the cached catalog (never a
  network call on its own) — plus, via `detectLocalHub` (also no network:
  `hubLayout`'s `hub.json` port matched against the resolved credentials'
  URL, then pid liveness only), the local hub's `running`/`stopped` state
  when the configured hub is this machine's own install. `dashboardActionsDeps`
  builds its Quick actions deps, reusing `adapters/hub.ts`'s `createCatalog`/
  `refreshCatalog`/`syncProject` and kankaku's own `formatCatalogRefreshLines`/
  `formatSyncSummaryLines` for the result message — never reimplemented —
  plus `localHub` (via `localHubAction`), present only under the same
  local-hub detection, whose `toggle` starts or stops it through
  `hub-manager/install.ts#startHub`/`stopHub`.
  `buildHubManagerDeps` builds the injectable dependency bag
  `hub-manager/install.ts` needs (the real `ScriptRunner`, `startDetached`,
  `node:crypto#randomBytes`, `locateHubPackage`, `process.platform`/`arch`),
  shared by `runHubCommand` (`kankaku hub *`, printing every
  `HubActionReport` step as `<step>: <outcome> (<detail>)`, `hub install`
  prompting for a missing owner email/password on a TTY through the
  injected `Prompter`, requiring both flags otherwise) and the wizard's
  `install-local-hub` action — `CliDeps.hubManager` lets tests override
  any of it so nothing ever spawns a real PocketBase or hits the network.
  `runDoctorCommand` gathers plain facts (`adapters/setup/agents.ts`, hub
  resolution/health, `tui.json` existence — the only network call, bounded
  to 5s) and prints `domain/setup-plan.ts#formatDoctorLines` verbatim.
  `runSetupCommand` builds the same plan; `--dry-run` prints
  `formatSetupPlanLines` and returns before any prompt or write; otherwise
  each `todo` step is asked through the injected `Prompter` (`--yes`
  answers every question with its own default instead, never touching the
  prompter) and, when confirmed, written through the matching
  `adapters/setup/*` writer, ending with the same report as `doctor` — the
  hub section instead runs `performLocalHubInstallFromCheckout` (never
  prompting) when `--from-checkout <dir>` is given, the hub-developer-only
  path onto `adapters/setup/local-hub.ts#installLocalHub`.
  `setup` opens the interactive wizard instead of this readline flow when
  stdout is a real TTY (`CliDeps.isTTY`) and neither `--yes` nor
  `--dry-run` nor `--from-checkout` was given — those always keep the
  non-interactive path even on a TTY. `kankaku` with no subcommand does
  the same the first time (no `~/.kankaku/tui.json` yet); `gatherWizardFacts`
  (read-only, no network — the hub's health is checked interactively from
  the wizard's own Hub step) and `buildWizardActions` (wiring `apply`/
  `checkHealth`, `applyWizardAction` mapping each `WizardActionKind` to
  its writer, `install-local-hub` running `hub-manager/install.ts#installHub`
  via `buildHubManagerDeps`) build `<App>`'s `wizard` prop; both are used
  only from the real `renderApp`, exactly like
  `dashboardActionsDeps`/`catalogScreenDeps`/`syncScreenDeps`/`reassignScreenDeps` (the Tasks screen's `ReassignActions`, unavailable-with-a-reason when the hub has no credentials). Do not put
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
- No runtime dependencies beyond `ink`, `react` and `kankaku-pi`.
- Code, comments, docs and commit messages are in English, neutral register.

## Verification before calling work done

```
npm run check   # build + tsc --noEmit + node --test tests/*
```

## Git

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`).
- Do not commit `.kankaku/`, `dist/`, `node_modules/`, or `odd/`.
