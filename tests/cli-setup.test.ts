import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runCli } from "../src/cli.tsx";
import type { CliDeps } from "../src/cli.tsx";
import type { Prompter } from "../src/ports/prompter.ts";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-cli-setup-home-"));
}

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
    JSON.stringify({ statusLine: { type: "command", command: 'node "/x/kankaku-claude/src/statusline.ts"' } }, null, 2),
  );
  mkdirSync(join(home, ".kankaku"), { recursive: true });
  writeFileSync(join(home, ".kankaku", "credentials.json"), JSON.stringify({ url: "https://hub.example.com", email: "a@b.com", password: "s" }, null, 2));
  return home;
}

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

test("setup (interactive): installing in pi when confirmed writes npm:kankaku and backs up the original", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }, null, 2));
    mkdirSync(join(home, "project"), { recursive: true });

    const { prompter } = scriptedPrompter({ confirm: [true, true, true, false, false, false] });
    await runCli(["setup"], baseDeps(home, { prompter }));

    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(written.packages, ["npm:pi-mcp-adapter", "npm:kankaku"]);
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
  const checkout = mkdtempSync(join(tmpdir(), "kankaku-tui-not-a-checkout-"));
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
