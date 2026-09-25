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
      // Keep the cursor on the row that opened this action — the caller
      // (the enclosing SettingsList) restores selection to it by id.
      this.done(undefined, { navigateTo: this.options.id });
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
