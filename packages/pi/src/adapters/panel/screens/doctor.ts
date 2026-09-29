/**
 * The `/kankaku` panel's `doctor` screen (see odd/tasks/kankaku-panel.md):
 * renders `buildDoctorLines`' output (the exact lines `/kankaku doctor`
 * shows) in a bounded body, with `pin`/`refresh` actions.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import { buildDoctorLines } from "../../kankaku-command.ts";
import type { KankakuCommandDeps, KankakuReportData } from "../../kankaku-command.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { actionItem } from "../panel-items.ts";
import { renderBoundedLines } from "../panel-lines.ts";
import { buildSettingsListTheme } from "../panel-theme.ts";

export interface DoctorScreenDeps {
  commandDeps: KankakuCommandDeps;
  ctx: ExtensionContext;
  pinReport: (report: KankakuReportData) => void;
}

const MAX_VISIBLE = 4;
const MAX_BODY_LINES = 14;

class DoctorScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: DoctorScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  private lines: string[];
  private list: SettingsList;

  constructor(deps: DoctorScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.lines = buildDoctorLines(deps.commandDeps, deps.ctx);
    this.list = this.buildList();
  }

  private buildList(): SettingsList {
    const items = [
      actionItem(this.settingsTheme, {
        id: "pin",
        label: "Pin to chat",
        run: () => {
          this.deps.pinReport({ title: "doctor", lines: this.lines });
          return ["pinned to the chat transcript"];
        },
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.host.requestRender(),
      }),
      actionItem(this.settingsTheme, {
        id: "refresh",
        label: "Refresh",
        run: () => {
          this.lines = buildDoctorLines(this.deps.commandDeps, this.deps.ctx);
          return ["refreshed"];
        },
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.host.requestRender(),
      }),
    ];
    return new SettingsList(items, MAX_VISIBLE, this.settingsTheme, () => {}, () => this.host.back(), { enableSearch: false });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [...this.list.render(width), "", ...renderBoundedLines(this.lines, MAX_BODY_LINES)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse?.(event);
  }
}

/** `openKankakuPanel`'s `screens.doctor` factory; see {@link DoctorScreenDeps}. */
export function createDoctorScreen(deps: DoctorScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new DoctorScreenComponent(deps, host);
}
