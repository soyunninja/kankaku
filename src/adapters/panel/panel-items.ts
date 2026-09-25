/**
 * A reusable action row for a panel `SettingsList` screen: its submenu runs
 * an async action, shows a busy indicator while it runs, then the lines it
 * returned (or an inline error), and closes back to the row that opened it
 * on any Enter/Escape. Used by the target screen's "Remember" row (P2) and,
 * per the feature doc, meant for reuse by the sync/export screens (P4).
 */
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const PENDING_LINE = "…";

export interface ActionItemOptions {
  id: string;
  label: string;
  description?: string;
  /** Runs the action and returns the lines to show once it settles. May throw; a thrown error is shown as `error: <message>` instead. */
  run: () => string[] | Promise<string[]>;
  /** Called once `run()` settles (success or error), so the caller can re-render — this component has no `host` reference of its own. */
  onDone?: () => void;
  /** Called synchronously when the submenu component is created (the action starts running). */
  onOpen?: () => void;
  /** Called right before `done(...)` is invoked on close (Enter or Escape), so the caller can, e.g., clear `PanelHost.setBodyCapturesEscape`. */
  onClose?: () => void;
}

class ActionItemComponent implements Component {
  private readonly theme: SettingsListTheme;
  private readonly options: ActionItemOptions;
  private readonly done: (selectedValue?: string, options?: { navigateTo?: string }) => void;
  private lines: string[] = [];
  private pending = true;

  constructor(
    theme: SettingsListTheme,
    options: ActionItemOptions,
    done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
  ) {
    this.theme = theme;
    this.options = options;
    this.done = done;
    this.options.onOpen?.();
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      this.lines = await this.options.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lines = [`error: ${message}`];
    } finally {
      this.pending = false;
      this.options.onDone?.();
    }
  }

  invalidate(): void {}

  render(_width: number): string[] {
    return this.pending ? [this.theme.hint(PENDING_LINE)] : this.lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.options.onClose?.();
      // Close with NO `navigateTo`: pi-tui's `SettingsList.closeSubmenu`
      // treats `navigateTo` as "select that row and activate it", and
      // activating this row opens its submenu again — the result would
      // reopen and the action re-run on every Enter/Escape, leaving the
      // user stuck until `q`. Without it the list restores the cursor to
      // the row that opened the submenu on its own (`submenuItemIndex`).
      this.done();
    }
  }
}

/** Build a `SettingItem` whose submenu is a busy/result/error view over `options.run`. See the module doc comment. */
export function actionItem(theme: SettingsListTheme, options: ActionItemOptions): SettingItem {
  return {
    id: options.id,
    label: options.label,
    currentValue: "",
    ...(options.description !== undefined ? { description: options.description } : {}),
    submenu: (_currentValue, done) => new ActionItemComponent(theme, options, done),
  };
}
