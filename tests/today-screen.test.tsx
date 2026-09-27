import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { TodayScreen } from "../src/ui/today-screen.tsx";
import type { TodayModel } from "../src/domain/today-model.ts";

function model(): TodayModel {
  return {
    rows: [{ name: "alpha", tasks: 2, wallMs: 3720000, workMs: 3480000, waitingMs: 240000, cost: 1.23, cacheHit: 0.71 }],
    total: { name: "total", tasks: 2, wallMs: 3720000, workMs: 3480000, waitingMs: 240000, cost: 1.23, cacheHit: 0.71 },
  };
}

test("TodayScreen renders the title, a project row, the total and the footer", () => {
  let loadCalls = 0;
  const { lastFrame } = render(
    <TodayScreen
      load={() => {
        loadCalls += 1;
        return model();
      }}
      onQuit={() => {}}
      roots={["/work"]}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, />_ kankaku · Today/);
  assert.match(frame, /alpha/);
  assert.match(frame, /total/);
  assert.match(frame, /r refresh · q quit/);
  assert.equal(loadCalls, 1);
});

test("TodayScreen shows the empty state under the configured roots when there is nothing today", () => {
  const { lastFrame } = render(
    <TodayScreen load={() => ({ rows: [], total: { name: "total", tasks: 0, wallMs: 0, workMs: 0, waitingMs: 0, cost: 0 } })} onQuit={() => {}} roots={["/work", "/other"]} />,
  );
  assert.match(lastFrame() ?? "", /no work recorded today under \/work, \/other/);
});

test("TodayScreen calls onQuit when 'q' is pressed", () => {
  let quit = false;
  const { stdin } = render(<TodayScreen load={() => model()} onQuit={() => (quit = true)} roots={["/work"]} />);
  stdin.write("q");
  assert.equal(quit, true);
});

test("TodayScreen reloads when 'r' is pressed", () => {
  let loadCalls = 0;
  const { stdin } = render(
    <TodayScreen
      load={() => {
        loadCalls += 1;
        return model();
      }}
      onQuit={() => {}}
      roots={["/work"]}
    />,
  );
  stdin.write("r");
  assert.equal(loadCalls, 2);
});
