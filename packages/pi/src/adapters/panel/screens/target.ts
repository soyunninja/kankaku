/**
 * The `/kankaku` panel's `target` screen (see odd/tasks/kankaku-panel.md):
 * billing client, project, hub task and the legacy label, all editable from
 * one `SettingsList`. A subagent session never resolves its own target
 * (see AGENTS.md "Measurement rules"), so it gets a read-only note instead.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, SettingItem, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Input, SelectList, SettingsList, Text } from "@earendil-works/pi-tui";
import { isValidClient } from "../../../domain/client-label.ts";
import { buildTargetRows } from "../../../domain/panel-model.ts";
import type { PanelRow } from "../../../domain/panel-model.ts";
import type { WorkRole } from "../../../domain/work-record.ts";
import type { HubTask, WorkTargetSourceName } from "../../../domain/work-target.ts";
import type { Catalog } from "../../../ports/catalog.ts";
import type { SessionClient } from "../../session-client.ts";
import type { SessionTarget } from "../../session-target.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { actionItem } from "../panel-items.ts";
import { buildSelectListTheme, buildSettingsListTheme } from "../panel-theme.ts";

export interface TargetScreenDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  role: WorkRole;
  /** Present only when the hub (PocketBase) is configured; see `PiTrackerDeps.sessionTarget`. */
  sessionTarget?: SessionTarget;
  sessionClient: SessionClient;
  /** Present only when the hub is configured. */
  catalog?: Catalog;
  refreshIdleStatus: (ctx: ExtensionContext) => void;
}

const SUBAGENT_NOTE = "Subagent session: the billing target is inherited from the orchestrator and cannot be changed here.";
const USE_DEFAULTS_VALUE = "__kankaku_use_defaults__";
const NO_PROJECT_VALUE = "__kankaku_no_project__";
const NO_TASK_VALUE = "__kankaku_no_task__";
const CREATE_TASK_VALUE = "__kankaku_create_task__";
/** Same wording as the `/kankaku target pick` picker's own option (`adapters/target-picker.ts`). */
const CREATE_TASK_LABEL = "＋ create task ＋";
const NO_OPEN_TASKS_NOTE = "No open tasks for this project in the hub";
const MAX_VISIBLE = 10;

/** `WorkTargetSourceName` ("session" | "project" | "repoPaths"), formatted for the read-only `source` row ("session" | "config" | "repoPaths"). */
function formatTargetSource(source: WorkTargetSourceName | undefined): string | undefined {
  if (source === undefined) return undefined;
  return source === "project" ? "config" : source;
}

/** Sort by `name`, ascending; never mutates the input. */
function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build `label -> task` options for the task submenu, sorted by title. When
 * two tasks share the same title, disambiguate every colliding label with
 * the task's `externalRef` when it has one, or its bare id otherwise —
 * mirrors `adapters/target-picker.ts`'s private `labelTaskOptions` (not
 * exported, so this is a small self-contained equivalent rather than a
 * cross-module reach for a private helper).
 */
function labelTasks(tasks: HubTask[]): Array<{ label: string; task: HubTask }> {
  const sorted = [...tasks].sort((a, b) => a.title.localeCompare(b.title));
  const titleCounts = new Map<string, number>();
  for (const task of sorted) titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  return sorted.map((task) => {
    const collides = (titleCounts.get(task.title) ?? 0) > 1;
    const label = collides ? `${task.title} (${task.externalRef ?? task.id})` : task.title;
    return { label, task };
  });
}

/** A one-line note shown as a submenu; closes back to the row that opened it on any key, without touching anything. */
class NoteComponent implements Component {
  private readonly theme: SettingsListTheme;
  private readonly text: string;
  private readonly done: (selectedValue?: string, options?: { navigateTo?: string }) => void;

  constructor(theme: SettingsListTheme, text: string, done: (selectedValue?: string, options?: { navigateTo?: string }) => void) {
    this.theme = theme;
    this.text = text;
    this.done = done;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    return [this.theme.hint(this.text)];
  }

  handleInput(_data: string): void {
    this.done();
  }
}

/**
 * The legacy-label submenu: a pi-tui `Input` prefilled with the current
 * label. While open, the panel shell must forward `q` as ordinary input
 * (never close-on-q) — `PanelHost.setBodyWantsText` is set on construction
 * and cleared whenever this component closes, on every path.
 */
class LegacyLabelComponent implements Component {
  private readonly theme: SettingsListTheme;
  private readonly host: PanelHost;
  private readonly onValid: (value: string | undefined) => void;
  private readonly done: (selectedValue?: string, options?: { navigateTo?: string }) => void;
  private readonly input: Input;
  private invalidLabel: string | undefined;

  constructor(
    theme: SettingsListTheme,
    initialValue: string,
    host: PanelHost,
    onValid: (value: string | undefined) => void,
    done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
  ) {
    this.theme = theme;
    this.host = host;
    this.onValid = onValid;
    this.done = done;
    this.input = new Input();
    this.input.setValue(initialValue);
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.input.onEscape = () => this.handleEscape();
    this.host.setBodyWantsText(true);
  }

  private handleSubmit(rawValue: string): void {
    const trimmed = rawValue.trim();
    if (trimmed.length > 0 && !isValidClient(trimmed)) {
      this.invalidLabel = trimmed;
      return;
    }
    this.close();
    this.onValid(trimmed.length > 0 ? trimmed : undefined);
  }

  private handleEscape(): void {
    this.close();
  }

  private close(): void {
    this.host.setBodyWantsText(false);
    // No `navigateTo`: the "legacy" row's own `SettingItem.submenu` would
    // otherwise make `SettingsList.closeSubmenu()` reactivate it right back
    // open (its `navigateAfterClose` mechanism reopens the target item's
    // submenu when it has one — see settings-list.js). A successful submit
    // rebuilds the list from scratch via `applyChange`, which already
    // repositions the cursor on "legacy" itself; a cancel needs no
    // rebuild at all — plain `done()` just restores the row selection.
    this.done();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const lines = this.input.render(width);
    if (this.invalidLabel === undefined) return lines;
    return [...lines, this.theme.hint(`error: invalid label "${this.invalidLabel}"`)];
  }

  handleInput(data: string): void {
    this.invalidLabel = undefined;
    this.input.handleInput(data);
  }
}

/**
 * The task submenu: the project's open tasks, `＋ create task ＋` and
 * `— none —`. Choosing `＋ create task ＋` swaps the list for a title
 * `Input` in place; Escape there returns to the list, and a submitted
 * title is handed to `onCreate`. Like the legacy-label field, the title
 * field needs `PanelHost.setBodyWantsText` so `q` types instead of closing
 * the panel; it is cleared on every path out of the field.
 */
class TaskSubmenuComponent implements Component {
  private readonly theme: SettingsListTheme;
  private readonly host: PanelHost;
  private readonly list: SelectList;
  private readonly showEmptyNote: boolean;
  private readonly onCreate: (title: string) => Promise<void>;
  private input: Input | undefined;
  private titleError: string | undefined;
  private creating = false;

  constructor(
    theme: SettingsListTheme,
    host: PanelHost,
    options: Array<{ label: string; task: HubTask }>,
    handlers: { onPick: (taskId: string) => void; onClear: () => void; onCreate: (title: string) => Promise<void>; onCancel: () => void },
  ) {
    this.theme = theme;
    this.host = host;
    this.showEmptyNote = options.length === 0;
    this.onCreate = handlers.onCreate;
    const items: SelectItem[] = [
      ...options.map((option) => ({ value: option.task.id, label: option.label })),
      { value: CREATE_TASK_VALUE, label: CREATE_TASK_LABEL },
      { value: NO_TASK_VALUE, label: "— none —" },
    ];
    this.list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(host.theme));
    this.list.onSelect = (item) => {
      if (item.value === CREATE_TASK_VALUE) this.openTitleField();
      else if (item.value === NO_TASK_VALUE) handlers.onClear();
      else handlers.onPick(item.value);
    };
    this.list.onCancel = () => handlers.onCancel();
  }

  private openTitleField(): void {
    const input = new Input();
    input.onSubmit = (value) => this.submitTitle(value);
    input.onEscape = () => this.closeTitleField();
    this.input = input;
    this.titleError = undefined;
    this.host.setBodyWantsText(true);
    this.host.requestRender();
  }

  private closeTitleField(): void {
    this.input = undefined;
    this.titleError = undefined;
    this.host.setBodyWantsText(false);
    this.host.requestRender();
  }

  private submitTitle(rawValue: string): void {
    const title = rawValue.trim();
    if (title.length === 0) {
      this.titleError = "the title is required";
      return;
    }
    this.creating = true;
    this.host.setBodyWantsText(false);
    this.host.requestRender();
    void this.onCreate(title);
  }

  invalidate(): void {
    this.list.invalidate();
    this.input?.invalidate();
  }

  render(width: number): string[] {
    if (this.creating) return [this.theme.hint("Creating task…")];
    if (this.input) {
      const lines = [this.theme.hint("New task title (Enter to create, Esc to go back)"), ...this.input.render(width)];
      return this.titleError === undefined ? lines : [...lines, this.theme.hint(`error: ${this.titleError}`)];
    }
    const lines = this.list.render(width);
    return this.showEmptyNote ? [this.theme.hint(NO_OPEN_TASKS_NOTE), ...lines] : lines;
  }

  handleInput(data: string): void {
    if (this.creating) return;
    if (this.input) {
      this.titleError = undefined;
      this.input.handleInput(data);
      return;
    }
    this.list.handleInput(data);
  }
}

class TargetScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: TargetScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  private list: SettingsList;

  constructor(deps: TargetScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.list = this.buildList();
  }

  private currentRows(): PanelRow[] {
    const sessionTarget = this.deps.sessionTarget;
    const target = sessionTarget?.effectiveTarget();
    const source = sessionTarget ? formatTargetSource(sessionTarget.effectiveSource()) : undefined;
    const legacyLabel = this.deps.sessionClient.effectiveClient();
    const legacySource = this.deps.sessionClient.effectiveSource();
    return buildTargetRows({
      hubConfigured: sessionTarget !== undefined,
      target,
      source,
      legacyLabel,
      legacySource,
    });
  }

  private buildList(): SettingsList {
    const items = this.currentRows().map((row) => this.buildItem(row));
    return new SettingsList(
      items,
      MAX_VISIBLE,
      this.settingsTheme,
      () => {},
      () => this.host.back(),
      { enableSearch: false },
    );
  }

  /** Rebuild the list from fresh state after a mutation, keep the cursor on `navigateToId`, and notify the host — see the feature doc's "After EVERY change" rule. */
  private applyChange(navigateToId: string): void {
    this.list = this.buildList();
    this.list.selectItem(navigateToId);
    this.deps.refreshIdleStatus(this.deps.ctx);
    this.host.requestRender();
  }

  private buildItem(row: PanelRow): SettingItem {
    switch (row.id) {
      case "client":
        return this.rowItem(row, (done) => this.buildClientSubmenu(done));
      case "project":
        return this.rowItem(row, (done) => this.buildProjectSubmenu(done));
      case "task":
        return this.rowItem(row, (done) => this.buildTaskSubmenu(done));
      case "remember":
        return this.buildRememberItem(row);
      case "legacy":
        return this.rowItem(row, (done) => this.buildLegacySubmenu(done));
      case "source":
      default:
        return this.plainItem(row);
    }
  }

  private plainItem(row: PanelRow): SettingItem {
    return { id: row.id, label: row.label, currentValue: row.value, ...(row.description !== undefined ? { description: row.description } : {}) };
  }

  /**
   * Wraps a row's submenu factory so opening it sets
   * `PanelHost.setBodyCapturesEscape(true)` (the shell forwards Escape/←
   * to this screen instead of popping it while the submenu — or the
   * legacy-label `Input`, which also uses this via `buildLegacySubmenu` —
   * is open) and clears it again right before the submenu's own `done` is
   * invoked, on every close path (a pick, "— use defaults —"/"— none —",
   * cancel, or a disabled note closing on any key).
   */
  private rowItem(row: PanelRow, submenu: (done: (selectedValue?: string, options?: { navigateTo?: string }) => void) => Component): SettingItem {
    return {
      ...this.plainItem(row),
      submenu: (_currentValue, done) => {
        this.host.setBodyCapturesEscape(true);
        return submenu((selectedValue, options) => {
          this.host.setBodyCapturesEscape(false);
          done(selectedValue, options);
        });
      },
    };
  }

  private buildClientSubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const clients = (this.deps.catalog?.read()?.clients ?? []).filter((client) => client.active && !client.unassigned);
    const items: SelectItem[] = [
      ...sortByName(clients).map((client) => ({ value: client.id, label: `${client.name} (${client.code})` })),
      { value: USE_DEFAULTS_VALUE, label: "— use defaults —" },
    ];
    const list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(this.host.theme));
    list.onSelect = (item) => {
      if (item.value === USE_DEFAULTS_VALUE) {
        this.deps.sessionTarget?.clear(this.deps.pi);
      } else {
        this.deps.sessionTarget?.setExplicit(this.deps.pi, { clientId: item.value });
      }
      done();
      this.applyChange("client");
    };
    list.onCancel = () => done();
    return list;
  }

  private buildProjectSubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const target = this.deps.sessionTarget?.effectiveTarget();
    if (!target) {
      return new NoteComponent(this.settingsTheme, "Pick a client first.", done);
    }

    const projects = (this.deps.catalog?.read()?.projects ?? []).filter((project) => project.active && project.clientId === target.clientId);
    const items: SelectItem[] = [
      ...sortByName(projects).map((project) => ({ value: project.id, label: project.name })),
      { value: NO_PROJECT_VALUE, label: "(no project)" },
    ];
    const list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(this.host.theme));
    list.onSelect = (item) => {
      const projectId = item.value === NO_PROJECT_VALUE ? undefined : item.value;
      this.deps.sessionTarget?.setExplicit(this.deps.pi, { clientId: target.clientId, ...(projectId !== undefined ? { projectId } : {}) });
      done();
      this.applyChange("project");
    };
    list.onCancel = () => done();
    return list;
  }

  private buildTaskSubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const target = this.deps.sessionTarget?.effectiveTarget();
    if (!target || target.projectId === undefined) {
      return new NoteComponent(this.settingsTheme, "Pick a project first.", done);
    }

    const tasks = (this.deps.catalog?.read()?.tasks ?? []).filter((task) => task.status !== "done" && task.projectId === target.projectId);
    const finish = (): void => {
      done();
      this.applyChange("task");
    };
    return new TaskSubmenuComponent(this.settingsTheme, this.host, labelTasks(tasks), {
      onPick: (taskId) => {
        this.deps.sessionTarget?.setTask(this.deps.pi, taskId);
        finish();
      },
      onClear: () => {
        this.deps.sessionTarget?.clearTask(this.deps.pi);
        finish();
      },
      // `SessionTarget.newTask` creates, caches and links the task and
      // reports the outcome (success or failure) through `ctx.ui.notify`,
      // exactly as `/kankaku task new <title>` does; the row is rebuilt
      // from the resulting state either way.
      onCreate: async (title) => {
        try {
          await this.deps.sessionTarget?.newTask(this.deps.pi, this.deps.ctx, title);
        } catch (error) {
          // `newTask` reports hub failures itself; only a missing task creator reaches here.
          if (this.deps.ctx.hasUI) this.deps.ctx.ui.notify(`kankaku: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        finish();
      },
      onCancel: () => done(),
    });
  }

  private buildRememberItem(row: PanelRow): SettingItem {
    const item = actionItem(this.settingsTheme, {
      id: row.id,
      label: row.label,
      description: row.description,
      run: () => {
        const saved = this.deps.sessionTarget?.rememberTarget() ?? false;
        return [saved ? "saved clientId/projectId to config.json" : "nothing to save"];
      },
      onOpen: () => this.host.setBodyCapturesEscape(true),
      onClose: () => this.host.setBodyCapturesEscape(false),
      onDone: () => this.host.requestRender(),
    });
    return { ...item, currentValue: row.value };
  }

  private buildLegacySubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const initial = this.deps.sessionClient.effectiveClient() ?? "";
    return new LegacyLabelComponent(
      this.settingsTheme,
      initial,
      this.host,
      (value) => {
        this.deps.sessionClient.set(this.deps.pi, value);
        this.applyChange("legacy");
      },
      done,
    );
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return this.list.render(width);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse?.(event);
  }
}

/** `openKankakuPanel`'s `screens.target` factory; see {@link TargetScreenDeps}. */
export function createTargetScreen(deps: TargetScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => {
    if (deps.role !== "orchestrator") {
      return new Text(host.theme.fg("muted", SUBAGENT_NOTE));
    }
    return new TargetScreenComponent(deps, host);
  };
}
