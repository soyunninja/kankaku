import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SyncScreen } from "../src/ui/sync-screen.tsx";
import type { SyncModel } from "../src/ui/sync-screen.tsx";
import { settle, waitFor } from "./helpers/ui-wait.ts";

function readyModel(): SyncModel {
  return {
    status: "ready",
    rows: [
      { name: "kankaku", dir: "/work/kankaku", pending: 2, staleOutsideWindow: 0, syncedThrough: "2026-09-27T08:00:00.000Z" },
      { name: "kankaku-tui", dir: "/work/kankaku-tui", pending: 0, staleOutsideWindow: 1 },
    ],
  };
}

test("renders one card per project in a grid", () => {
  const { lastFrame } = render(
    <SyncScreen load={readyModel} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("kankaku"), true);
  assert.equal(frame.includes("kankaku-tui"), true);
  assert.equal(frame.includes("pending 2"), true);
});

test("marks the selected card with a visible marker", async () => {
  const { lastFrame, stdin } = render(
    <SyncScreen load={readyModel} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  stdin.write("\u001B[B");
  await settle(lastFrame);
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("› kankaku-tui"), true);
  });
});

test("'s' syncs the selected project and shows the result inline", async () => {
  const { lastFrame, stdin } = render(
    <SyncScreen
      load={readyModel}
      syncOne={async () => ({ ok: true, message: "synced 2 tasks" })}
      syncAll={async () => []}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("s");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal((lastFrame() ?? "").includes("synced 2 tasks"), true);
  });
});

test("'S' syncs every project", async () => {
  let calls = 0;
  const { stdin, lastFrame } = render(
    <SyncScreen
      load={readyModel}
      syncOne={async () => ({ ok: true, message: "" })}
      syncAll={async () => {
        calls += 1;
        return [
          { ok: true, message: "ok a" },
          { ok: true, message: "ok b" },
        ];
      }}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("S");
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(calls, 1);
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("ok a"), true);
    assert.equal(frame.includes("ok b"), true);
  });
});

test("shows a plain note when unavailable", () => {
  const { lastFrame } = render(
    <SyncScreen
      load={() => ({ status: "unavailable", reason: "hub not configured" })}
      syncOne={async () => ({ ok: false, message: "" })}
      syncAll={async () => []}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  assert.equal((lastFrame() ?? "").includes("hub not configured"), true);
});

test("renders at 80 columns without overflowing any line", () => {
  const { lastFrame } = render(
    <SyncScreen load={readyModel} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={80} />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.ok(lines.every((line) => line.length <= 80));
});

function manyRowsModel(count: number): SyncModel {
  return {
    status: "ready",
    rows: Array.from({ length: count }, (_, index) => ({
      name: `project-${index}`,
      dir: `/work/project-${index}`,
      pending: 0,
      staleOutsideWindow: 0,
    })),
  };
}

test("fits within `rows` with many project cards at 100×24", () => {
  const { lastFrame } = render(
    <SyncScreen load={() => manyRowsModel(40)} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  const lines = (lastFrame() ?? "").split("\n");
  assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
});

test("a long sync error message never grows a card past its fixed height and breaks the grid", () => {
  const longError = "connection to the hub failed repeatedly with a very long diagnostic message ".repeat(6);
  const longErrorModel: SyncModel = {
    status: "ready",
    rows: [
      { name: "kankaku", dir: "/work/kankaku", pending: 1, staleOutsideWindow: 0, lastError: { message: longError, at: "2026-09-27T08:00:00.000Z" } },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `p${index}`, dir: `/work/p${index}`, pending: 0, staleOutsideWindow: 0 })),
    ],
  };
  const { lastFrame } = render(
    <SyncScreen load={() => longErrorModel} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  const frame = lastFrame() ?? "";
  const lines = frame.split("\n");
  assert.ok(lines.length <= 24, `expected at most 24 lines, got ${lines.length}`);
  assert.equal(lines[0]?.startsWith(">_ kankaku"), true, "line 1 should be the header");
  assert.equal(lines[lines.length - 1]?.includes("q quit"), true, "the last line should be the footer hints");
  // The card grid budgets a fixed number of visible cards per screen from
  // `CARD_HEIGHT_ESTIMATE`; a card whose own height is left unbounded by
  // its long error message grows past that estimate and silently pushes
  // later cards out of the rendered window instead of clipping its own
  // message — this asserts the other cards stay visible.
  assert.equal(frame.includes("p0"), true, "the next card should still be visible");
  assert.equal(frame.includes("p1"), true, "a later card should still be visible");
});

test("PageDown/Home/End move the card selection with many projects", async () => {
  const { lastFrame, stdin } = render(
    <SyncScreen load={() => manyRowsModel(40)} syncOne={async () => ({ ok: true, message: "" })} syncAll={async () => []} roots={["/work"]} version="0.1.0" columns={100} rows={24} />,
  );
  const markedCard = (): string | undefined => (lastFrame() ?? "").match(/› (project-\d+)/)?.[1];

  assert.equal(markedCard(), "project-0");

  stdin.write("\u001B[F"); // End
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedCard(), "project-39");
  });

  stdin.write("\u001B[H"); // Home
  await settle(lastFrame);
  await waitFor(() => {
    assert.equal(markedCard(), "project-0");
  });

  stdin.write("\u001B[6~"); // Page Down
  await settle(lastFrame);
  await waitFor(() => {
    assert.notEqual(markedCard(), "project-0");
  });
});
