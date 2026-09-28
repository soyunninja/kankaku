# kankaku — monorepo agent guidelines

This repository holds the three client-side kankaku packages as npm
workspaces. Each package keeps its own `AGENTS.md`, `README.md`,
`CHANGELOG.md` and tests; read the package's `AGENTS.md` before changing
code inside it.

| Directory          | npm package      | What it is                                          |
| ------------------ | ---------------- | --------------------------------------------------- |
| `packages/kankaku` | `kankaku`        | The pi extension and the shared library (`kankaku/domain`, `kankaku/ports`, `kankaku/hub`) |
| `packages/claude`  | `kankaku-claude` | The Claude Code plugin (hooks, commands, statusline)  |
| `packages/tui`     | `kankaku-tui`    | The `kankaku` CLI: dashboard, setup wizard, local hub |

The hub server (`kankaku-hub`) and the public site (`kankaku-site`) live in
their own repositories.

## Rules that span packages

- **Dependencies point one way**: `packages/claude` and `packages/tui`
  import `kankaku` only through its published entry points
  (`kankaku/domain`, `kankaku/ports`, `kankaku/hub`), never through
  relative paths into `packages/kankaku/src`. Those entry points resolve to
  `packages/kankaku/dist`, so `npm run check` at the root builds `kankaku`
  first; a fresh clone must run the root `npm run build` before any
  package's tests.
- **Lockstep versions**: the three packages always carry the same version
  and are released together, in the order `kankaku` → `kankaku-claude` →
  `kankaku-tui` (the consumers depend on `kankaku ^<that version>`). Bump
  with `npm version <v> --workspaces --no-git-tag-version`, then update
  the two `"kankaku": "^<v>"` ranges, commit `chore(release): prepare
  <v>`, tag `v<v>`.
- **One lockfile**, at the root. Never add a `package-lock.json` inside a
  package.
- **Strict TDD and the per-package verification commands are unchanged**;
  run them through the root scripts (`npm run check`, or `npm run check
  -w kankaku-tui` for one package).
- Conventional commits, English, neutral register, no AI attribution.
  Do not commit `.kankaku/`, `.codegraph/`, `odd/`, `dist/`, `node_modules/`.
