import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { CatalogScreen } from "../src/ui/catalog-screen.tsx";
import type { CatalogModel } from "../src/domain/catalog-model.ts";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

function readyModel(): CatalogModel {
  return {
    status: "ready",
    url: "https://pb.example.com",
    fetchedAt: 0,
    ageMs: 60_000,
    stale: false,
    clients: [
      { id: "c1", name: "Acme", code: "acme", projects: [{ id: "p1", name: "Website", openCount: 2, doingCount: 1 }] },
    ],
  };
}

test("CatalogScreen shows the unavailable note when the hub is not configured", () => {
  const { lastFrame } = render(
    <CatalogScreen load={() => ({ status: "unavailable", reason: "hub credentials are not configured" })} refresh={async () => ({ status: "unavailable" })} />,
  );
  assert.match(lastFrame() ?? "", /hub credentials are not configured/);
});

test("CatalogScreen lists clients and their projects with open/doing counts and a header", () => {
  const { lastFrame } = render(<CatalogScreen load={() => readyModel()} refresh={async () => readyModel()} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /https:\/\/pb\.example\.com/);
  assert.match(frame, /Acme/);
  assert.match(frame, /Website/);
  assert.match(frame, /open 2/);
  assert.match(frame, /doing 1/);
});

test("CatalogScreen flags a stale snapshot", () => {
  const { lastFrame } = render(
    <CatalogScreen load={() => ({ ...readyModel(), stale: true })} refresh={async () => readyModel()} />,
  );
  assert.match(lastFrame() ?? "", /stale/i);
});

test("CatalogScreen refreshes on 'r' and re-renders with the new snapshot", async () => {
  let refreshed = false;
  const { lastFrame, stdin } = render(
    <CatalogScreen
      load={() => ({ status: "unavailable" })}
      refresh={async () => {
        refreshed = true;
        return readyModel();
      }}
    />,
  );
  assert.match(lastFrame() ?? "", /no catalog cached yet/);
  stdin.write("r");
  await nextTick();
  assert.equal(refreshed, true);
  assert.match(lastFrame() ?? "", /Acme/);
});
