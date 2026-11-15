import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogAdoptionFailure } from "../src/adapters/cached-catalog.ts";
import { PocketBaseError } from "../src/adapters/pocketbase-client.ts";
import { createTaskCreator, formatTaskCreationFailure, TaskCreationFailure } from "../src/adapters/task-creation.ts";
import type { HubTask } from "../src/domain/work-target.ts";

const TASK: HubTask = { id: "remote-id", title: "Example", projectId: "project-id", status: "open" };

test("task creator distinguishes remote success followed by cache persistence failure", async () => {
  const creator = createTaskCreator(async () => TASK, () => { throw new CatalogAdoptionFailure("persistence"); });
  await assert.rejects(creator("project-id", "Example"), (error: unknown) => {
    assert.ok(error instanceof TaskCreationFailure);
    assert.equal(error.kind, "cache-persistence");
    assert.deepEqual(error.task, TASK);
    return true;
  });
  const diagnostic = formatTaskCreationFailure(new TaskCreationFailure("cache-persistence", TASK));
  assert.match(diagnostic, /persistence failed/i);
  assert.doesNotMatch(diagnostic, /remote-id|secret|private|token|unavailable/i);
});

test("task creator does not claim an effective link when no catalog snapshot exists", async () => {
  const creator = createTaskCreator(async () => TASK, () => { throw new CatalogAdoptionFailure("snapshot-unavailable"); });
  await assert.rejects(creator("project-id", "Example"), (error: unknown) => {
    assert.ok(error instanceof TaskCreationFailure);
    assert.equal(error.kind, "catalog-unavailable");
    assert.match(formatTaskCreationFailure(error), /do not create it again/i);
    return true;
  });
});

test("request failure diagnostics allowlist PocketBase kind/status and do not expose arbitrary messages", () => {
  const error = new PocketBaseError("http", "secret response body https://private.invalid/token=abc", 403);
  const diagnostic = formatTaskCreationFailure(error);
  assert.match(diagnostic, /http/);
  assert.match(diagnostic, /403/);
  assert.match(diagnostic, /check the hub before retrying/i);
  assert.doesNotMatch(diagnostic, /secret|private|token/);
});

test("the composed creator preserves only safe PocketBase request diagnostics", async () => {
  const creator = createTaskCreator(async () => {
    throw new PocketBaseError("timeout", "secret URL https://private.invalid/token", 500);
  }, () => {});
  await assert.rejects(creator("project-id", "Example"), (error: unknown) => {
    const diagnostic = formatTaskCreationFailure(error);
    assert.match(diagnostic, /timeout 500/);
    assert.match(diagnostic, /outcome is uncertain/i);
    assert.match(diagnostic, /check the hub before retrying/i);
    assert.doesNotMatch(diagnostic, /secret|private|token|https/);
    return true;
  });
});

test("malformed typed fields and arbitrary errors never leak into diagnostics", () => {
  const malformed = new PocketBaseError("http", "credential=abc", 99999) as PocketBaseError & { kind: string };
  Object.defineProperty(malformed, "kind", { value: "credential=abc" });
  const diagnostic = formatTaskCreationFailure(malformed);
  assert.doesNotMatch(diagnostic, /credential|abc|99999/);
  assert.match(diagnostic, /outcome is uncertain/i);
  assert.doesNotMatch(formatTaskCreationFailure(new Error("secret /private URL https://secret.invalid")), /secret|private|https/);
});
