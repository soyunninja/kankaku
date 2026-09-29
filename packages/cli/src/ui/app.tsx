import { useState } from "react";
import { useApp, useInput } from "ink";
import {
  INITIAL_NAV_STATE,
  clearProjectFilter,
  focusMain,
  focusSidebar,
  moveSidebar,
  openProjectInTasks,
  screenForKey,
  setModal,
  switchScreen,
} from "../domain/nav-model.ts";
import type { NavState } from "../domain/nav-model.ts";
import { DashboardScreen } from "./dashboard-screen.tsx";
import type { DashboardActions } from "./dashboard-screen.tsx";
import { TasksScreen } from "./tasks-screen.tsx";
import { CatalogScreen } from "./catalog-screen.tsx";
import type { CatalogScreenProps } from "./catalog-screen.tsx";
import { SyncScreen } from "./sync-screen.tsx";
import type { SyncScreenProps } from "./sync-screen.tsx";
import { SetupWizard } from "./setup/wizard-screen.tsx";
import type { WizardActions } from "./setup/wizard-screen.tsx";
import type { DashboardModel } from "../domain/dashboard-model.ts";
import type { TasksModel } from "../domain/tasks-model.ts";
import type { WizardFacts } from "../domain/setup-wizard.ts";
import type { ReassignActions } from "../ports/reassign-actions.ts";

export interface AppProps {
  roots: string[];
  /** This app's own version, shown in every screen's header bar. */
  version: string;
  loadToday: () => DashboardModel;
  loadTasks: (options: { all: boolean }) => TasksModel;
  catalog: Pick<CatalogScreenProps, "load" | "refresh">;
  sync: Pick<SyncScreenProps, "load" | "syncOne" | "syncAll">;
  dashboardActions: DashboardActions;
  /** The setup wizard's own facts/actions, built by `cli.tsx`; omitted only in a standalone render that never opens it. */
  wizard?: { facts: WizardFacts; actions: WizardActions };
  /** Opens the app straight into the wizard (`kankaku setup` on a TTY, or the first-run hint) instead of the Dashboard. */
  startInWizard?: boolean;
  /** The hub side of the Tasks screen's `a`/`A` reassignment; omitted when no hub is wired (the keys then say so). */
  reassign?: ReassignActions;
}

/**
 * The app shell: owns navigation state (`domain/nav-model.ts`) and renders
 * whichever screen is active, each already wrapped in the shared
 * header/sidebar/footer frame (`ui/layout.tsx`). One `useInput` here owns
 * every global key and the focus routing between the sidebar and the
 * active screen's own main zone (see "Focus zones" in
 * `odd/tasks/visual-system.md`): sidebar focused, `↑`/`↓` move the active
 * screen and `enter`/`→`/`Tab` focus main; main focused, `←`/`Tab` return
 * to the sidebar and `esc` does too, unless the active screen consumes it
 * first (Tasks with a project filter set: the first `esc` clears it, the
 * next returns). `1`-`4` and `q` stay global regardless of focus; `q`
 * quits from anywhere (Ink's own `useApp().exit()`). Dashboard's `enter` on a
 * project row (only reachable once main is focused) opens Tasks filtered
 * to it, keeping focus on main; Tasks' own `esc` handling (gated the same
 * way as every other screen key, by its `focused` prop) clears that
 * filter — this hook only predicts whether that will happen, to decide
 * whether it should also move focus. While the Tasks screen has its
 * reassignment picker open (`NavState.modal`, reported through its
 * `onModalChange`), only `q` is handled here: `esc`, `←`, `Tab` and `1`-`4`
 * belong to the picker, so it can never be left half-way by accident.
 */
export function App({ roots, version, loadToday, loadTasks, catalog, sync, dashboardActions, wizard, startInWizard, reassign }: AppProps) {
  const { exit } = useApp();
  const [nav, setNav] = useState<NavState>(INITIAL_NAV_STATE);
  const [showWizard, setShowWizard] = useState(startInWizard === true && wizard !== undefined);

  useInput(
    (input, key) => {
      if (input === "q") {
        exit();
        return;
      }

      if (nav.modal === true) return;

      const nextScreen = screenForKey(input);
      if (nextScreen !== undefined) {
        setNav((state) => switchScreen(state, nextScreen));
        return;
      }

      setNav((state) => {
        if (state.focus === "sidebar") {
          if (key.downArrow) return moveSidebar(state, 1);
          if (key.upArrow) return moveSidebar(state, -1);
          if (key.return || key.rightArrow || key.tab) return focusMain(state);
          return state;
        }

        // Main zone focused.
        if (key.leftArrow || key.tab) return focusSidebar(state);
        if (key.escape) {
          // Tasks consumes the first `esc` itself (via its own `onClearFilter`,
          // gated by its `focused` prop just like every other screen key) to
          // clear its project filter; only move focus once there is none left.
          const consumedByTasks = state.screen === "tasks" && state.projectFilter !== undefined;
          return consumedByTasks ? state : focusSidebar(state);
        }
        return state;
      });
    },
    // While the wizard is active, it owns every keystroke itself (including
    // `q`, gated there by whether a text field currently has focus) — this
    // app-wide handler must stay out of the way entirely.
    { isActive: !showWizard },
  );

  const focused = nav.focus === "main";

  if (showWizard && wizard) {
    return <SetupWizard facts={wizard.facts} actions={wizard.actions} onDone={() => setShowWizard(false)} onQuit={() => exit()} version={version} />;
  }

  return (
    <>
      {nav.screen === "dashboard" && (
        <DashboardScreen
          load={loadToday}
          actions={dashboardActions}
          roots={roots}
          version={version}
          focused={focused}
          onOpenProject={(project) => setNav((state) => openProjectInTasks(state, project))}
        />
      )}
      {nav.screen === "tasks" && (
        <TasksScreen
          load={loadTasks}
          roots={roots}
          version={version}
          focused={focused}
          {...(nav.projectFilter !== undefined ? { projectFilter: nav.projectFilter } : {})}
          onClearFilter={() => setNav((state) => clearProjectFilter(state))}
          onModalChange={(open) => setNav((state) => (state.modal === true) === open ? state : setModal(state, open))}
          {...(reassign !== undefined ? { reassign } : {})}
        />
      )}
      {nav.screen === "catalog" && <CatalogScreen {...catalog} roots={roots} version={version} focused={focused} />}
      {nav.screen === "sync" && <SyncScreen {...sync} roots={roots} version={version} focused={focused} />}
    </>
  );
}
