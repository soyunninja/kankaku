import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildWizardActions, runCli } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";
import type { Prompter } from "../src/ports/prompter.ts";
import { locateClaudePlugin, readPluginHooks, buildSettingsHooks } from "../src/adapters/setup/claude-plugin.ts";
import { commandsDirectory, readPluginCommands, writeClaudeCommands } from "../src/adapters/setup/claude-commands.ts";
import type { WizardState } from "../src/domain/setup-wizard.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cli-cli-setup-home-"));
}

/** The bundled `kankaku-claude` plugin's real resolved root, used to build a matching `settings.json` fixture without depending on where this checkout happens to live. */
const CLAUDE_PLUGIN_ROOT = locateClaudePlugin().root;

/** A machine where pi, gentle-shell, Claude Code and the hub are already configured; only tui.json is missing — mirrors the real machine's acceptance-criteria shape. */
function makeFullyConfiguredHome(): string {
  const home = makeHome();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:kankaku"] }, null, 2));
  mkdirSync(join(home, ".gentle-shell", "agent"), { recursive: true });
  writeFileSync(join(home, ".gentle-shell", "agent", "settings.json"), JSON.stringify({ packages: ["../../workspace/kankaku"] }, null, 2));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(
      {
        statusLine: { type: "command", command: `node "${CLAUDE_PLUGIN_ROOT}/dist/statusline.js"` },
        hooks: buildSettingsHooks(CLAUDE_PLUGIN_ROOT, readPluginHooks(CLAUDE_PLUGIN_ROOT)),
      },
      null,
      2,
    ),
  );
  writeClaudeCommands(home, CLAUDE_PLUGIN_ROOT, readPluginCommands(CLAUDE_PLUGIN_ROOT));
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: "https://hub.example.com", email: "a@b.com", password: "s" }, null, 2));
  return home;
}

const PLUGIN_COMMAND_FILES = readPluginCommands(CLAUDE_PLUGIN_ROOT).map((command) => `${command.name}.md`);

function okFetch(): typeof fetch {
  return (async () => new Response(null, { status: 200 })) as typeof fetch;
}

function baseDeps(home: string, overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    homeDir: home,
    cwd: join(home, "project"),
    env: {},
    fetch: okFetch(),
    stdout: () => {},
    stderr: () => {},
    exit: () => {},
    renderApp: () => {
      throw new Error("should not render the TUI");
    },
    ...overrides,
  };
}

test("doctor: reports every agent, the hub and tui.json as plain lines", async () => {
  const home = makeFullyConfiguredHome();
  try {
    const lines: string[] = [];
    await runCli(["doctor"], baseDeps(home, { stdout: (text) => lines.push(text) }));
    const output = lines.join("\n");
    assert.match(output, /^pi: done/m);
    assert.match(output, /^gentle-shell: done/m);
    assert.match(output, /^Claude Code: done/m);
    assert.match(output, /^Codex: unavailable/m);
    assert.match(output, /^OpenCode: unavailable/m);
    assert.match(output, /^Hub: done/m);
    assert.match(output, /^TUI config: todo/m);
    assert.match(output, /^next: /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("doctor: reports the hub as todo when the health check does not succeed", async () => {
  const home = makeFullyConfiguredHome();
  try {
    const lines: string[] = [];
    const failingFetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await runCli(["doctor"], baseDeps(home, { fetch: failingFetch, stdout: (text) => lines.push(text) }));
    assert.match(lines.join("\n"), /^Hub: todo/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --dry-run: prints the plan and writes nothing at all", async () => {
  const home = makeFullyConfiguredHome();
  try {
    const lines: string[] = [];
    let exitCode: number | undefined;
    await runCli(
      ["setup", "--dry-run"],
      baseDeps(home, {
        stdout: (text) => lines.push(text),
        exit: (code) => {
          exitCode = code;
        },
      }),
    );
    assert.equal(exitCode, undefined);
    const output = lines.join("\n");
    assert.match(output, /^pi: done/m);
    assert.match(output, /^TUI config: todo.*\[.*tui\.json\]/m);

    assert.equal(existsSync(join(home, ".kankaku", "tui.json")), false);
    assert.equal(existsSync(join(home, ".pi", "agent", "settings.json.bak")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes: on a fully-configured machine, writes only tui.json and touches nothing else", async () => {
  const home = makeFullyConfiguredHome();
  try {
    const piBefore = readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8");
    const gentleShellBefore = readFileSync(join(home, ".gentle-shell", "agent", "settings.json"), "utf8");
    const claudeBefore = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    const credentialsBefore = readFileSync(join(home, ".kankaku", "credentials.json"), "utf8");

    mkdirSync(join(home, "project"), { recursive: true });
    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    assert.equal(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"), piBefore);
    assert.equal(readFileSync(join(home, ".gentle-shell", "agent", "settings.json"), "utf8"), gentleShellBefore);
    assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), claudeBefore);
    assert.equal(readFileSync(join(home, ".kankaku", "credentials.json"), "utf8"), credentialsBefore);
    assert.equal(existsSync(join(home, ".pi", "agent", "settings.json.bak")), false);
    assert.equal(existsSync(join(home, ".claude", "settings.json.bak")), false);
    assert.equal(existsSync(join(home, ".kankaku", "credentials.json.bak")), false);

    const written = JSON.parse(readFileSync(join(home, ".kankaku", "tui.json"), "utf8"));
    assert.deepEqual(written, { roots: [dirname(join(home, "project"))] });

    // Every write announces itself, then setup ends with the same report as `kankaku doctor`.
    assert.match(lines.join("\n"), new RegExp(`^wrote ${join(home, ".kankaku", "tui.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(lines.join("\n"), /^TUI config: done/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes: re-running after tui.json exists reports everything done and writes nothing further", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    await runCli(["setup", "--yes"], baseDeps(home));
    const tuiAfterFirstRun = readFileSync(join(home, ".kankaku", "tui.json"), "utf8");

    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    assert.equal(readFileSync(join(home, ".kankaku", "tui.json"), "utf8"), tuiAfterFirstRun);
    assert.equal(existsSync(join(home, ".kankaku", "tui.json.bak")), false);
    const output = lines.join("\n");
    assert.doesNotMatch(output, /todo/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function scriptedPrompter(answers: { confirm?: boolean[]; text?: string[]; secret?: string[] }): { prompter: Prompter; questions: string[] } {
  const questions: string[] = [];
  const confirmAnswers = [...(answers.confirm ?? [])];
  const textAnswers = [...(answers.text ?? [])];
  const secretAnswers = [...(answers.secret ?? [])];
  return {
    questions,
    prompter: {
      confirm: async (q, d) => {
        questions.push(`confirm: ${q}`);
        return confirmAnswers.length > 0 ? confirmAnswers.shift()! : d;
      },
      text: async (q, d) => {
        questions.push(`text: ${q}`);
        return textAnswers.length > 0 ? textAnswers.shift()! : d;
      },
      secret: async (q) => {
        questions.push(`secret: ${q}`);
        return secretAnswers.length > 0 ? secretAnswers.shift()! : "";
      },
    },
  };
}

test("setup (interactive): installing in pi when confirmed writes npm:kankaku-pi and backs up the original", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });

    const { prompter } = scriptedPrompter({ confirm: [true, true, true, false, false, false] });
    await runCli(["setup"], baseDeps(home, { prompter }));

    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(written.packages, ["npm:pi-mcp-adapter", "npm:kankaku-pi"]);
    assert.equal(existsSync(join(home, ".pi", "agent", "settings.json.bak")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup (interactive): declining a step writes nothing for it", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [] }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });

    const { prompter } = scriptedPrompter({ confirm: [false, false, false, false, false] });
    await runCli(["setup"], baseDeps(home, { prompter }));

    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(written.packages, []);
    assert.equal(existsSync(join(home, ".pi", "agent", "settings.json.bak")), false);
    assert.equal(existsSync(join(home, ".kankaku", "tui.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup (interactive): entering hub credentials writes them when confirmed", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const { prompter, questions } = scriptedPrompter({
      confirm: [true], // hub: "configure hub credentials now?"
      text: ["https://new-hub.example.com", "me@example.com", dirname(join(home, "project"))],
      secret: ["s3cret"],
    });
    // Every other confirm (pi/gentle-shell/claude-code being unavailable/absent, tui-config, catalog refresh) defaults to its own default via an empty confirm queue after the first.
    await runCli(["setup"], baseDeps(home, { prompter }));

    const written = JSON.parse(readFileSync(join(home, ".kankaku", "credentials.json"), "utf8"));
    assert.deepEqual(written, { url: "https://new-hub.example.com", email: "me@example.com", password: "s3cret" });
    assert.ok(questions.some((q) => q.includes("hub credentials")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup (interactive): refreshing the catalog prints the same result line as kankaku catalog refresh", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const catalogFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/collections/users/auth-with-password")) return new Response(JSON.stringify({ token: "tok", record: { id: "u1" } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/api/collections/clients/records")) return new Response(JSON.stringify({ page: 1, perPage: 200, totalItems: 1, totalPages: 1, items: [{ id: "c1", name: "Acme", code: "acme", active: true }] }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/api/collections/")) return new Response(JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 1, items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const { prompter } = scriptedPrompter({ confirm: [true, true], text: [dirname(join(home, "project"))], secret: [] });
    const lines: string[] = [];
    await runCli(["setup"], baseDeps(home, { prompter, fetch: catalogFetch, stdout: (text) => lines.push(text) }));

    assert.match(lines.join("\n"), /1 client\(s\), 0 project\(s\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup: on a TTY with no --yes/--dry-run, opens the wizard instead of the readline flow", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    let renderCall: { roots: string[]; startInWizard: boolean | undefined } | undefined;
    await runCli(
      ["setup"],
      baseDeps(home, {
        isTTY: () => true,
        renderApp: (roots, _theme, options) => {
          renderCall = { roots, startInWizard: options?.startInWizard };
        },
      }),
    );
    assert.deepEqual(renderCall, { roots: [join(home, "project")], startInWizard: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes: ignores isTTY and still runs the non-interactive flow (renderApp is never called)", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { isTTY: () => true, stdout: (text) => lines.push(text) }));
    assert.match(lines.join("\n"), /^TUI config: done/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --dry-run: ignores isTTY and still prints the plan (renderApp is never called)", async () => {
  const home = makeFullyConfiguredHome();
  try {
    const lines: string[] = [];
    await runCli(["setup", "--dry-run"], baseDeps(home, { isTTY: () => true, stdout: (text) => lines.push(text) }));
    assert.match(lines.join("\n"), /^pi: done/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup: without a TTY, keeps the readline flow even though a prompter was injected", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [] }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });
    const { prompter, questions } = scriptedPrompter({ confirm: [false, false, false, false, false] });
    await runCli(["setup"], baseDeps(home, { prompter }));
    assert.ok(questions.length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no command, no tui.json yet: opens straight into the wizard (first-run hint)", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    let renderCall: { startInWizard: boolean | undefined } | undefined;
    await runCli(
      [],
      baseDeps(home, {
        renderApp: (_roots, _theme, options) => {
          renderCall = { startInWizard: options?.startInWizard };
        },
      }),
    );
    assert.deepEqual(renderCall, { startInWizard: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no command, tui.json already exists: opens the normal dashboard, not the wizard", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".kankaku"), { recursive: true });
    writeFileSync(join(home, ".kankaku", "tui.json"), JSON.stringify({ roots: ["/x"] }));
    let renderCall: { startInWizard: boolean | undefined } | undefined;
    await runCli(
      [],
      baseDeps(home, {
        renderApp: (_roots, _theme, options) => {
          renderCall = { startInWizard: options?.startInWizard };
        },
      }),
    );
    assert.deepEqual(renderCall, { startInWizard: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes --from-checkout <dir>: never opens the interactive wizard, even on a TTY", async () => {
  const home = makeHome();
  try {
    let rendered = false;
    await runCli(
      ["setup", "--yes", "--from-checkout", join(home, "not-a-checkout")],
      baseDeps(home, {
        isTTY: () => true,
        renderApp: () => {
          rendered = true;
        },
      }),
    );
    assert.equal(rendered, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes --from-checkout <dir>: on a checkout missing its dev scripts, reports the failure and exits 1 without prompting for hub credentials", async () => {
  const home = makeHome();
  const checkout = mkdtempSync(join(tmpdir(), "kankaku-cli-not-a-checkout-"));
  try {
    const errors: string[] = [];
    let exitCode: number | undefined;
    await runCli(
      ["setup", "--yes", "--from-checkout", checkout],
      baseDeps(home, { stderr: (text) => errors.push(text), exit: (code) => (exitCode = code) }),
    );
    assert.equal(exitCode, 1);
    assert.match(errors.join(""), /^kankaku setup --from-checkout: /);
    assert.equal(existsSync(join(home, ".kankaku", "credentials.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

function makeFakePluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-fake-plugin-"));
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "report.md"), 'run\n!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report\n');
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"', timeout: 15 }] }] } }, null, 2),
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "hook.js"), "// fake\n");
  return dir;
}

test("setup --yes --claude-plugin-dir <dir>: configures Claude Code from the override plugin root", async () => {
  const home = makeHome();
  const pluginDir = makeFakePluginDir();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });
    await runCli(["setup", "--yes", "--claude-plugin-dir", pluginDir], baseDeps(home));

    const written = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(written.statusLine.command, `node "${pluginDir}/dist/statusline.js"`);
    assert.deepEqual(written.hooks.SessionStart, [{ hooks: [{ type: "command", command: `node "${pluginDir}/dist/hook.js"`, timeout: 15 }] }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("setup --yes: KANKAKU_CLAUDE_PLUGIN_DIR env var overrides the bundled plugin root", async () => {
  const home = makeHome();
  const pluginDir = makeFakePluginDir();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });
    await runCli(["setup", "--yes"], baseDeps(home, { env: { KANKAKU_CLAUDE_PLUGIN_DIR: pluginDir } }));

    const written = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(written.statusLine.command, `node "${pluginDir}/dist/statusline.js"`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("setup --dry-run --claude-plugin-dir <dir>: prints the resolved plugin root and the exact settings file it would change", async () => {
  const home = makeHome();
  const pluginDir = makeFakePluginDir();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }, null, 2));
    const lines: string[] = [];
    await runCli(["setup", "--dry-run", "--claude-plugin-dir", pluginDir], baseDeps(home, { stdout: (text) => lines.push(text) }));

    const output = lines.join("\n");
    assert.match(output, new RegExp(`Claude plugin root: ${pluginDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(would write ${join(home, ".claude", "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("setup --yes --claude-plugin-dir <bad dir>: reports the failure on stderr and still completes the rest of setup", async () => {
  const home = makeHome();
  const badDir = mkdtempSync(join(tmpdir(), "kankaku-cli-bad-claude-plugin-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }, null, 2));
    const errors: string[] = [];
    const lines: string[] = [];
    await runCli(["setup", "--yes", "--claude-plugin-dir", badDir], baseDeps(home, { stderr: (text) => errors.push(text), stdout: (text) => lines.push(text) }));

    assert.match(errors.join(""), /could not configure Claude Code/);
    // Setup still reports doctor's final status for everything else.
    assert.match(lines.join("\n"), /^Codex: unavailable/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(badDir, { recursive: true, force: true });
  }
});

// ---- Claude Code slash commands (~/.claude/commands/kankaku) ----

test("doctor: Claude Code is todo with 'commands missing' when statusLine and hooks are set but the commands are not", async () => {
  const home = makeFullyConfiguredHome();
  try {
    rmSync(commandsDirectory(home), { recursive: true, force: true });
    const lines: string[] = [];
    await runCli(["doctor"], baseDeps(home, { stdout: (text) => lines.push(text) }));
    assert.match(lines.join("\n"), /^Claude Code: todo .*\(commands missing: /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes: generates the user commands when only statusLine and hooks were set, and reports each file", async () => {
  const home = makeFullyConfiguredHome();
  try {
    rmSync(commandsDirectory(home), { recursive: true, force: true });
    mkdirSync(join(home, "project"), { recursive: true });
    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    const output = lines.join("\n");
    for (const file of PLUGIN_COMMAND_FILES) {
      assert.ok(existsSync(join(commandsDirectory(home), file)), file);
      assert.ok(output.split("\n").includes(`wrote ${join(commandsDirectory(home), file)}`), file);
    }
    const report = readFileSync(join(commandsDirectory(home), "report.md"), "utf8");
    assert.match(report, new RegExp(`"${CLAUDE_PLUGIN_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dist/cli\\.js" report`));
    assert.doesNotMatch(report, /CLAUDE_PLUGIN_ROOT/);
    assert.match(output, /^Claude Code: done/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes: a foreign file in the commands directory is left alone and reported", async () => {
  const home = makeFullyConfiguredHome();
  try {
    rmSync(commandsDirectory(home), { recursive: true, force: true });
    mkdirSync(commandsDirectory(home), { recursive: true });
    writeFileSync(join(commandsDirectory(home), "report.md"), "my own report\n");
    mkdirSync(join(home, "project"), { recursive: true });
    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    assert.equal(readFileSync(join(commandsDirectory(home), "report.md"), "utf8"), "my own report\n");
    assert.match(lines.join("\n"), new RegExp(`^skipped ${join(commandsDirectory(home), "report.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(not a kankaku command\\)$`, "m"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --dry-run: prints the commands directory and how many files it would write, and writes nothing", async () => {
  const home = makeFullyConfiguredHome();
  try {
    rmSync(commandsDirectory(home), { recursive: true, force: true });
    const lines: string[] = [];
    await runCli(["setup", "--dry-run"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    assert.ok(lines.join("\n").split("\n").includes(`Claude commands: ${PLUGIN_COMMAND_FILES.length} file(s) would be written to ${commandsDirectory(home)}`));
    assert.equal(existsSync(commandsDirectory(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes --claude-plugin-dir <dir>: generates commands from the override plugin's own commands directory", async () => {
  const home = makeHome();
  const pluginDir = makeFakePluginDir();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x" }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });
    await runCli(["setup", "--yes", "--claude-plugin-dir", pluginDir], baseDeps(home));

    assert.equal(readFileSync(join(commandsDirectory(home), "report.md"), "utf8"), `run\n!node "${pluginDir}/dist/cli.js" report\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("wizard actions: write-claude writes settings and commands; remove-claude removes both, keeping foreign files", async () => {
  const home = makeHome();
  const pluginDir = makeFakePluginDir();
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "x" }, null, 2));
    const actions = buildWizardActions(baseDeps(home), pluginDir);
    const state = {} as WizardState;

    const wrote = await actions.apply({ kind: "write-claude", file: settingsPath, label: "configure" }, state);
    assert.equal(wrote.outcome, "wrote");
    assert.ok(existsSync(join(commandsDirectory(home), "report.md")));

    const again = await actions.apply({ kind: "write-claude", file: settingsPath, label: "configure" }, state);
    assert.equal(again.outcome, "unchanged");

    writeFileSync(join(commandsDirectory(home), "mine.md"), "mine\n");
    const removed = await actions.apply({ kind: "remove-claude", file: settingsPath, label: "remove" }, state);
    assert.equal(removed.outcome, "removed");
    assert.equal(existsSync(join(commandsDirectory(home), "report.md")), false);
    assert.equal(readFileSync(join(commandsDirectory(home), "mine.md"), "utf8"), "mine\n");
    assert.match(removed.detail ?? "", /mine\.md/);
    assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).statusLine, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("drifted Claude Code install: doctor reports todo with the note, setup --yes repairs it, doctor then reports done; foreign files stay", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const dir = commandsDirectory(home);
    const settingsPath = join(home, ".claude", "settings.json");

    // Foreign content that must survive.
    writeFileSync(join(dir, "custom.md"), "my custom command\n");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const foreignStop = { hooks: [{ type: "command", command: "node foreign-stop.js" }] };
    settings.hooks.Notification = [{ hooks: [{ type: "command", command: "node notify.js" }] }];
    settings.hooks.Stop = [...settings.hooks.Stop, foreignStop];
    // Drift: remove our Stop and SessionEnd entries.
    settings.hooks.Stop = [foreignStop];
    delete settings.hooks.SessionEnd;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    rmSync(join(dir, "sync.md"));
    writeFileSync(join(dir, "status.md"), readFileSync(join(dir, "status.md"), "utf8") + "appended\n");

    const before: string[] = [];
    await runCli(["doctor"], baseDeps(home, { stdout: (text) => before.push(text) }));
    const beforeOut = before.join("\n");
    assert.match(beforeOut, /^Claude Code: todo/m);
    assert.match(beforeOut, /hooks missing: (Stop, SessionEnd|SessionEnd, Stop)/);
    assert.match(beforeOut, /commands missing: sync; commands outdated: status/);

    const setup: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => setup.push(text) }));
    const setupOut = setup.join("\n");
    assert.ok(setupOut.split("\n").includes(`wrote ${join(dir, "sync.md")}`));
    assert.ok(setupOut.split("\n").includes(`wrote ${join(dir, "status.md")}`));
    assert.ok(setupOut.split("\n").includes(`unchanged ${join(dir, "report.md")}`));

    const after: string[] = [];
    await runCli(["doctor"], baseDeps(home, { stdout: (text) => after.push(text) }));
    assert.match(after.join("\n"), /^Claude Code: done/m);

    assert.equal(readFileSync(join(dir, "custom.md"), "utf8"), "my custom command\n");
    const repaired = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.ok(repaired.hooks.Stop.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify(foreignStop)));
    assert.equal(repaired.hooks.Stop.length, 2);
    assert.ok(Array.isArray(repaired.hooks.SessionEnd));
    assert.deepEqual(repaired.hooks.Notification, [{ hooks: [{ type: "command", command: "node notify.js" }] }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup --yes on an up-to-date Claude Code install prints unchanged lines and changes no bytes", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const dir = commandsDirectory(home);
    const settingsPath = join(home, ".claude", "settings.json");
    const snapshot = () => [settingsPath, ...PLUGIN_COMMAND_FILES.map((file) => join(dir, file))].map((file) => [readFileSync(file, "utf8"), statSync(file).mtimeMs]);
    const before = snapshot();

    const lines: string[] = [];
    await runCli(["setup", "--yes"], baseDeps(home, { stdout: (text) => lines.push(text) }));

    assert.deepEqual(snapshot(), before);
    for (const file of PLUGIN_COMMAND_FILES) assert.ok(lines.includes(`unchanged ${join(dir, file)}`), file);
    assert.ok(lines.includes(`unchanged ${settingsPath}`));
    assert.equal(existsSync(`${settingsPath}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function writePiSettings(home: string, agent: ".pi" | ".gentle-shell", packages: unknown[]): string {
  const file = join(home, agent, "agent", "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ theme: "x", packages }, null, 2));
  return file;
}

test("pi with only npm:kankaku: doctor and --dry-run say done, setup --yes leaves the file as it is", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const file = writePiSettings(home, ".pi", [{ source: "npm:kankaku", extensions: ["!x"] }]);
    const before = readFileSync(file, "utf8");
    for (const args of [["doctor"], ["setup", "--dry-run"]]) {
      const lines: string[] = [];
      await runCli(args, baseDeps(home, { stdout: (text) => lines.push(text) }));
      assert.match(lines.join("\n"), /^pi: done/m, args.join(" "));
    }
    await runCli(["setup", "--yes"], baseDeps(home));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(existsSync(`${file}.bak`), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi with neither source: --dry-run proposes npm:kankaku-pi, setup --yes writes exactly that", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const file = writePiSettings(home, ".pi", ["npm:pi-lens"]);
    const plan: string[] = [];
    await runCli(["setup", "--dry-run"], baseDeps(home, { stdout: (text) => plan.push(text) }));
    assert.match(plan.join("\n"), /^pi: todo — add "npm:kankaku-pi" to packages/m);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, ["npm:pi-lens"]);

    await runCli(["setup", "--yes"], baseDeps(home));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, ["npm:pi-lens", "npm:kankaku-pi"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pi with both npm:kankaku and npm:kankaku-pi: doctor and --dry-run report the double load, setup --yes keeps npm:kankaku-pi, doctor then says done", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const file = writePiSettings(home, ".pi", ["npm:kankaku", "npm:pi-lens", "npm:kankaku-pi"]);
    for (const args of [["doctor"], ["setup", "--dry-run"]]) {
      const lines: string[] = [];
      await runCli(args, baseDeps(home, { stdout: (text) => lines.push(text) }));
      assert.match(lines.join("\n"), /^pi: todo — loaded 2 times: npm:kankaku, npm:kankaku-pi/m, args.join(" "));
    }
    assert.equal(existsSync(`${file}.bak`), false);

    await runCli(["setup", "--yes"], baseDeps(home));
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(written.packages, ["npm:pi-lens", "npm:kankaku-pi"]);
    assert.equal(written.theme, "x");
    assert.equal(existsSync(`${file}.bak`), true);

    const after: string[] = [];
    await runCli(["doctor"], baseDeps(home, { stdout: (text) => after.push(text) }));
    assert.match(after.join("\n"), /^pi: done/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gentle-shell with a local checkout and npm:kankaku: setup --yes keeps the local path", async () => {
  const home = makeFullyConfiguredHome();
  try {
    mkdirSync(join(home, "project"), { recursive: true });
    const file = writePiSettings(home, ".gentle-shell", ["npm:kankaku", "git:github.com/soyunninja/kankaku@v1", "/dev/kankaku", "npm:kankaku-pi"]);
    await runCli(["setup", "--yes"], baseDeps(home));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, ["/dev/kankaku"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("wizard actions: remove-pi removes every recognised kankaku source, in both entry forms", async () => {
  const home = makeHome();
  try {
    const file = writePiSettings(home, ".pi", ["npm:kankaku", { source: "npm:kankaku-pi", extensions: [] }, "npm:pi-lens"]);
    const result = await buildWizardActions(baseDeps(home), undefined).apply({ kind: "remove-pi", file, label: "remove" }, {} as WizardState);
    assert.equal(result.outcome, "removed");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, ["npm:pi-lens"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
