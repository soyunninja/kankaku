/**
 * The `/kankaku` panel's `assign` screen (see odd/tasks/kankaku-panel.md):
 * move one already-synced `task_entries` row to another client/project from
 * the panel, exactly like the interactive `/kankaku assign` subcommand.
 *
 * Every user-facing line comes from the shared builders in
 * `adapters/hub-actions.ts` ({@link formatAssignRowLabel},
 * {@link formatAssignResultLines}, {@link describeAssignFailure},
 * {@link ASSIGN_NO_PROJECT_LABEL}) and every payload from the same
 * `domain/hub-assign.ts#resolveHubAssignment` the subcommand uses, so the
 * two paths can never drift. Only the `{ client, project }` pair is ever
 * written (README "Hub (PocketBase)" > "Assignment is create-only").
 *
 * `HubAssign#listRecent()` is read exactly once, when the screen is built:
 * the row builder (`domain/panel-model.ts#buildAssignRows`) is pure and is
 * handed that already-read state.
 */
import type { Component, SelectItem, SettingItem, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SelectList, SettingsList } from "@earendil-works/pi-tui";
import { resolveHubAssignment } from "../../../domain/hub-assign.ts";
import { buildAssignRows } from "../../../domain/panel-model.ts";
import type { AssignRowOption, PanelRow } from "../../../domain/panel-model.ts";
import type { Client, Project } from "../../../domain/work-target.ts";
import type { Catalog, CatalogSnapshot } from "../../../ports/catalog.ts";
import type { HubAssign, SyncedTaskEntryRow } from "../../hub-assign.ts";
import { ASSIGN_NO_PROJECT_LABEL, describeAssignFailure, formatAssignResultLines, formatAssignRowLabel } from "../../hub-actions.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { actionItem } from "../panel-items.ts";
import { buildSelectListTheme, buildSettingsListTheme } from "../panel-theme.ts";

export interface AssignScreenDeps {
  /** Read/assign access to the hub; the root menu only offers this screen when the hub is configured. */
  hubAssign: HubAssign;
  /** Present only when the hub is configured; the client/project submenus need its snapshot. */
  catalog?: Catalog;
}

/** The `(no project)` entry's select value; never a real `projects` id. */
const NO_PROJECT_VALUE = "__kankaku_no_project__";
const MAX_VISIBLE = 10;

/** The `/kankaku assign` subcommand's catalog failure, verbatim. */
const CATALOG_UNAVAILABLE = "catalog unavailable; run '/kankaku catalog refresh'";

/**
 * `label -> item` options sorted by name, disambiguating a name collision
 * with ` (code)` — mirrors `kankaku-command.ts`'s private `hubLabelOptions`
 * (not exported, so this is a small self-contained equivalent rather than a
 * cross-module reach for a private helper), so both pickers offer the same
 * labels.
 */
function labelOptions<T extends { name: string; code?: string }>(items: T[]): Array<{ label: string; item: T }> {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const nameCounts = new Map<string, number>();
  for (const item of sorted) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  return sorted.map((item) => {
    const collides = (nameCounts.get(item.name) ?? 0) > 1;
    return { label: collides && item.code ? `${item.name} (${item.code})` : item.name, item };
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

class AssignScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: AssignScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  /** The catalog snapshot read once at construction; every label and submenu resolves against it. */
  private readonly snapshot: CatalogSnapshot | undefined;
  private rows: SyncedTaskEntryRow[] = [];
  private loadError: string | undefined;
  private selectedTask: AssignRowOption | undefined;
  private selectedClient: Client | undefined;
  private selectedProject: Project | undefined;
  private list: SettingsList;

  constructor(deps: AssignScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.snapshot = deps.catalog?.read();
    this.list = this.buildList();
    void this.loadRows();
  }

  /**
   * Read the hub's recent synced rows exactly once, then rebuild the list
   * with their shared labels. A failed read is remembered (never thrown,
   * since this runs detached) and shown as the task-entry submenu's note.
   */
  private async loadRows(): Promise<void> {
    try {
      this.rows = await this.deps.hubAssign.listRecent();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      this.rows = [];
    }
    this.list = this.buildList();
    this.host.requestRender();
  }

  /** The synced rows as labelled options, exactly as `/kankaku assign`'s picker shows them. */
  private rowOptions(): AssignRowOption[] {
    return this.rows.map((row, index) => ({ taskId: row.taskId, label: formatAssignRowLabel(row, index + 1, this.snapshot) }));
  }

  /** Every client `/kankaku assign` would offer: active, never "Sin determinar". */
  private assignableClients(): Client[] {
    return (this.snapshot?.clients ?? []).filter((client) => client.active && !client.unassigned);
  }

  private projectsFor(client: Client): Project[] {
    return (this.snapshot?.projects ?? []).filter((project) => project.active && project.clientId === client.id);
  }

  private currentRows(): PanelRow[] {
    const client = this.selectedClient;
    return buildAssignRows({
      syncedRows: this.rowOptions(),
      clients: this.assignableClients(),
      projects: client !== undefined ? this.projectsFor(client) : [],
      ...(this.selectedTask !== undefined ? { selectedTaskId: this.selectedTask.taskId } : {}),
      ...(client !== undefined ? { selectedClientId: client.id } : {}),
      ...(this.selectedProject !== undefined ? { selectedProjectId: this.selectedProject.id } : {}),
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

  /** Rebuild the list from the current state, keep the cursor on `navigateToId`, and notify the host. */
  private applyChange(navigateToId: string): void {
    this.list = this.buildList();
    this.list.selectItem(navigateToId);
    this.host.requestRender();
  }

  private buildItem(row: PanelRow): SettingItem {
    switch (row.id) {
      case "task-entry":
        return this.rowItem(row, (done) => this.buildTaskEntrySubmenu(done));
      case "client":
        return this.rowItem(row, (done) => this.buildClientSubmenu(done));
      case "project":
        return this.rowItem(row, (done) => this.buildProjectSubmenu(done));
      case "assign":
        return this.buildAssignItem(row);
      default:
        return this.plainItem(row);
    }
  }

  private plainItem(row: PanelRow): SettingItem {
    return { id: row.id, label: row.label, currentValue: row.value, ...(row.description !== undefined ? { description: row.description } : {}) };
  }

  /**
   * Wraps a row's submenu factory so opening it sets
   * `PanelHost.setBodyCapturesEscape(true)` (the shell then forwards
   * Escape/← to this screen instead of popping it while the submenu is
   * open) and clears it again right before the submenu's own `done` is
   * invoked, on every close path (a pick, cancel, or a note closing on any
   * key). Same shape as `screens/target.ts`.
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

  private buildTaskEntrySubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    if (this.loadError !== undefined) {
      return new NoteComponent(this.settingsTheme, `error: ${this.loadError}`, done);
    }
    if (this.rows.length === 0) {
      return new NoteComponent(this.settingsTheme, "error: no synced task entries found", done);
    }

    const options = this.rowOptions();
    const items: SelectItem[] = options.map((option) => ({ value: option.taskId, label: option.label }));
    const list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(this.host.theme));
    list.onSelect = (item) => {
      const option = options.find((candidate) => candidate.taskId === item.value);
      if (option && option.taskId !== this.selectedTask?.taskId) {
        // A different row invalidates the client/project pair chosen for the old one.
        this.selectedClient = undefined;
        this.selectedProject = undefined;
      }
      if (option) this.selectedTask = option;
      done();
      this.applyChange("task-entry");
    };
    list.onCancel = () => done();
    return list;
  }

  private buildClientSubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const options = labelOptions(this.assignableClients());
    if (options.length === 0) {
      return new NoteComponent(this.settingsTheme, "error: no assignable client in the catalog", done);
    }

    const items: SelectItem[] = options.map((option) => ({ value: option.item.id, label: option.label }));
    const list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(this.host.theme));
    list.onSelect = (item) => {
      const client = options.find((option) => option.item.id === item.value)?.item;
      if (client && client.id !== this.selectedClient?.id) {
        // The project submenu lists the chosen client's projects, so a new client clears the old project.
        this.selectedProject = undefined;
      }
      if (client) this.selectedClient = client;
      done();
      this.applyChange("client");
    };
    list.onCancel = () => done();
    return list;
  }

  private buildProjectSubmenu(done: (selectedValue?: string, options?: { navigateTo?: string }) => void): Component {
    const client = this.selectedClient;
    if (!client) {
      return new NoteComponent(this.settingsTheme, "Pick a client first.", done);
    }

    const options = labelOptions(this.projectsFor(client));
    const items: SelectItem[] = [
      ...options.map((option) => ({ value: option.item.id, label: option.label })),
      { value: NO_PROJECT_VALUE, label: ASSIGN_NO_PROJECT_LABEL },
    ];
    const list = new SelectList(items, MAX_VISIBLE, buildSelectListTheme(this.host.theme));
    list.onSelect = (item) => {
      // The explicit "(no project)" entry is what clears the relation; see `resolveHubAssignment`'s `projectReference === undefined`.
      this.selectedProject = item.value === NO_PROJECT_VALUE ? undefined : options.find((option) => option.item.id === item.value)?.item;
      done();
      this.applyChange("project");
    };
    list.onCancel = () => done();
    return list;
  }

  private buildAssignItem(row: PanelRow): SettingItem {
    const item = actionItem(this.settingsTheme, {
      id: row.id,
      label: row.label,
      ...(row.description !== undefined ? { description: row.description } : {}),
      run: () => this.runAssign(),
      onOpen: () => this.host.setBodyCapturesEscape(true),
      onClose: () => this.host.setBodyCapturesEscape(false),
      onDone: () => this.host.requestRender(),
    });
    return { ...item, currentValue: row.value };
  }

  /**
   * PATCH the selected row's `{ client, project }` pair and report the
   * outcome, or throw with the subcommand's own wording when the row is
   * gone, the catalog is unavailable, or the selection no longer resolves.
   * `actionItem` renders a thrown error as `error: <message>`.
   */
  private async runAssign(): Promise<string[]> {
    const snapshot = this.snapshot;
    if (!snapshot) throw new Error(CATALOG_UNAVAILABLE);

    const task = this.selectedTask;
    if (!task) throw new Error("no synced task entry selected");

    const client = this.selectedClient;
    if (!client) throw new Error("no assignable client selected");

    // Same resolver as the direct subcommand form, fed by code (falling back
    // to name), so the two paths can never build a different payload.
    const project = this.selectedProject;
    const resolution = resolveHubAssignment(snapshot, client.code || client.name, project !== undefined ? project.code || project.name : undefined);
    if (resolution.kind !== "resolved") throw new Error(describeAssignFailure(resolution));

    const outcome = await this.deps.hubAssign.assign(task.taskId, resolution.payload);
    if (outcome.kind === "not-found") throw new Error(`no synced task entry with task_id ${task.taskId}`);

    return formatAssignResultLines({
      taskId: task.taskId,
      client: resolution.client,
      ...(resolution.project !== undefined ? { project: resolution.project } : {}),
    });
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

/** `openKankakuPanel`'s `screens.assign` factory; see {@link AssignScreenDeps}. */
export function createAssignScreen(deps: AssignScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new AssignScreenComponent(deps, host);
}
