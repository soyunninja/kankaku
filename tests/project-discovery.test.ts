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
