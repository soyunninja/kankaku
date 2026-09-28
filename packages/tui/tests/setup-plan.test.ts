import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAgents, planSetup, formatDoctorLines, formatSetupPlanLines } from "../src/domain/setup-plan.ts";
import type { AgentDetectionFacts, AgentStatus, HubPlanFacts, TuiPlanFacts } from "../src/domain/setup-plan.ts";

function baseFacts(): AgentDetectionFacts {
  return {
    pi: undefined,
    gentleShell: undefined,
    claudeCode: undefined,
    codex: undefined,
    opencode: undefined,
  };
}

test("detectAgents reports 'not found' for every agent when nothing is present", () => {
  const statuses = detectAgents(baseFacts());
  assert.equal(statuses.length, 5);
  for (const status of statuses) {
    assert.equal(status.present, false);
    assert.equal(status.configured, false);
    assert.equal(status.detail, "not found");
  }
  assert.deepEqual(
    statuses.map((s) => s.id),
    ["pi", "gentle-shell", "claude-code", "codex", "opencode"],
  );
  assert.deepEqual(
    statuses.map((s) => s.adapterAvailable),
    [true, true, true, false, false],
  );
});

test("detectAgents: pi missing 'kankaku' from packages is present but not configured", () => {
  const facts = baseFacts();
  facts.pi = { settingsPath: "/home/.pi/agent/settings.json", packages: ["npm:gentle-pi@3.4.0", "npm:pi-mcp-adapter"] };
  const [pi] = detectAgents(facts);
  assert.deepEqual(pi, {
    id: "pi",
    present: true,
    configured: false,
    adapterAvailable: true,
    detail: "/home/.pi/agent/settings.json",
  });
});

test("detectAgents: pi with an exact 'npm:kankaku' package is configured", () => {
  const facts = baseFacts();
  facts.pi = { settingsPath: "/home/.pi/agent/settings.json", packages: ["npm:pi-mcp-adapter", "npm:kankaku"] };
  const [pi] = detectAgents(facts);
  assert.equal(pi!.configured, true);
});

test("detectAgents: a versioned 'npm:kankaku@x.y.z' package is configured", () => {
  const facts = baseFacts();
  facts.pi = { settingsPath: "/home/.pi/agent/settings.json", packages: ["npm:kankaku@0.8.0"] };
  const [pi] = detectAgents(facts);
  assert.equal(pi!.configured, true);
});

test("detectAgents: gentle-shell with a local path package ending in 'kankaku' is configured", () => {
  const facts = baseFacts();
  facts.gentleShell = { settingsPath: "/home/.gentle-shell/agent/settings.json", packages: ["../../desarrollo/soyun.ninja/kankaku"] };
  const [, gentleShell] = detectAgents(facts);
  assert.equal(gentleShell!.configured, true);
  assert.equal(gentleShell!.present, true);
});

test("detectAgents: a local path package NOT ending in 'kankaku' is not configured", () => {
  const facts = baseFacts();
  facts.gentleShell = { settingsPath: "/home/.gentle-shell/agent/settings.json", packages: ["../other/kankaku-something-else"] };
  const [, gentleShell] = detectAgents(facts);
  assert.equal(gentleShell!.configured, false);
});

test("detectAgents: claude-code is configured only when the statusLine AND hooks are present and point at the same root", () => {
  const facts = baseFacts();
  facts.claudeCode = {
    settingsPath: "/home/.claude/settings.json",
    statusLineCommand: 'node "/home/dev/kankaku-claude/dist/statusline.js"',
    hooksRoot: "/home/dev/kankaku-claude",
  };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, true);
  assert.equal(claude!.present, true);
  assert.equal(claude!.detailNote, undefined);
});

test("detectAgents: claude-code with a legacy src-form statusLine and hooks at the same root is not configured, detailNote 'outdated statusLine and hooks'", () => {
  const facts = baseFacts();
  facts.claudeCode = {
    settingsPath: "/home/.claude/settings.json",
    statusLineCommand: 'node "/home/dev/kankaku-claude/src/statusline.ts"',
    hooksRoot: "/home/dev/kankaku-claude",
    hooksLegacy: true,
  };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.present, true);
  assert.equal(claude!.detailNote, "outdated statusLine and hooks");
});

test("detectAgents: claude-code with only the statusLine on the legacy src form (hooks already dist) is not configured, detailNote 'outdated statusLine'", () => {
  const facts = baseFacts();
  facts.claudeCode = {
    settingsPath: "/home/.claude/settings.json",
    statusLineCommand: 'node "/home/dev/kankaku-claude/src/statusline.ts"',
    hooksRoot: "/home/dev/kankaku-claude",
    hooksLegacy: false,
  };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, "outdated statusLine");
});

test("detectAgents: claude-code with only the hooks on the legacy src form (statusLine already dist) is not configured, detailNote 'outdated hooks'", () => {
  const facts = baseFacts();
  facts.claudeCode = {
    settingsPath: "/home/.claude/settings.json",
    statusLineCommand: 'node "/home/dev/kankaku-claude/dist/statusline.js"',
    hooksRoot: "/home/dev/kankaku-claude",
    hooksLegacy: true,
  };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, "outdated hooks");
});

test("detectAgents: claude-code with an unrelated statusLine is present but not configured", () => {
  const facts = baseFacts();
  facts.claudeCode = { settingsPath: "/home/.claude/settings.json", statusLineCommand: "node other-tool.js", hooksRoot: undefined };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.present, true);
});

test("detectAgents: claude-code with no statusLine and no hooks at all is present but not configured", () => {
  const facts = baseFacts();
  facts.claudeCode = { settingsPath: "/home/.claude/settings.json", statusLineCommand: undefined, hooksRoot: undefined };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, undefined);
});

test("detectAgents: claude-code with only the statusLine set is not configured, detailNote 'statusLine only'", () => {
  const facts = baseFacts();
  facts.claudeCode = { settingsPath: "/home/.claude/settings.json", statusLineCommand: 'node "/x/kankaku-claude/dist/statusline.js"', hooksRoot: undefined };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, "statusLine only");
});

test("detectAgents: claude-code with only hooks set is not configured, detailNote 'hooks only'", () => {
  const facts = baseFacts();
  facts.claudeCode = { settingsPath: "/home/.claude/settings.json", statusLineCommand: undefined, hooksRoot: "/x/kankaku-claude" };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, "hooks only");
});

test("detectAgents: claude-code with hooks and statusLine pointing at different roots is not configured, detailNote names both", () => {
  const facts = baseFacts();
  facts.claudeCode = { settingsPath: "/home/.claude/settings.json", statusLineCommand: 'node "/a/kankaku-claude/dist/statusline.js"', hooksRoot: "/b/kankaku-claude" };
  const [, , claude] = detectAgents(facts);
  assert.equal(claude!.configured, false);
  assert.equal(claude!.detailNote, "hooks point at /b/kankaku-claude, statusLine at /a/kankaku-claude");
});

test("detectAgents: codex/opencode present is reported with adapterAvailable false and never configured", () => {
  const facts = baseFacts();
  facts.codex = { configPath: "/home/.codex/config.toml" };
  facts.opencode = { configPath: "/home/.config/opencode/opencode.json" };
  const [, , , codex, opencode] = detectAgents(facts);
  assert.deepEqual(codex, { id: "codex", present: true, configured: false, adapterAvailable: false, detail: "/home/.codex/config.toml" });
  assert.deepEqual(opencode, {
    id: "opencode",
    present: true,
    configured: false,
    adapterAvailable: false,
    detail: "/home/.config/opencode/opencode.json",
  });
});

function agentsFixture(overrides: Partial<Record<string, AgentStatus>> = {}): AgentStatus[] {
  const base: Record<string, AgentStatus> = {
    pi: { id: "pi", present: true, configured: false, adapterAvailable: true, detail: "/home/.pi/agent/settings.json" },
    "gentle-shell": {
      id: "gentle-shell",
      present: true,
      configured: true,
      adapterAvailable: true,
      detail: "/home/.gentle-shell/agent/settings.json",
    },
    "claude-code": { id: "claude-code", present: true, configured: true, adapterAvailable: true, detail: "/home/.claude/settings.json" },
    codex: { id: "codex", present: true, configured: false, adapterAvailable: false, detail: "/home/.codex/config.toml" },
    opencode: { id: "opencode", present: false, configured: false, adapterAvailable: false, detail: "not found" },
  };
  for (const [id, status] of Object.entries(overrides)) {
    if (status) base[id] = status;
  }
  return Object.values(base);
}

test("planSetup: todo for an unconfigured present agent, done for a configured one, unavailable for no-adapter agents", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: false, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture(), hub, tui);

  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  assert.equal(byId["pi"]!.state, "todo");
  assert.equal(byId["pi"]!.file, "/home/.pi/agent/settings.json");
  assert.equal(byId["gentle-shell"]!.state, "done");
  assert.equal(byId["claude-code"]!.state, "done");
  assert.equal(byId["codex"]!.state, "unavailable");
  assert.equal(byId["codex"]!.file, "");
  assert.equal(byId["opencode"]!.state, "unavailable");
});

test("planSetup: an agent whose settings file is missing entirely is unavailable, not todo", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: true, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture({ pi: { id: "pi", present: false, configured: false, adapterAvailable: true, detail: "not found" } }), hub, tui);
  const pi = steps.find((s) => s.id === "pi")!;
  assert.equal(pi.state, "unavailable");
  assert.equal(pi.file, "");
});

test("planSetup: claude-code todo action mentions statusLine and hooks, plus a detailNote when partially configured", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: true, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(
    agentsFixture({
      "claude-code": {
        id: "claude-code",
        present: true,
        configured: false,
        adapterAvailable: true,
        detail: "/home/.claude/settings.json",
        detailNote: "statusLine only",
      },
    }),
    hub,
    tui,
  );
  const claude = steps.find((s) => s.id === "claude-code")!;
  assert.equal(claude.state, "todo");
  assert.match(claude.action, /statusLine and hooks/);
  assert.match(claude.action, /\(statusLine only\)$/);
});

test("planSetup: hub is todo when credentials are missing", () => {
  const hub: HubPlanFacts = { credentialsPresent: false, url: undefined, healthOk: undefined, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: true, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture(), hub, tui);
  const hubStep = steps.find((s) => s.id === "hub")!;
  assert.equal(hubStep.state, "todo");
  assert.equal(hubStep.file, "/home/.kankaku/credentials.json");
});

test("planSetup: hub is todo (not done) when credentials are present but the health check did not succeed", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: false, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: true, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture(), hub, tui);
  const hubStep = steps.find((s) => s.id === "hub")!;
  assert.equal(hubStep.state, "todo");
});

test("planSetup: hub is done only when credentials are present AND the health check succeeded", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: true, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture(), hub, tui);
  const hubStep = steps.find((s) => s.id === "hub")!;
  assert.equal(hubStep.state, "done");
});

test("planSetup: tui-config is todo when tui.json is missing, done when present", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const missing = planSetup(agentsFixture(), hub, { present: false, path: "/home/.kankaku/tui.json" });
  const present = planSetup(agentsFixture(), hub, { present: true, path: "/home/.kankaku/tui.json" });
  assert.equal(missing.find((s) => s.id === "tui-config")!.state, "todo");
  assert.equal(present.find((s) => s.id === "tui-config")!.state, "done");
});

test("formatDoctorLines: one line per agent, one for hub, one for tui.json, then a 'next:' hint per todo step", () => {
  const hub: HubPlanFacts = { credentialsPresent: false, url: undefined, healthOk: undefined, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: false, path: "/home/.kankaku/tui.json" };
  const lines = formatDoctorLines(agentsFixture(), hub, tui);

  // 5 agents + hub + tui.json = 7 status lines.
  const statusLines = lines.slice(0, 7);
  assert.equal(statusLines.length, 7);
  assert.match(statusLines[0]!, /^pi: todo/);
  assert.match(statusLines[1]!, /^gentle-shell: done/);
  assert.match(statusLines[2]!, /^Claude Code: done/);
  assert.match(statusLines[3]!, /^Codex: unavailable/);
  assert.match(statusLines[4]!, /^OpenCode: unavailable/);
  assert.match(statusLines[5]!, /^Hub: todo/);
  assert.match(statusLines[6]!, /^TUI config: todo/);

  // pi, hub and tui-config are the three todo steps here.
  const hints = lines.slice(7);
  assert.equal(hints.length, 3);
  for (const hint of hints) assert.match(hint, /^next: /);
});

test("formatSetupPlanLines: one line per step, including the exact file it would change when there is one", () => {
  const hub: HubPlanFacts = { credentialsPresent: true, url: "https://hub.example.com", healthOk: true, credentialsPath: "/home/.kankaku/credentials.json" };
  const tui: TuiPlanFacts = { present: false, path: "/home/.kankaku/tui.json" };
  const steps = planSetup(agentsFixture(), hub, tui);
  const lines = formatSetupPlanLines(steps);

  assert.equal(lines.length, steps.length);
  const piLine = lines.find((line) => line.startsWith("pi:"))!;
  assert.match(piLine, /todo/);
  assert.match(piLine, /\/home\/\.pi\/agent\/settings\.json/);

  const codexLine = lines.find((line) => line.startsWith("Codex:"))!;
  assert.match(codexLine, /unavailable/);
  assert.doesNotMatch(codexLine, /\[/); // no file for a step with no file to change

  const tuiLine = lines.find((line) => line.startsWith("TUI config:"))!;
  assert.match(tuiLine, /\/home\/\.kankaku\/tui\.json/);
});
