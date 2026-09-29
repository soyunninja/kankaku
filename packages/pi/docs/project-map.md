# kankaku — project map

Read this first when you pick the project up. It tells you where every
piece lives and how the pieces connect, so you can find the right file
before reading code. The rules of the house (measurement invariants, code
conventions) are in `AGENTS.md`; user-facing behaviour is in `README.md`;
what changed when is in `CHANGELOG.md`. This file only points.

## 1. What this is, in five lines

kankaku is a [pi](https://pi.dev) extension package. It measures how long
an agent works on each prompt (`workMs = wallMs - waitingMs`), appends one
JSON line per prompt to `.kankaku/worklog.jsonl`, joins orchestrator and
subagent records into **tasks**, and can push those tasks to a small
PocketBase **hub** so time is billed to a client, a project and, optionally,
a hub task. In pi's TUI, `/kankaku` opens a settings-like **panel** that
manages all of it; every action is also a `/kankaku <subcommand>`.

Current release: **0.9.0** (2026-09-28). This package now lives inside the
`kankaku` monorepo, at `packages/pi` (npm package `kankaku-pi`). Node 24 runs the TypeScript
directly (type stripping); pi loads `src/extension.ts` straight from the
package (`package.json` → `pi.extensions`).

## 2. This monorepo, and the repositories around it

`kankaku` (the GitHub repo, `github.com/soyunninja/kankaku`) is an npm
workspaces monorepo with three packages, all released in lockstep at the
same version:

| Directory | npm package | What it is |
|---|---|---|
| `packages/pi` (this one) | `kankaku-pi` | the pi extension + published `domain`/`ports`/`hub` library entry points |
| `packages/claude` | `kankaku-claude` | Claude Code plugin, phase 1 (local measurement only); phase 2 parked |
| `packages/cli` | `kankaku` | terminal dashboard across every project on disk, setup wizard, hub install/manage |

`packages/claude` and `packages/cli` both depend on `kankaku-pi ^0.9.0` and
import it as `kankaku-pi/domain`, `kankaku-pi/ports`, `kankaku-pi/hub`. The hub
server and the public site are separate repositories, not part of this
monorepo:

| Repo | Where | What |
|---|---|---|
| `kankaku-hub` | `~/desarrollo/soyun.ninja/kankaku-hub`, `github.com/soyunninja/kankaku_hub` (note the underscore) | PocketBase hub: schema, migrations, web app, `docs/contract.md` (the sync contract) |
| `kankaku-site` | `~/desarrollo/soyun.ninja/kankaku-site` | public site (Astro, en/es/ja); deploy = upload `dist/` |

The hub contract (`kankaku-hub/docs/contract.md`) is the source of truth for
every field kankaku sends. When a payload changes, change the contract first.

## 3. How to work here

```
npm install                             # once, at the monorepo root
npm run check                           # root: builds packages/pi first, then check in each package
npm run check -w kankaku                # this package only (build + typecheck + node --test tests/*.test.ts)
                                         # — assumes packages/pi was already built once for the others
node --test tests/<name>.test.ts        # one file, from packages/pi/
KANKAKU_DIR=/tmp/kankaku-smoke KANKAKU_SYNC_AUTO=0 pi -p --no-session "Reply with exactly the word OK."
                                        # headless smoke: must leave one record in /tmp/kankaku-smoke/worklog.jsonl
npm run e2e:hub / e2e:cross-worktree    # opt-in end-to-end scripts (scripts/), run from packages/pi/
```

`packages/pi` must build before `packages/claude` or `packages/cli`
run anything of their own: they import the compiled `dist/` barrels
through the npm workspace symlink. The root `check` script does this in
the right order; running a package's own `check` directly does not
rebuild its dependencies.

- **Strict TDD**: failing test in `tests/<module>.test.ts` first, then code.
  Every module with behaviour has a test file of the same name; ports,
  barrels and `src/extension.ts` are the exceptions.
- **Hexagonal**: `src/domain/` pure (no I/O, no `Date.now()`, no pi
  imports) → `src/ports/` interfaces → `src/adapters/` touch pi, fs, HTTP.
  `src/extension.ts` only wires. `tests/public-exports.test.ts` fails the
  build if a public barrel reaches a pi import.
- **Commits**: Conventional Commits, English, no AI attribution. A
  pre-commit hook (Gentleman Guardian Angel) reviews staged sources against
  `AGENTS.md`; it is model-based and occasionally fails a clean commit —
  re-running the identical commit is the accepted response.
- **Branches**: `feat/<name>` from `main`; merged with `git merge --ff-only`;
  no pull requests so far.
- **Release, since 0.9.0 (lockstep across the monorepo)**: from the
  repository root, bump all three packages together
  (`npm version 0.Y.Z --workspaces --no-git-tag-version`, or the root
  `npm run release:version --v=0.Y.Z`), add each package's
  `## 0.Y.Z — YYYY-MM-DD` section to its own `CHANGELOG.md`, commit
  `chore(release): prepare 0.Y.Z`, tag `v0.Y.Z`, `git push origin main`
  and `git push origin v0.Y.Z`. Then, **by the owner** (the agent has no
  npm login), publish in dependency order so each package's `kankaku-pi
  ^0.Y.Z` dependency already resolves on the registry:
  `npm publish -w kankaku-pi`, then `npm publish -w kankaku-claude`, then
  `npm publish -w kankaku`. Each package's own `prepublishOnly` (where
  present) runs its own `check`; run the root `npm run check` first
  regardless, since it builds `packages/pi` before checking the
  others. (What was done for 0.5.x–0.8.2, before the monorepo, was the
  same shape but for this package alone.)
- **Trying the working tree in pi**: `gentle-shell` loads
  `packages/pi` as a package (isolated home at
  `~/.gentle-shell/agent`), so whatever branch is checked out is what runs
  there. Plain `pi` loads `npm:kankaku-pi` (or the older `npm:kankaku`); use
  `pi --no-extensions -e /absolute/path/to/kankaku/packages/pi` to
  test locally.

## 4. Data on disk

| Path | Written by | Contents |
|---|---|---|
| `<project>/.kankaku/worklog.jsonl` | `adapters/jsonl-work-log.ts` | one `WorkRecord` per prompt, append-only, never rewritten |
| `<project>/.kankaku/inflight/<pid>.json` | `adapters/file-inflight-store.ts` | crash-recovery checkpoint of the running prompt |
| `<project>/.kankaku/config.json` | `adapters/project-config.ts` | `client` (legacy label), `clientId`, `projectId` |
| `<project>/.kankaku/sync-state.json` | `adapters/sync-state-store.ts` | watermark, content hashes, last run/error |
| `<project>/.kankaku/export/` | `adapters/export-writer.ts` | csv/json exports |
| `~/.kankaku/credentials.json` | the user | hub URL + service login (`adapters/hub-credentials.ts`) |
| `~/.kankaku/catalog.json` | `adapters/cached-catalog.ts` | clients, projects, tasks snapshot (0600) |
| `~/.kankaku/run/<pid>.json` | `adapters/machine-process-registry.ts` | live-process registry for subagent detection (0700/0600) |

`KANKAKU_DIR` moves the project directory; every other setting is an env
var read once at load (`src/config.ts`), listed in README "Settings".

## 5. Source map (`src/`)

### Domain (pure)

| File | Owns |
|---|---|
| `domain/work-record.ts` | `WorkRecord`, `WORK_RECORD_SCHEMA`, `cacheHitRatio`, the runtime type guard |
| `domain/work-tracker.ts` | the state machine: pi events in, finished records out (waiting spans, subagent spans, segments, usage) |
| `domain/intervals.ts` | interval unions; **the only** place wall time is combined |
| `domain/task-view.ts` | `buildTasks`: orchestrator + joined children → `TaskView`; `buildSessions`; the four-state role classification |
| `domain/client-label.ts`, `domain/work-target.ts` | legacy label resolution; hub target resolution (`Client`, `Project`, `HubTask`, `resolveWorkTarget`) |
| `domain/hub-entry.ts` | `TaskView` → `task_entries` payloads (create-only assignment, measurement fields, quality flags) |
| `domain/sync-plan.ts` | which tasks a sync pushes (watermark, revisit window, content hash) |
| `domain/subagent-profile.ts` | profiles for subagent tools (gentle-pi, pi reference, pi-subagents, configured), child-env markers |
| `domain/ancestry-match.ts`, `domain/registry-health.ts` | identity match against the process registry; sweep classification |
| `domain/segment-rule.ts`, `domain/export.ts`, `domain/day.ts` | tagged segments; export rows; local-day helper |
| `domain/panel-model.ts` | the panel's screens, root menu, navigation stack, title (`>_ kankaku`), footer hints, row builders. Not exported by the barrel |
| `domain/index.ts`, `ports/index.ts`, `hub/index.ts` | the three published barrels (`kankaku-pi/domain`, `kankaku-pi/ports`, `kankaku-pi/hub`) |

### Ports (interfaces only)

`ports/clock.ts`, `ports/work-log.ts`, `ports/inflight-store.ts`,
`ports/catalog.ts`, `ports/work-sink.ts`, `ports/process-registry.ts`.

### Adapters — pi side

| File | Owns |
|---|---|
| `extension.ts` | wiring only: config → identity → tracker → log → command → panel → sync |
| `config.ts` | env parsing, `detectRole`, marker validation, hub/sync config |
| `adapters/pi-tracker.ts` | registers every `pi.on` handler (all `guarded`), builds records, wires `registerKankakuCommand` and `openKankakuPanel` with the screens |
| `adapters/kankaku-command.ts` | `/kankaku` dispatch, subcommand handlers, `showReport`/`appendReportEntry` (durable chat card), `buildDoctorLines` |
| `adapters/report.ts`, `adapters/report-views.ts` | formatters (`cache hit NN%` lives here) and the five view builders shared by subcommands and panel |
| `adapters/hub-actions.ts` | line-building for sync/backfill/catalog shared by subcommands and panel |
| `adapters/status-bar.ts` | footer clock and idle billing label |
| `adapters/session-client.ts`, `adapters/session-target.ts` | per-session overrides stored as custom session entries (`kankaku-client`, `kankaku-target`); `setTask`, `rememberTarget` |
| `adapters/target-picker.ts` | `ctx.ui.select` pickers for client/project and hub task (subcommand path) |
| `adapters/session-dir.ts`, `adapters/agent-info.ts` | non-default session dir; pi and package versions |

### Adapters — the panel (`adapters/panel/`)

| File | Owns |
|---|---|
| `kankaku-panel.ts` | the overlay shell: frame, title, footer hints (clickable in fullscreen), Escape/← back, `q` close, `PanelHost` |
| `panel-items.ts` | `actionItem`: a settings row whose submenu runs an action and shows its result |
| `panel-lines.ts`, `panel-theme.ts` | bounded line body; pi-tui themes built from pi's `Theme` |
| `screens/target.ts` | client / project / task / legacy label rows, remember action, subagent read-only note |
| `screens/report.ts`, `screens/doctor.ts`, `screens/about.ts`, `screens/sync.ts`, `screens/export.ts` | one screen each; every computation is delegated to the shared helpers above |

### Adapters — files, hub, processes

| File | Owns |
|---|---|
| `adapters/jsonl-work-log.ts`, `lazy-jsonl-work-log.ts`, `file-inflight-store.ts`, `lazy-file-inflight-store.ts`, `kankaku-dir.ts`, `file-modes.ts`, `export-writer.ts`, `project-config.ts` | project-local files and owner-only modes |
| `adapters/pocketbase-client.ts`, `pocketbase-catalog.ts`, `pocketbase-sink.ts`, `cached-catalog.ts`, `hub-credentials.ts`, `sync-state-store.ts`, `sync-runner.ts` | the hub: HTTP client, catalog fetch/cache, `WorkSink`, sync orchestration and status |
| `adapters/ancestry.ts`, `machine-process-registry.ts`, `subagent-startup.ts`, `process-identity.ts`, `process-identity-memo.ts` | subagent detection: OS ancestry snapshot, registry, startup lookup, frozen per-process identity |

## 6. The four flows to know

1. **Prompt → record.** `pi-tracker.ts` feeds pi events to `WorkTracker`;
   at `agent_settled` it builds the record (`buildRecord`: role, target,
   session dir, metadata) and appends it through the `WorkLog`; the
   `InflightStore` checkpoints meanwhile.
2. **Record → task → hub row.** `buildTasks` (task-view) joins children to
   their orchestrator; `sync-runner.ts` plans with `sync-plan.ts` and pushes
   through `pocketbase-sink.ts`, which maps with `hub-entry.ts`. Automatic
   sync runs at `session_start`, `agent_settled` (throttled) and
   `session_shutdown` (awaited, time-bounded).
3. **`/kankaku`.** With a UI and no arguments → `openKankakuPanel`; with
   arguments or headless → the subcommand handlers. Both call the same
   helpers (`report-views.ts`, `buildDoctorLines`, `hub-actions.ts`), so
   they cannot drift.
4. **Who am I (subagent or not).** `process-identity.ts` combines env
   markers (`detectRole`), the process registry and the ancestry snapshot
   once per OS process; `process-identity-memo.ts` freezes it across
   `/new`, `/resume`, `/fork`, `/reload`.

## 7. Tests (`tests/`)

- One file per module, same name. Fakes, no timers, no network, no real pi.
- `tests/helpers/panel-fakes.ts`: fake TUI/theme/ctx for panel components;
  drive them with raw key strings (`"\x1b"`, `"\x1b[B"`, `"\r"`).
- Cross-cutting: `regression-6b-6c.test.ts` (subagent profiles),
  `cross-worktree-write-routing.test.ts`, `public-exports.test.ts` (barrels
  stay pi-free), `panel-*.test.ts` (one per screen).

## 8. Documents and the decision trail

- `README.md`: behaviour, record schema, `/kankaku` (panel + subcommands),
  hub, subagents, roadmap. `CHANGELOG.md`: per version. `AGENTS.md`: the
  invariants; read its "Measurement rules" before touching time, roles,
  sync or assignment.
- `odd/` (local only, git-ignored): ODD task documents per feature
  (`odd/tasks/*.md`, with commit ids and verification evidence), the
  Gentle Shell sidebar proposal draft, and the site handoff for 0.7.1.
- Engram (persistent memory, project `kankaku`): topics `odd/<feature>/tasks`,
  `kankaku/release/<version>`, `kankaku/panel/*`. Search there before
  re-deciding something.

## 9. Gotchas learned the hard way

- pi runs from Homebrew (0.87.1 at the time of writing); the dev copies in
  `node_modules` are older. Check behaviour against the runtime copy under
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`.
- pi aliases `@earendil-works/pi-tui` to its own bundled copy for
  extensions, so there is only one pi-tui at runtime.
- Mouse events are dispatched only in pi's fullscreen mode (`TuiAltScreen`).
  pi enables the kitty keyboard protocol, so Escape may arrive as `\x1b[27u`;
  always match keys with `matchesKey`, never by raw string.
- `SettingsList.closeSubmenu` treats `navigateTo` as "select **and
  activate** that row": never pass `navigateTo` pointing at a row that has
  its own submenu, or it reopens (and re-runs) itself.
- `pi -p` occasionally hangs before the prompt starts (no `.kankaku`
  directory created at all): provider side, re-run.
- Assignment on the hub is create-only; a re-sync must never resend
  `client`/`project`/`task`. The content hash excludes them on purpose.

## 10. Open threads

- `adapters/sync-runner.ts#pendingCount` is `@deprecated` (public barrel
  only); remove in the next minor.
- kankaku-claude phase 2 (target/task from Claude Code): parked by the owner.
- Gentle Shell sidebar contribution point: proposal drafted, not filed.
- The public site was handed a 0.5.0 → 0.7.1 update list (`odd/site-handoff-0.7.1.md`).
