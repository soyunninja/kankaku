/**
 * The `/kankaku` panel's `export` screen (see odd/tasks/kankaku-panel.md
 * P4): `Format`/`Range` rows plus a `Write file` action that computes the
 * export content through the exact same `buildExportContent`
 * (`adapters/report-views.ts`) `/kankaku export` uses, so the panel and the
 * subcommand can never drift. `Pin to chat` pins a short note of the last
 * write (or the current selection, before anything has been written).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import type { KankakuReportData } from "../../kankaku-command.ts";
import { buildExportContent } from "../../report-views.ts";
import type { WorkLog } from "../../../ports/work-log.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { actionItem } from "../panel-items.ts";
import { buildSettingsListTheme } from "../panel-theme.ts";

export interface ExportScreenDeps {
  log: WorkLog;
  /**
   * Write an export file (name, content) under the kankaku dir and return
   * its absolute path — the same dep `/kankaku export` uses. When absent,
   * `Write file` reports the exact message the subcommand gives today
   * ("export is not configured").
   */
  writeExportFile?: (name: string, content: string) => string;
  ctx: ExtensionContext;
  pinReport: (report: KankakuReportData) => void;
}

type ExportFormat = "csv" | "json";
type ExportRange = "today" | "all";

const FORMAT_VALUES: ExportFormat[] = ["csv", "json"];
const RANGE_VALUES: ExportRange[] = ["today", "all"];
const MAX_VISIBLE = 4;
const EXPORT_NOT_CONFIGURED = "export is not configured";

class ExportScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: ExportScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  private format: ExportFormat = "csv";
  private range: ExportRange = "today";
  private lastNote = "nothing written yet";
  private list: SettingsList;

  constructor(deps: ExportScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.list = this.buildList();
  }

  private buildList(): SettingsList {
    const items: SettingItem[] = [
      { id: "format", label: "Format", currentValue: this.format, values: FORMAT_VALUES },
      { id: "range", label: "Range", currentValue: this.range, values: RANGE_VALUES },
      actionItem(this.settingsTheme, {
        id: "write",
        label: "Write file",
        run: () => {
          if (!this.deps.writeExportFile) {
            throw new Error(EXPORT_NOT_CONFIGURED);
          }
          const { name, content } = buildExportContent(this.deps.log.readAll(), { format: this.format, all: this.range === "all" });
          const path = this.deps.writeExportFile(name, content);
          this.lastNote = `wrote ${path}`;
          return [this.lastNote];
        },
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.host.requestRender(),
      }),
      actionItem(this.settingsTheme, {
        id: "pin",
        label: "Pin to chat",
        run: () => {
          this.deps.pinReport({ title: "export", lines: [this.lastNote] });
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
    if (id === "format") this.format = value as ExportFormat;
    else if (id === "range") this.range = value as ExportRange;

    this.list = this.buildList();
    this.list.selectItem(id);
    this.host.requestRender();
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

/** `openKankakuPanel`'s `screens.export` factory; see {@link ExportScreenDeps}. */
export function createExportScreen(deps: ExportScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new ExportScreenComponent(deps, host);
}
