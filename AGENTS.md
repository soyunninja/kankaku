# kankaku — monorepo agent guidelines

This repository holds the three client-side kankaku packages as npm
workspaces. Each package keeps its own `AGENTS.md`, `README.md`,
`CHANGELOG.md` and tests; read the package's `AGENTS.md` before changing
code inside it.

| Directory          | npm package      | What it is                                          |
| ------------------ | ---------------- | --------------------------------------------------- |
| `packages/pi`      | `kankaku-pi`     | The pi extension and the shared library (`kankaku-pi/domain`, `kankaku-pi/ports`, `kankaku-pi/hub`) |
| `packages/claude`  | `kankaku-claude` | The Claude Code plugin (hooks, commands, statusline)  |
| `packages/cli`     | `kankaku`        | The `kankaku` CLI: dashboard, setup wizard, local hub |

The hub server (`kankaku-hub`) and the public site (`kankaku-site`) live in
their own repositories.

## Rules that span packages

- **Dependencies point one way**: `packages/claude` and `packages/cli`
  import `kankaku-pi` only through its published entry points
  (`kankaku-pi/domain`, `kankaku-pi/ports`, `kankaku-pi/hub`), never through
  relative paths into `packages/pi/src`. Those entry points resolve to
  `packages/pi/dist`, so `npm run check` at the root builds `kankaku-pi`
  first; a fresh clone must run the root `npm run build` before any
  package's tests.
- **Lockstep versions**: the three packages always carry the same version
  and are released together, in the order `kankaku-pi` → `kankaku-claude` →
  `kankaku` (the consumers depend on `kankaku-pi ^<that version>`). To
  bump: FIRST update the internal ranges (`"kankaku-pi": "^<v>"` in cli and
  claude, `"kankaku-claude": "^<v>"` in cli), THEN `npm version <v>
  --workspaces --no-git-tag-version` and `npm install`, and confirm no
  `packages/*/node_modules/kankaku*` directory exists — the other order
  makes npm fetch the old published version into a nested
  `node_modules`, which the tests then resolve instead of the workspace
  copy. Commit `chore(release): prepare <v>`, tag `v<v>`, then
  `npm run publish:all`.
- **The root `package.json` carries a `pi` manifest** pointing at
  `packages/pi/src/extension.ts`: `pi install
  git:github.com/soyunninja/kankaku` clones the repository and reads the
  manifest at ITS root, not the package's. Keep both manifests in step
  (`packages/pi/tests/monorepo-pi-manifest.test.ts` enforces it).
- **`packages/cli/vendor/` is generated.** The `kankaku` tarball carries
  the pi extension under `vendor/kankaku-pi/` (a copy of `packages/pi`'s
  `src/`, `package.json` and `LICENSE`), and the `pi` manifest in
  `packages/cli/package.json` points there. `scripts/vendor-pi.mjs` writes
  it on `prepack`; never edit it and never commit it (it is ignored). The
  `kankaku-pi` tarball still ships the same extension on its own.
- **One lockfile**, at the root. Never add a `package-lock.json` inside a
  package.
- **Strict TDD and the per-package verification commands are unchanged**;
  run them through the root scripts (`npm run check`, or `npm run check
  -w kankaku` for one package).
- Conventional commits, English, neutral register, no AI attribution.
  Do not commit `.kankaku/`, `.codegraph/`, `odd/`, `dist/`, `node_modules/`.
