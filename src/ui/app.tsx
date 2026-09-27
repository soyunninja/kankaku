import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { buildTabBar, screenForKey } from "../domain/nav-model.ts";
import type { ScreenId } from "../domain/nav-model.ts";
import { TodayScreen } from "./today-screen.tsx";
import { TasksScreen } from "./tasks-screen.tsx";
import { CatalogScreen } from "./catalog-screen.tsx";
import type { CatalogScreenProps } from "./catalog-screen.tsx";
import { SyncScreen } from "./sync-screen.tsx";
import type { SyncScreenProps } from "./sync-screen.tsx";
import type { TodayModel } from "../domain/today-model.ts";
import type { TasksModel } from "../domain/tasks-model.ts";

export interface AppProps {
  roots: string[];
  loadToday: () => TodayModel;
  loadTasks: (options: { all: boolean }) => TasksModel;
  catalog: CatalogScreenProps;
  sync: SyncScreenProps;
}

function TabBar({ active }: { active: ScreenId }) {
  return (
    <Text>
      {buildTabBar(active)
        .map((item) => (item.active ? `[${item.text}]` : item.text))
        .join(" · ")}
    </Text>
  );
}

/**
 * The app shell: a tab bar (`domain/nav-model.ts`) above whichever screen
 * is active. `1`-`4` switch screens; `q` quits from anywhere (via Ink's
 * own `useApp().exit()`) — the Today screen additionally binds its own
 * `q` (kept for its existing standalone tests), which is harmless since
 * both paths call the same `exit()`.
 */
export function App({ roots, loadToday, loadTasks, catalog, sync }: AppProps) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenId>("today");

  useInput((input) => {
    const next = screenForKey(input);
    if (next !== undefined) {
      setScreen(next);
    } else if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <TabBar active={screen} />
      {screen === "today" && <TodayScreen load={loadToday} onQuit={() => exit()} roots={roots} />}
      {screen === "tasks" && <TasksScreen load={loadTasks} />}
      {screen === "catalog" && <CatalogScreen {...catalog} />}
      {screen === "sync" && <SyncScreen {...sync} />}
    </Box>
  );
}
