import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { isWorkRecord, emptyUsage, buildTasks, buildTaskEntryCreatePayload, WORK_RECORD_SCHEMA } from "kankaku-pi/domain";
import type { WorkRecordCore } from "kankaku-pi/domain";
import { buildClaudeRecord, readPackageVersion } from "../src/record.ts";
import type { SessionState } from "../src/session-state.ts";

function core(): WorkRecordCore {
  return {
    schema: WORK_RECORD_SCHEMA,
    id: "id-1",
    prompt: "hi",
    startedAt: new Date(1000).toISOString(),
    settledAt: new Date(2000).toISOString(),
    wallMs: 1000,
    waitingMs: 0,
    workMs: 1000,
    runs: 1,
    turns: 1,
    tools: {},
    subagents: [],
    usage: emptyUsage(),
    status: "completed",
  };
}

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    pid: 111,
    parentPid: 222,
    cwd: "/repo",
    startedAt: 1000,
    promptOpen: null,
    permissionOpen: null,
    ...overrides,
  };
}

test("buildClaudeRecord attaches orchestrator metadata from the session state", () => {
  const record = buildClaudeRecord(core(), state(), "session-1", undefined);
  assert.equal(record.role, "orchestrator");
  assert.equal(record.pid, 111);
  assert.equal(record.parentPid, 222);
  assert.equal(record.project, "/repo");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.mode, "claude-code");
  assert.equal(isWorkRecord(record), true);
});

test("buildClaudeRecord sets model to anthropic/<id> only when a model was passed in explicitly", () => {
  const withModel = buildClaudeRecord(core(), state(), "session-1", "claude-opus-4");
  assert.equal(withModel.model, "anthropic/claude-opus-4");

  const withoutModel = buildClaudeRecord(core(), state(), "session-1", undefined);
  assert.equal(withoutModel.model, undefined);
});

test("buildClaudeRecord stamps the measuring identity: agent, plugin and this package's version, never an agentVersion", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const record = buildClaudeRecord(core(), state(), "session-1", undefined);
  assert.equal(record.agent, "claude-code");
  assert.equal(record.plugin, "kankaku-claude");
  assert.equal(record.pluginVersion, pkg.version);
  assert.equal("agentVersion" in record, false);
  assert.equal(isWorkRecord(record), true);
});

test("readPackageVersion returns the version, and undefined when the file is missing or unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "kankaku-claude-pkg-"));
  try {
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(dir, "bad.json"), "{nope");
    writeFileSync(join(dir, "nover.json"), "{}");
    assert.equal(readPackageVersion(join(dir, "ok.json")), "1.2.3");
    assert.equal(readPackageVersion(join(dir, "bad.json")), undefined);
    assert.equal(readPackageVersion(join(dir, "nover.json")), undefined);
    assert.equal(readPackageVersion(join(dir, "missing.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record written by this plugin keeps its identity when a foreign process (the TUI) builds the hub payload", () => {
  const record = buildClaudeRecord(core(), state(), "session-1", undefined);
  const [task] = buildTasks([record]);
  const payload = buildTaskEntryCreatePayload(task!, {
    clients: [], projects: [], tasks: [], machine: "m", promptMode: "none",
    agent: "unknown", plugin: "kankaku-tui",
  });
  assert.equal(payload.agent, "claude-code");
  assert.equal(payload.plugin, "kankaku-claude");
});
