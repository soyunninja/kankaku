/**
 * The `/kankaku` panel's `report` screen (see odd/tasks/kankaku-panel.md):
 * `view`/`range`/`scope` rows drive the same five report builders
 * (`adapters/report-views.ts`) the `/kankaku` subcommands use, so this
 * screen can never drift from `tasks`/`sessions`/`clients`/`projects`/the
 * plain summary. A `pin` action appends the current view's report as a
 * durable chat entry, exactly like every subcommand already does.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import type { KankakuReportData } from "../../kankaku-command.ts";
import { buildClientsView, buildProjectsView, buildSessionsView, buildSummaryView, buildTasksView } from "../../report-views.ts";
import type { WorkLog } from "../../../ports/work-log.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { renderBoundedLines } from "../panel-lines.ts";
import { actionItem } from "../panel-items.ts";
import { buildSettingsListTheme } from "../panel-theme.ts";

export interface ReportScreenDeps {
  log: WorkLog;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  /** Resolves this session's id, e.g. `() => ctx.sessionManager.getSessionId()`. Used by the `tasks` view's `scope` row. */
  sessionId?: () => string | undefined;
  pinReport: (report: KankakuReportData) => void;
}

type ReportView = "summary" | "tasks" | "sessions" | "clients" | "projects";
type RangeValue = "today" | "all";
type ScopeValue = "session" | "all sessions";

const VIEW_VALUES: ReportView[] = ["summary", "tasks", "sessions", "clients", "projects"];
const RANGE_VALUES: RangeValue[] = ["today", "all"];
const SCOPE_VALUES: ScopeValue[] = ["session", "all sessions"];
const MAX_VISIBLE = 6;
const MAX_BODY_LINES = 14;
const NOT_APPLICABLE = "n/a";

class ReportScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: ReportScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  private view: ReportView = "summary";
  private range: RangeValue = "today";
  private scope: ScopeValue = "session";
  private report: KankakuReportData;
  private list: SettingsList;

  constructor(deps: ReportScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.report = this.computeReport();
    this.list = this.buildList();
  }

  private computeReport(): KankakuReportData {
    const records = this.deps.log.readAll();
    switch (this.view) {
      case "tasks":
        return buildTasksView(records, { all: this.scope === "all sessions", sessionId: this.deps.sessionId?.() });
      case "sessions":
        return buildSessionsView(records, { all: this.range === "all" });
      case "clients":
        return buildClientsView(records, { all: this.range === "all" });
      case "projects":
        return buildProjectsView(records, { all: this.range === "all" });
      case "summary":
      default:
        return buildSummaryView(records, { all: this.range === "all" });
    }
  }

  private buildRangeItem(): SettingItem {
    if (this.view === "tasks") {
      return { id: "range", label: "Range", currentValue: NOT_APPLICABLE, description: "the tasks view uses scope, not range" };
    }
    return { id: "range", label: "Range", currentValue: this.range, values: RANGE_VALUES };
  }

  private buildScopeItem(): SettingItem {
    if (this.view !== "tasks") {
      return { id: "scope", label: "Scope", currentValue: NOT_APPLICABLE, description: "applies only to the tasks view" };
    }
    return { id: "scope", label: "Scope", currentValue: this.scope, values: SCOPE_VALUES };
  }

  private buildList(): SettingsList {
    const items: SettingItem[] = [
      { id: "view", label: "View", currentValue: this.view, values: VIEW_VALUES },
      this.buildRangeItem(),
      this.buildScopeItem(),
      actionItem(this.settingsTheme, {
        id: "pin",
        label: "Pin to chat",
        run: () => {
          this.deps.pinReport(this.report);
          return ["pinned to the chat transcript"];
        },
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.host.requestRender(),
      }),
    ];
    return new SettingsList(items, MAX_VISIBLE, this.settingsTheme, (id, value) => this.onChange(id, value), () => this.host.back(), {
      enableSearch: false,
    });
  }

  private onChange(id: string, value: string): void {
    if (id === "view") this.view = value as ReportView;
    else if (id === "range") this.range = value as RangeValue;
    else if (id === "scope") this.scope = value as ScopeValue;

    this.report = this.computeReport();
    this.list = this.buildList();
    this.list.selectItem(id);
    this.host.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [...this.list.render(width), "", ...renderBoundedLines(this.report.lines, MAX_BODY_LINES)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse?.(event);
  }
}

/** `openKankakuPanel`'s `screens.report` factory; see {@link ReportScreenDeps}. */
export function createReportScreen(deps: ReportScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new ReportScreenComponent(deps, host);
}
