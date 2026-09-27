import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProjects } from "../src/adapters/project-discovery.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-tui-root-"));
}

function markProject(dir: string): void {
  mkdirSync(join(dir, ".kankaku"), { recursive: true });
  writeFileSync(join(dir, ".kankaku", "worklog.jsonl"), "");
}

test("discoverProjects finds direct children with a worklog", () => {
  const root = makeRoot();
  try {
    markProject(join(root, "alpha"));
    markProject(join(root, "beta"));
    mkdirSync(join(root, "not-a-project"));

    const projects = discoverProjects([root]);
    assert.deepEqual(
      projects.map((p) => p.name),
      ["alpha", "beta"],
    );
    assert.equal(projects[0]!.dir, join(root, "alpha"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects treats the root itself as a project when it has a worklog", () => {
  const root = makeRoot();
  try {
    markProject(root);
    const projects = discoverProjects([root]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.dir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects dedupes by dir and sorts by name", () => {
  const root = makeRoot();
  try {
    markProject(join(root, "zeta"));
    markProject(join(root, "alpha"));
    const projects = discoverProjects([root, root]);
    assert.deepEqual(
      projects.map((p) => p.name),
      ["alpha", "zeta"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects never throws on an unreadable or missing root", () => {
  const projects = discoverProjects(["/definitely/does/not/exist"]);
  assert.deepEqual(projects, []);
});

test("discoverProjects finds a project nested <root>/<client>/<project>, two levels below the root", () => {
  const root = makeRoot();
  try {
    markProject(join(root, "clientA", "projectX"));
    const projects = discoverProjects([root]);
    assert.deepEqual(
      projects.map((p) => p.name),
      ["projectX"],
    );
    assert.equal(projects[0]!.dir, join(root, "clientA", "projectX"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects respects the default depth limit (5 levels below the root)", () => {
  const root = makeRoot();
  try {
    // root/L1/L2/L3/L4/L5/L6 — L6 is 6 levels below root, one past the default limit.
    const deepProject = join(root, "L1", "L2", "L3", "L4", "L5", "L6");
    markProject(deepProject);

    assert.deepEqual(discoverProjects([root]), []);
    assert.deepEqual(
      discoverProjects([root], { maxDepth: 6 }).map((p) => p.dir),
      [deepProject],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects skips node_modules, .git and hidden directories", () => {
  const root = makeRoot();
  try {
    markProject(join(root, "node_modules", "some-package"));
    markProject(join(root, ".git", "not-a-project"));
    markProject(join(root, ".hidden", "not-a-project"));
    markProject(join(root, "real", "project"));

    const projects = discoverProjects([root]);
    assert.deepEqual(
      projects.map((p) => p.name),
      ["project"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects keeps descending below a directory that is itself a project, so a stray worklog in a parent never hides the projects beneath it", () => {
  const root = makeRoot();
  try {
    // A pi session run once in `~/desarrollo` leaves a worklog there; the
    // real projects live in `~/desarrollo/<client>/<project>`.
    markProject(join(root, "parent"));
    markProject(join(root, "parent", "client", "child"));

    const projects = discoverProjects([root]);
    assert.deepEqual(
      projects.map((p) => p.dir).sort(),
      [join(root, "parent"), join(root, "parent", "client", "child")].sort(),
    );
    // Each project is listed exactly once.
    assert.equal(new Set(projects.map((p) => p.dir)).size, projects.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverProjects disambiguates duplicate basenames with the last two path segments", () => {
  const root = makeRoot();
  try {
    markProject(join(root, "clientA", "shared"));
    markProject(join(root, "clientB", "shared"));

    const projects = discoverProjects([root]);
    assert.deepEqual(
      projects.map((p) => p.name).sort(),
      ["clientA/shared", "clientB/shared"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
