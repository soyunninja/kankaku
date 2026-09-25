import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkTargetLabel, resolveWorkTarget, resolveWorkTargetSource } from "../src/domain/work-target.ts";
import type { Client, HubTask, Project } from "../src/domain/work-target.ts";

const ACME: Client = { id: "c-acme", name: "Acme", code: "acme", active: true };
const GLOBEX: Client = { id: "c-globex", name: "Globex", code: "globex", active: true };
const INACTIVE: Client = { id: "c-inactive", name: "Inactive Co", code: "inactive", active: false };
const UNASSIGNED: Client = { id: "c-unassigned", name: "Sin determinar", code: "unassigned", active: true, unassigned: true };
const CLIENTS = [ACME, GLOBEX, INACTIVE, UNASSIGNED];

const PORTAL: Project = { id: "p-portal", name: "Portal", clientId: "c-acme", repoPaths: ["/repos/portal"], active: true };
const API: Project = { id: "p-api", name: "API", clientId: "c-acme", repoPaths: ["/repos/api"], active: true };
const INACTIVE_PROJECT: Project = { id: "p-old", name: "Old", clientId: "c-acme", repoPaths: ["/repos/old"], active: false };
const NESTED: Project = { id: "p-nested", name: "Nested", clientId: "c-globex", repoPaths: ["/repos/mono/nested"], active: true };
const MONO: Project = { id: "p-mono", name: "Mono", clientId: "c-globex", repoPaths: ["/repos/mono"], active: true };
const PROJECTS = [PORTAL, API, INACTIVE_PROJECT, NESTED, MONO];

test("session candidate wins over project and repoPaths", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-portal" },
    project: { clientId: "c-globex" },
    cwd: "/repos/mono",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme", projectId: "p-portal", projectName: "Portal" });
  assert.equal(
    resolveWorkTargetSource({
      session: { clientId: "c-acme", projectId: "p-portal" },
      project: { clientId: "c-globex" },
      cwd: "/repos/mono",
      clients: CLIENTS,
      projects: PROJECTS,
    }),
    "session",
  );
});

test("session set to skipped resolves to no target and does not fall through", () => {
  const target = resolveWorkTarget({
    session: "skipped",
    project: { clientId: "c-acme" },
    cwd: "/repos/portal",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.equal(target, undefined);
});

test("no session override falls through to the project config candidate", () => {
  const target = resolveWorkTarget({
    project: { clientId: "c-globex" },
    cwd: "/somewhere/else",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-globex", clientCode: "globex", clientName: "Globex" });
});

test("a session candidate with an unknown client id falls through to the project candidate", () => {
  const target = resolveWorkTarget({
    session: { clientId: "does-not-exist" },
    project: { clientId: "c-acme" },
    cwd: "/somewhere/else",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme" });
});

test("an inactive client id falls through", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-inactive" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.equal(target, undefined);
});

test("the unassigned client is never a valid resolution target", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-unassigned" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.equal(target, undefined);
});

test("a valid client with an invalid projectId keeps the client and drops the project", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "does-not-exist" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme" });
});

test("a projectId belonging to a different client is dropped", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-nested" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme" });
});

test("an inactive project id is dropped", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-old" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
  });

  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme" });
});

test("repoPaths matches an exact cwd", () => {
  const target = resolveWorkTarget({ cwd: "/repos/portal", clients: CLIENTS, projects: PROJECTS });
  assert.deepEqual(target, { clientId: "c-acme", clientCode: "acme", clientName: "Acme", projectId: "p-portal", projectName: "Portal" });
  assert.equal(resolveWorkTargetSource({ cwd: "/repos/portal", clients: CLIENTS, projects: PROJECTS }), "repoPaths");
});

test("repoPaths matches a cwd nested inside a repo path", () => {
  const target = resolveWorkTarget({ cwd: "/repos/portal/src/deep", clients: CLIENTS, projects: PROJECTS });
  assert.equal(target?.projectId, "p-portal");
});

test("repoPaths does not match a sibling directory that merely shares a prefix", () => {
  const target = resolveWorkTarget({ cwd: "/repos/portal-old", clients: CLIENTS, projects: PROJECTS });
  assert.equal(target, undefined);
});

test("repoPaths picks the longest matching path when nested projects both match", () => {
  const target = resolveWorkTarget({ cwd: "/repos/mono/nested/deep", clients: CLIENTS, projects: PROJECTS });
  assert.equal(target?.projectId, "p-nested");
});

test("repoPaths ignores inactive projects", () => {
  const target = resolveWorkTarget({ cwd: "/repos/old", clients: CLIENTS, projects: PROJECTS });
  assert.equal(target, undefined);
});

test("repoPaths falls through to none when nothing matches", () => {
  const target = resolveWorkTarget({ cwd: "/unrelated", clients: CLIENTS, projects: PROJECTS });
  assert.equal(target, undefined);
  assert.equal(resolveWorkTargetSource({ cwd: "/unrelated", clients: CLIENTS, projects: PROJECTS }), undefined);
});

test("formatWorkTargetLabel shows client only, or client and project", () => {
  assert.equal(formatWorkTargetLabel({ clientId: "c", clientCode: "acme", clientName: "Acme" }), "Acme");
  assert.equal(
    formatWorkTargetLabel({ clientId: "c", clientCode: "acme", clientName: "Acme", projectId: "p", projectName: "Portal" }),
    "Acme · Portal",
  );
});

test("formatWorkTargetLabel appends the hub task title when set", () => {
  assert.equal(
    formatWorkTargetLabel({
      clientId: "c",
      clientCode: "acme",
      clientName: "Acme",
      projectId: "p",
      projectName: "Portal",
      hubTaskId: "t-1",
      hubTaskTitle: "Fix the thing",
    }),
    "Acme · Portal › Fix the thing",
  );
});

const FIX_THE_THING: HubTask = { id: "t-1", title: "Fix the thing", projectId: "p-portal", status: "open" };
const OTHER_PROJECT_TASK: HubTask = { id: "t-2", title: "Cross-project", projectId: "p-api", status: "open" };
const TASKS = [FIX_THE_THING, OTHER_PROJECT_TASK];

test("a session candidate's hubTaskId is kept when the task exists and belongs to the resolved project", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-1" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: TASKS,
  });

  assert.equal(target?.hubTaskId, "t-1");
  assert.equal(target?.hubTaskTitle, "Fix the thing");
});

test("a session candidate's hubTaskId is dropped when the task belongs to a different project", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-2" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: TASKS,
  });

  assert.equal(target?.projectId, "p-portal");
  assert.equal(target?.hubTaskId, undefined);
  assert.equal(target?.hubTaskTitle, undefined);
});

test("a session candidate's hubTaskId is dropped when the task id no longer exists", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "does-not-exist" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: TASKS,
  });

  assert.equal(target?.hubTaskId, undefined);
});

test("a target with no project never carries a hubTaskId, even if the candidate has one", () => {
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", hubTaskId: "t-1" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: TASKS,
  });

  assert.equal(target?.projectId, undefined);
  assert.equal(target?.hubTaskId, undefined);
});

test("a task of any status (including done) still resolves", () => {
  const done: HubTask = { id: "t-3", title: "Done task", projectId: "p-portal", status: "done" };
  const target = resolveWorkTarget({
    session: { clientId: "c-acme", projectId: "p-portal", hubTaskId: "t-3" },
    cwd: "/nowhere",
    clients: CLIENTS,
    projects: PROJECTS,
    tasks: [done],
  });

  assert.equal(target?.hubTaskId, "t-3");
});
