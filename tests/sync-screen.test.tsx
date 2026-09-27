import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SyncScreen } from "../src/ui/sync-screen.tsx";
import type { SyncModel } from "../src/ui/sync-screen.tsx";
import type { SyncRow } from "../src/domain/sync-model.ts";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

function row(name: string, overrides: Partial<SyncRow> = {}): SyncRow {
  return { name, dir: `/work/${name}`, pending: 1, staleOutsideWindow: 0, ...overrides };
}

function readyModel(): SyncModel {
  return { status: "ready", rows: [row("alpha"), row("beta", { pending: 0 })] };
}

test("SyncScreen shows the unavailable note when the hub is not configured", () => {
  const { lastFrame } = render(
    <SyncScreen
      load={() => ({ status: "unavailable", reason: "hub credentials are not configured" })}
      syncOne={async () => ({ ok: true, message: "" })}
      syncAll={async () => []}
    />,
  );
  assert.match(lastFrame() ?? "", /hub credentials are not configured/);
});

test("SyncScreen lists one row per project with pending count", () => {
  const { lastFrame } = render(<SyncScreen load={() => readyModel()} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /alpha/);
  assert.match(frame, /beta/);
  assert.match(frame, /pending 1/);
});

test("SyncScreen syncs the selected project on 's' and shows the summary inline", async () => {
  const calls: Array<{ name: string; full: boolean }> = [];
  const { lastFrame, stdin } = render(
    <SyncScreen
      load={() => readyModel()}
      syncOne={async (target, options) => {
        calls.push({ name: target.name, full: options.full });
        return { ok: true, message: "uploaded 1, updated 0, skipped 0, failed 0" };
      }}
      syncAll={async () => []}
    />,
  );
  stdin.write("s");
  await nextTick();
  assert.deepEqual(calls, [{ name: "alpha", full: false }]);
  assert.match(lastFrame() ?? "", /uploaded 1, updated 0, skipped 0, failed 0/);
});

test("SyncScreen full-syncs the selected project on 'f'", async () => {
  const calls: Array<{ name: string; full: boolean }> = [];
  const { stdin } = render(
    <SyncScreen
      load={() => readyModel()}
      syncOne={async (target, options) => {
        calls.push({ name: target.name, full: options.full });
        return { ok: true, message: "ok" };
      }}
      syncAll={async () => []}
    />,
  );
  stdin.write("f");
  await nextTick();
  assert.deepEqual(calls, [{ name: "alpha", full: true }]);
});

test("SyncScreen syncs every project on 'S'", async () => {
  let syncAllCalls = 0;
  const { stdin } = render(
    <SyncScreen
      load={() => readyModel()}
      syncOne={async () => ({ ok: true, message: "" })}
      syncAll={async () => {
        syncAllCalls += 1;
        return [
          { ok: true, message: "alpha: ok" },
          { ok: true, message: "beta: ok" },
        ];
      }}
    />,
  );
  stdin.write("S");
  await nextTick();
  assert.equal(syncAllCalls, 1);
});

test("SyncScreen shows a busy indicator while a sync is in flight", async () => {
  let resolveSync!: (value: { ok: boolean; message: string }) => void;
  const pending = new Promise<{ ok: boolean; message: string }>((resolve) => {
    resolveSync = resolve;
  });
  const { lastFrame, stdin } = render(<SyncScreen load={() => readyModel()} syncOne={() => pending} syncAll={async () => []} />);
  stdin.write("s");
  await nextTick();
  assert.match(lastFrame() ?? "", /syncing/i);
  resolveSync({ ok: true, message: "done" });
  await nextTick();
  assert.doesNotMatch(lastFrame() ?? "", /syncing/i);
});

test("SyncScreen moves the selection with arrow keys", async () => {
  const calls: string[] = [];
  const { stdin } = render(
    <SyncScreen
      load={() => readyModel()}
      syncOne={async (target) => {
        calls.push(target.name);
        return { ok: true, message: "" };
      }}
      syncAll={async () => []}
    />,
  );
  stdin.write("\u001B[B"); // down arrow -> select beta
  await nextTick();
  stdin.write("s");
  await nextTick();
  assert.deepEqual(calls, ["beta"]);
});
