/**
 * The `/kankaku` panel's `sync` screen (see odd/tasks/kankaku-panel.md P4):
 * status lines (`hub-actions.ts#buildSyncStatusLines`) plus `Sync now`,
 * `Sync all`, `Backfill` and `Refresh catalog` actions, all sharing the
 * exact line-building the `/kankaku sync`/`backfill`/`catalog refresh`
 * subcommands use (`adapters/hub-actions.ts`), so this screen can never
 * drift from them. `Pin to chat` pins the current status lines, exactly
 * like `/kankaku sync status` already does.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import type { SyncCommandDeps, KankakuReportData } from "../../kankaku-command.ts";
import { buildSyncStatusLines, formatBackfillLines, formatCatalogRefreshLines, formatSyncSummaryLines } from "../../hub-actions.ts";
import type { Catalog } from "../../../ports/catalog.ts";
import type { PanelHost, PanelScreenFactory } from "../kankaku-panel.ts";
import { actionItem } from "../panel-items.ts";
import { renderBoundedLines } from "../panel-lines.ts";
import { buildSettingsListTheme } from "../panel-theme.ts";

export interface SyncScreenDeps {
  sync: SyncCommandDeps;
  /** Present only when the hub is configured; the `Refresh catalog` row is omitted entirely without one. */
  catalog?: Catalog;
  ctx: ExtensionContext;
  refreshIdleStatus: (ctx: ExtensionContext) => void;
  pinReport: (report: KankakuReportData) => void;
}

const MAX_VISIBLE = 5;
const MAX_BODY_LINES = 14;
const STATUS_TITLE = "sync status";

class SyncScreenComponent implements Component {
  readonly searchable = false;
  private readonly deps: SyncScreenDeps;
  private readonly host: PanelHost;
  private readonly settingsTheme: SettingsListTheme;
  private statusLines: string[];
  private list: SettingsList;

  constructor(deps: SyncScreenDeps, host: PanelHost) {
    this.deps = deps;
    this.host = host;
    this.settingsTheme = buildSettingsListTheme(host.theme);
    this.statusLines = buildSyncStatusLines(this.deps.sync.status());
    this.list = this.buildList();
  }

  /** Refreshed after every action, per the feature doc: recompute the status body, refresh the idle status line, and re-render. */
  private refreshStatus(): void {
    this.statusLines = buildSyncStatusLines(this.deps.sync.status());
    this.deps.refreshIdleStatus(this.deps.ctx);
    this.host.requestRender();
  }

  private buildList(): SettingsList {
    const items: SettingItem[] = [
      actionItem(this.settingsTheme, {
        id: "sync-now",
        label: "Sync now",
        run: async () => formatSyncSummaryLines(await this.deps.sync.run({})),
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.refreshStatus(),
      }),
      actionItem(this.settingsTheme, {
        id: "sync-all",
        label: "Sync all",
        run: async () => formatSyncSummaryLines(await this.deps.sync.run({ full: true })),
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.refreshStatus(),
      }),
      actionItem(this.settingsTheme, {
        id: "backfill",
        label: "Backfill",
        run: async () => formatBackfillLines(await this.deps.sync.run({ full: true })),
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.refreshStatus(),
      }),
    ];

    const catalog = this.deps.catalog;
    if (catalog) {
      items.push(
        actionItem(this.settingsTheme, {
          id: "catalog-refresh",
          label: "Refresh catalog",
          run: async () => formatCatalogRefreshLines(await catalog.refresh()),
          onOpen: () => this.host.setBodyCapturesEscape(true),
          onClose: () => this.host.setBodyCapturesEscape(false),
          onDone: () => this.refreshStatus(),
        }),
      );
    }

    items.push(
      actionItem(this.settingsTheme, {
        id: "pin",
        label: "Pin to chat",
        run: () => {
          this.deps.pinReport({ title: STATUS_TITLE, lines: this.statusLines });
          return ["pinned to the chat transcript"];
        },
        onOpen: () => this.host.setBodyCapturesEscape(true),
        onClose: () => this.host.setBodyCapturesEscape(false),
        onDone: () => this.host.requestRender(),
      }),
    );

    return new SettingsList(items, MAX_VISIBLE, this.settingsTheme, () => {}, () => this.host.back(), { enableSearch: false });
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [...this.list.render(width), "", ...renderBoundedLines(this.statusLines, MAX_BODY_LINES)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse?.(event);
  }
}

/** `openKankakuPanel`'s `screens.sync` factory; see {@link SyncScreenDeps}. */
export function createSyncScreen(deps: SyncScreenDeps): PanelScreenFactory {
  return (host: PanelHost) => new SyncScreenComponent(deps, host);
}
