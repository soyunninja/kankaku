# kankaku

kankaku records how long coding agents actually work on each prompt —
wall time, waiting time on the user, and work time (`wallMs - waitingMs`)
— per prompt and per project, and rolls that up into tasks you can bill
to a client through a small hub. It ships as a pi extension, a Claude
Code plugin, and a terminal dashboard that reads across every project on
disk.

## Quick start

```
npm install -g kankaku
kankaku setup
```

`kankaku setup` runs a wizard that configures whichever agents you use
(pi, gentle-shell, Claude Code), the hub — point it at an existing one or
run `kankaku hub install` to run one locally — and the project roots you
want tracked. Once it's done, `kankaku` opens the dashboard. Claude Code
needs no checkout or `claude --plugin-dir` flag — `kankaku` bundles
the plugin and setup wires it into `~/.claude/settings.json` for you.

## Packages

| Directory | npm package | What it is | README |
|---|---|---|---|
| `packages/cli` | [`kankaku`](https://www.npmjs.com/package/kankaku) | the `kankaku` command: terminal dashboard, setup wizard, hub install/manage | [README](packages/cli/README.md) |
| `packages/pi` | [`kankaku-pi`](https://www.npmjs.com/package/kankaku-pi) | pi extension + the published domain/ports/hub library | [README](packages/pi/README.md) |
| `packages/claude` | [`kankaku-claude`](https://www.npmjs.com/package/kankaku-claude) | Claude Code plugin (hooks-based measurement) | [README](packages/claude/README.md) |

`kankaku-pi` is the shared library; `kankaku-claude` and `kankaku` both
depend on it. The hub server (`kankaku-hub`,
[github.com/soyunninja/kankaku_hub](https://github.com/soyunninja/kankaku_hub))
and the public site
(private `kankaku-site`) live in their own repositories and are not part
of this monorepo.

## Development

```
npm install                  # once, at the root
npm run check                # builds packages/pi first, then checks every package
npm run check -w kankaku    # check just one package
```

`packages/pi` must build before `packages/claude` or `packages/cli`
run anything, because they import `kankaku-pi/domain`, `kankaku-pi/ports` and
`kankaku-pi/hub` through the workspace symlink, which resolves to
`packages/pi/dist`. `packages/claude` must in turn build before
`packages/cli`'s own check runs, since `kankaku setup` resolves and writes
commands pointing at `kankaku-claude`'s compiled `dist/hook.js`/
`dist/statusline.js` (Node cannot type-strip a `.ts` file once it sits
under a `node_modules` directory, which every workspace dependency does).
`npm run check`/`npm run build` at the root build in that exact order
(`kankaku-pi` → `kankaku-claude` → `kankaku`); running a single package's
`check` directly assumes the packages before it in that order were
already built.

Versions are lockstep: all three packages ship the same version number,
bumped and released together, even when only one of them changed. Each
package keeps its own `CHANGELOG.md`. To release: bump every package to
the new version, commit `chore(release): prepare <v>`, tag `v<v>`, then
run `npm run publish:all`, which publishes in dependency order
(`kankaku-pi` → `kankaku-claude` → `kankaku`).

## License

MIT
