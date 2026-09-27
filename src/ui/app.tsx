import { useState } from "react";
import { useApp, useInput } from "ink";
import { INITIAL_NAV_STATE, clearProjectFilter, openProjectInTasks, screenForKey, switchScreen } from "../domain/nav-model.ts";
import type { NavState } from "../domain/nav-model.ts";
import { TodayScreen } from "./today-screen.tsx";
import { TasksScreen } from "./tasks-screen.tsx";
import { CatalogScreen } from "./catalog-screen.tsx";
import type { CatalogScreenProps } from "./catalog-screen.tsx";
import { SyncScreen } from "./sync-screen.tsx";
import type { SyncScreenProps } from "./sync-screen.tsx";
import type { DashboardModel } from "../domain/dashboard-model.ts";
import type { TasksModel } from "../domain/tasks-model.ts";

export interface AppProps {
  roots: string[];
  /** This app's own version, shown in every screen's header bar. */
  version: string;
  loadToday: () => DashboardModel;
  loadTasks: (options: { all: boolean }) => TasksModel;
  catalog: Pick<CatalogScreenProps, "load" | "refresh">;
  sync: Pick<SyncScreenProps, "load" | "syncOne" | "syncAll">;
}

/**
 * The app shell: owns navigation state (`domain/nav-model.ts`) and renders
 * whichever screen is active, each already wrapped in the shared
 * header/sidebar/footer frame (`ui/layout.tsx`). `1`-`4` switch screens;
 * `q` quits from anywhere (Ink's own `useApp().exit()`). Today's `enter`
 * on a project row opens Tasks filtered to it; Tasks' `esc` clears that
 * filter.
 */
export function App({ roots, version, loadToday, loadTasks, catalog, sync }: AppProps) {
  const { exit } = useApp();
  const [nav, setNav] = useState<NavState>(INITIAL_NAV_STATE);

  useInput((input) => {
    const next = screenForKey(input);
    if (next !== undefined) {
      setNav((state) => switchScreen(state, next));
    } else if (input === "q") {
      exit();
    }
  });

  return (
    <>
      {nav.screen === "today" && (
        <TodayScreen load={loadToday} roots={roots} version={version} onOpenProject={(project) => setNav((state) => openProjectInTasks(state, project))} />
      )}
      {nav.screen === "tasks" && (
        <TasksScreen
          load={loadTasks}
          roots={roots}
          version={version}
          {...(nav.projectFilter !== undefined ? { projectFilter: nav.projectFilter } : {})}
          onClearFilter={() => setNav((state) => clearProjectFilter(state))}
        />
      )}
      {nav.screen === "catalog" && <CatalogScreen {...catalog} roots={roots} version={version} />}
      {nav.screen === "sync" && <SyncScreen {...sync} roots={roots} version={version} />}
    </>
  );
}
