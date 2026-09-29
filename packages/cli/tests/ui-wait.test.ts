import { test } from "node:test";
import assert from "node:assert/strict";
import { settle, waitFor } from "./helpers/ui-wait.ts";

test("waitFor passes at once when the assertion already holds", async () => {
  await waitFor(() => assert.equal(1, 1));
});

test("waitFor passes when the condition becomes true late", async () => {
  let ready = false;
  setTimeout(() => (ready = true), 120);
  await waitFor(() => assert.equal(ready, true));
});

test("waitFor supports an async assertion", async () => {
  let count = 0;
  await waitFor(async () => {
    count += 1;
    assert.ok(count >= 3);
  });
  assert.ok(count >= 3);
});

test("waitFor fails with the assertion's own error, within the timeout, when the condition never holds", async () => {
  const started = Date.now();
  await assert.rejects(
    waitFor(() => assert.equal("a", "b", "the marker message"), { timeoutMs: 150, intervalMs: 5 }),
    (error: Error) => error.message.includes("the marker message"),
  );
  const took = Date.now() - started;
  assert.ok(took >= 100 && took < 1500, `took ${took}ms`);
});

test("waitFor rethrows the LAST error, not the first", async () => {
  let attempt = 0;
  await assert.rejects(
    waitFor(
      () => {
        attempt += 1;
        throw new Error(`attempt ${attempt}`);
      },
      { timeoutMs: 60, intervalMs: 5 },
    ),
    (error: Error) => error.message !== "attempt 1" && /^attempt \d+$/.test(error.message),
  );
});

test("settle resolves once the frame has been quiet for quietMs", async () => {
  let frame = "a";
  setTimeout(() => (frame = "b"), 40);
  setTimeout(() => (frame = "c"), 90);
  const started = Date.now();
  await settle(() => frame, { quietMs: 60, intervalMs: 5 });
  assert.equal(frame, "c");
  assert.ok(Date.now() - started >= 140, "waited for the last change plus the quiet period");
});

test("settle resolves after quietMs for a frame that never changes", async () => {
  const started = Date.now();
  await settle(() => "same", { quietMs: 50, intervalMs: 5 });
  assert.ok(Date.now() - started >= 45);
});

test("settle rejects when the frame keeps changing past the timeout", async () => {
  let n = 0;
  await assert.rejects(settle(() => String(n++), { quietMs: 50, timeoutMs: 100, intervalMs: 5 }), /did not settle/);
});
