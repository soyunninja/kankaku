import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { CatalogScreen } from "../src/ui/catalog-screen.tsx";
import type { CatalogModel } from "../src/domain/catalog-model.ts";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function readyModel(): CatalogModel {
  return {
    status: "ready",
    url: "https://kankaku.soyun.ninja",
    fetchedAt: 0,
    ageMs: 3 * 60 * 1000,
    stale: false,
    clients: [
      {
        id: "c1",
        name: "Acme",
        code: "ACME",
        projects: [
          { id: "p1", name: "Website", openCount: 2, doingCount: 1 },
          { id: "p2", name: "App", openCount: 0, doingCount: 0 },
        ],
      },
      { id: "c2", name: "Beta Co", code: "BETA", projects: [{ id: "p3", name: "Infra", openCount: 1, doingCount: 0 }] },
    ],
  };
}

test("renders the Clients panel and the selected client's Projects panel", () => {
  const { lastFrame } = render(
    <CatalogScreen load={readyModel} refresh={async () => readyModel()} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Clients"), true);
  assert.equal(frame.includes("Acme"), true);
  assert.equal(frame.includes("Beta Co"), true);
  assert.equal(frame.includes("Projects"), true);
  assert.equal(frame.includes("Website"), true);
  assert.equal(frame.includes("App"), true);
  assert.equal(frame.includes("Infra"), false);
});

test("down arrow moves the client selection and updates the Projects panel", async () => {
  const { lastFrame, stdin } = render(
    <CatalogScreen load={readyModel} refresh={async () => readyModel()} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  stdin.write("\u001B[B");
  await nextTick();
  const frame = lastFrame() ?? "";
  assert.equal(frame.includes("Infra"), true);
  assert.equal(frame.includes("Website"), false);
});

test("'r' refreshes and shows a note without hitting the network before that", async () => {
  let refreshCalls = 0;
  const { stdin } = render(
    <CatalogScreen
      load={readyModel}
      refresh={async () => {
        refreshCalls += 1;
        return readyModel();
      }}
      roots={["/work"]}
      version="0.1.0"
      columns={120}
    />,
  );
  stdin.write("r");
  await nextTick();
  assert.equal(refreshCalls, 1);
});

test("shows a plain note when unavailable", () => {
  const { lastFrame } = render(
    <CatalogScreen load={() => ({ status: "unavailable", reason: "hub not configured" })} refresh={async () => ({ status: "unavailable" })} roots={["/work"]} version="0.1.0" columns={120} />,
  );
  assert.equal((lastFrame() ?? "").includes("hub not configured"), true);
});

test("renders at 80 columns without overflowing any line", () => {
  const { lastFrame } = render(<CatalogScreen load={readyModel} refresh={async () => readyModel()} roots={["/work"]} version="0.1.0" columns={80} />);
  const lines = (lastFrame() ?? "").split("\n");
  assert.ok(lines.every((line) => line.length <= 80));
});
