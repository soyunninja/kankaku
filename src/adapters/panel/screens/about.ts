/**
 * The `/kankaku` panel's `about` screen (see odd/tasks/kankaku-panel.md):
 * versions, the resolved `KANKAKU_DIR`, the hub URL, and every env-only
 * setting, all read-only (no `values`, no `submenu`) — `buildAboutRows`
 * (`domain/panel-model.ts`) builds the rows; this stays a thin adapter that
 * maps `KankakuConfig` into that pure input.
 */
import type { Component, SettingItem, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import type { KankakuConfig } from "../../../config.ts";
import { buildAboutRows } from "../../../domain/panel-model.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { buildSettingsListTheme } from "../panel-theme.ts";

export interface AboutScreenDeps {
  config: KankakuConfig;
  kankakuDir: string;
  agentVersion?: string;
  pluginVersion?: string;
  hubUrl?: string;
}

const MAX_VISIBLE = 10;

class AboutScreenComponent implements Component {
  readonly searchable = false;
  private readonly list: SettingsList;

  constructor(deps: AboutScreenDeps, host: PanelHost) {
    const rows = buildAboutRows({
      pluginVersion: deps.pluginVersion,
      agentVersion: deps.agentVersion,
      kankakuDir: deps.kankakuDir,
      hubUrl: deps.hubUrl,
      interactiveTools: deps.config.interactiveTools,
      segmentRuleCount: deps.config.segmentRules.length,
      subagentProfileNames: deps.config.subagentProfiles.map((profile) => profile.id),
      client: deps.config.client,
    });
    const items: SettingItem[] = rows.map((row) => ({
      id: row.id,
      label: row.label,
      currentValue: row.value,
      ...(row.description !== undefined ? { description: row.description } : {}),
    }));
    this.list = new SettingsList(items, MAX_VISIBLE, buildSettingsListTheme(host.theme), () => {}, () => host.back(), { enableSearch: false });
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

/** `openKankakuPanel`'s `screens.about` factory; see {@link AboutScreenDeps}. */
export function createAboutScreen(deps: AboutScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new AboutScreenComponent(deps, host);
}
