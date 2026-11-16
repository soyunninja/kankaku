import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitBranch } from "../src/git-branch.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-git-branch-"));
}

test("readGitBranch reads the branch from .git/HEAD of the directory or any parent", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/statusline\n");
    mkdirSync(join(dir, "packages", "claude"), { recursive: true });
    assert.equal(readGitBranch(dir), "feat/statusline");
    assert.equal(readGitBranch(join(dir, "packages", "claude")), "feat/statusline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitBranch follows a linked worktree's .git file, relative or absolute", () => {
  const dir = tmp();
  try {
    const gitdir = join(dir, "main", ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/wt-branch\n");
    mkdirSync(join(dir, "wt-abs"));
    writeFileSync(join(dir, "wt-abs", ".git"), `gitdir: ${gitdir}\n`);
    assert.equal(readGitBranch(join(dir, "wt-abs")), "wt-branch");
    mkdirSync(join(dir, "wt-rel"));
    writeFileSync(join(dir, "wt-rel", ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    assert.equal(readGitBranch(join(dir, "wt-rel")), "wt-branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGitBranch shows a detached HEAD as its short commit, and nothing outside a repository or on a bad HEAD", () => {
  const dir = tmp();
  try {
    assert.equal(readGitBranch(dir), undefined);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "d4812ce3696ee8f57e779d11e7922cf13e1492db\n");
    assert.equal(readGitBranch(dir), "d4812ce");
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    assert.equal(readGitBranch(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
