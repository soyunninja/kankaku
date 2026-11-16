import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatusline, type StatuslineDeps } from "../src/statusline-core.ts";
import { readState, writeState, type SessionState } from "../src/session-state.ts";
import { writeCost, readCost, costFile } from "../src/cost-store.ts";
import { resolvePaths } from "../src/paths.ts";
import { writeSessionTarget } from "../src/session-target-store.ts";
import { sessionTargetLabel } from "../src/work-target.ts";

function tmpEnv(): { projectDir: string; homeDir: string; env: NodeJS.ProcessEnv; cwd: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "kankaku-claude-statusline-project-"));
  const homeDir = mkdtempSync(join(tmpdir(), "kankaku-claude-statusline-home-"));
  return { projectDir, homeDir, env: { KANKAKU_DIR: projectDir, HOME: homeDir }, cwd: "/repo" };
}

function cleanup(dirs: { projectDir: string; homeDir: string }): void {
  rmSync(dirs.projectDir, { recursive: true, force: true });
  rmSync(dirs.homeDir, { recursive: true, force: true });
}

function baseState(overrides: Partial<SessionState> = {}): SessionState {
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

function deps(env: NodeJS.ProcessEnv, now: () => number, overrides: Partial<StatuslineDeps> = {}): StatuslineDeps {
  return { env, now, readState, writeCost, ...overrides };
}

test("renderStatusline writes a finite cost through writeCost under HOME, never creating anything under the project", () => {
  const dirs = tmpEnv();
  try {
    const input = {
      session_id: "s1",
      cwd: dirs.cwd,
      model: { id: "claude-opus-4" },
      cost: { total_cost_usd: 1.2345 },
    };
    const line = renderStatusline(input, deps(dirs.env, () => 5000));
    assert.equal(line, "kankaku idle · $1.23");

    const cost = readCost(dirs.env, "s1");
    assert.deepEqual(cost, { totalUsd: 1.2345, updatedAt: 5000, model: "claude-opus-4" });
    assert.equal(existsSync(costFile(dirs.env, "s1")), true);

    // Nothing was created under the project.
    assert.equal(existsSync(dirs.projectDir), true);
    assert.deepEqual(readdirSync(dirs.projectDir), []);
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline reads the project's state file read-only for the open-prompt clock, never writing it", () => {
  const dirs = tmpEnv();
  try {
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: 0.5 } };
    renderStatusline(input, deps(dirs.env, () => 61000));

    // The project's state file is unchanged: the statusline never writes it.
    const state = readState(paths.stateFile);
    assert.deepEqual(state, baseState({ promptOpen: { id: "p1", startedAt: 1000, costAtStart: 0 } }));
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline prints idle and creates nothing under the project when no state file exists", () => {
  const dirs = tmpEnv();
  try {
    const input = { session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: 0.5 } };
    const line = renderStatusline(input, deps(dirs.env, () => 5000));
    assert.equal(line, "kankaku idle · $0.50");
    assert.deepEqual(readdirSync(dirs.projectDir), []);
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline formats the open prompt's elapsed clock as m:ss under an hour", () => {
  const dirs = tmpEnv();
  try {
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd: dirs.cwd };
    const line = renderStatusline(input, deps(dirs.env, () => 65_000));
    assert.equal(line, "kankaku 1:05");
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline formats the open prompt's elapsed clock as h:mm:ss past an hour", () => {
  const dirs = tmpEnv();
  try {
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd: dirs.cwd };
    const oneHourFiveMinSevenSec = (3600 + 5 * 60 + 7) * 1000;
    const line = renderStatusline(input, deps(dirs.env, () => oneHourFiveMinSevenSec));
    assert.equal(line, "kankaku 1:05:07");
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline reports idle when no prompt is open", () => {
  const dirs = tmpEnv();
  try {
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState());

    const input = { session_id: "s1", cwd: dirs.cwd };
    const line = renderStatusline(input, deps(dirs.env, () => 5000));
    assert.equal(line, "kankaku idle");
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline prints just the clock, with no cost suffix and no write, when cost.total_cost_usd is absent", () => {
  const dirs = tmpEnv();
  try {
    let writeCalled = false;
    const spyWriteCost: typeof writeCost = (...args) => {
      writeCalled = true;
      return writeCost(...args);
    };
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeState(paths.stateFile, baseState({ promptOpen: { id: "p1", startedAt: 0, costAtStart: 0 } }));

    const input = { session_id: "s1", cwd: dirs.cwd };
    const line = renderStatusline(input, deps(dirs.env, () => 5000, { writeCost: spyWriteCost }));
    assert.equal(line, "kankaku 0:05");
    assert.equal(writeCalled, false);
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline ignores a non-finite cost.total_cost_usd", () => {
  const dirs = tmpEnv();
  try {
    const input = { session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: "not-a-number" } };
    const line = renderStatusline(input, deps(dirs.env, () => 5000));
    assert.equal(line, "kankaku idle");
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline returns bare 'kankaku' on malformed input", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(renderStatusline(null, deps(env, () => 0)), "kankaku");
  assert.equal(renderStatusline("not an object", deps(env, () => 0)), "kankaku");
  assert.equal(renderStatusline({}, deps(env, () => 0)), "kankaku");
});

test("renderStatusline returns bare 'kankaku' when a dependency throws", () => {
  const throwingReadState: typeof readState = () => {
    throw new Error("boom");
  };
  const line = renderStatusline(
    { session_id: "s1", cwd: "/repo" },
    deps({}, () => 0, { readState: throwingReadState }),
  );
  assert.equal(line, "kankaku");
});

test("renderStatusline output never contains a newline", () => {
  const dirs = tmpEnv();
  try {
    const input = { session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: 1 } };
    const line = renderStatusline(input, deps(dirs.env, () => 5000));
    assert.equal(line.includes("\n"), false);
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline resolves cwd from workspace.current_dir when present, falling back to cwd, and never creates anything under the fallback cwd either", () => {
  const dirs = tmpEnv();
  try {
    const input = {
      session_id: "s1",
      cwd: "/ignored",
      workspace: { current_dir: dirs.cwd },
      cost: { total_cost_usd: 1 },
    };
    renderStatusline(input, deps(dirs.env, () => 5000));
    const cost = readCost(dirs.env, "s1");
    assert.notEqual(cost, undefined);
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline appends the target label after the clock and cost", () => {
  const dirs = tmpEnv();
  try {
    const seen: Array<{ cwd: string; sessionId: string }> = [];
    const targetLabel: NonNullable<StatuslineDeps["targetLabel"]> = ({ cwd, sessionId }) => {
      seen.push({ cwd, sessionId });
      return "Acme · Web › Fix login";
    };
    const withCost = renderStatusline({ session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: 1.01 } }, deps(dirs.env, () => 5000, { targetLabel }));
    assert.equal(withCost, "kankaku idle · $1.01 | Acme · Web › Fix login");
    assert.deepEqual(seen, [{ cwd: dirs.cwd, sessionId: "s1" }]);

    const withoutCost = renderStatusline({ session_id: "s1", cwd: dirs.cwd }, deps(dirs.env, () => 5000, { targetLabel }));
    assert.equal(withoutCost, "kankaku idle | Acme · Web › Fix login");
  } finally {
    cleanup(dirs);
  }
});

test("renderStatusline keeps the clock and cost when there is no target or the label lookup throws", () => {
  const dirs = tmpEnv();
  try {
    const input = { session_id: "s1", cwd: dirs.cwd, cost: { total_cost_usd: 1.01 } };
    assert.equal(renderStatusline(input, deps(dirs.env, () => 5000, { targetLabel: () => undefined })), "kankaku idle · $1.01");
    const throwing = (): string => { throw new Error("broken catalog"); };
    assert.equal(renderStatusline(input, deps(dirs.env, () => 5000, { targetLabel: throwing })), "kankaku idle · $1.01");
    assert.equal(readCost(dirs.env, "s1")?.totalUsd, 1.01);
  } finally {
    cleanup(dirs);
  }
});

function writeCatalog(homeDir: string): void {
  mkdirSync(join(homeDir, ".kankaku"), { recursive: true });
  writeFileSync(join(homeDir, ".kankaku", "credentials.json"), JSON.stringify({ url: "https://hub.example.test", email: "a@b.c", password: "pw" }));
  writeFileSync(join(homeDir, ".kankaku", "catalog.json"), JSON.stringify({
    fetchedAt: 0,
    url: "https://hub.example.test",
    clients: [{ id: "c-acme", name: "Acme", code: "acme", active: true }],
    projects: [
      { id: "p-web", name: "Web", clientId: "c-acme", repoPaths: ["/repo"], active: true },
      { id: "p-api", name: "API", clientId: "c-acme", repoPaths: [], active: true },
    ],
    tasks: [{ id: "t-api", title: "Ship endpoint", projectId: "p-api", status: "open" }],
  }));
}

test("sessionTargetLabel: the session's pick and linked task, read-only", () => {
  const dirs = tmpEnv();
  try {
    writeCatalog(dirs.homeDir);
    const paths = resolvePaths({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" });
    writeSessionTarget(paths.targetFile, { clientId: "c-acme", projectId: "p-api", hubTaskId: "t-api", hubTaskTitle: "Ship endpoint", lastList: { kind: "tasks", ids: [] } });
    const before = readdirSync(paths.claudeDir);

    assert.equal(sessionTargetLabel({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" }), "Acme · API › Ship endpoint");
    assert.deepEqual(readdirSync(paths.claudeDir), before);
    assert.equal(existsSync(join(dirs.projectDir, "config.json")), false);
  } finally {
    cleanup(dirs);
  }
});

test("sessionTargetLabel: without a session pick it falls back to the folder's automatic target, and to nothing when none resolves", () => {
  const dirs = tmpEnv();
  try {
    writeCatalog(dirs.homeDir);
    assert.equal(sessionTargetLabel({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" }), "Acme · Web");
    assert.equal(sessionTargetLabel({ env: dirs.env, cwd: "/elsewhere", sessionId: "s1" }), undefined);
    assert.deepEqual(readdirSync(dirs.projectDir), []);
  } finally {
    cleanup(dirs);
  }
});

test("sessionTargetLabel: no catalog cache means no label", () => {
  const dirs = tmpEnv();
  try {
    assert.equal(sessionTargetLabel({ env: dirs.env, cwd: dirs.cwd, sessionId: "s1" }), undefined);
  } finally {
    cleanup(dirs);
  }
});
