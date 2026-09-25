/**
 * Pure model for the `/kankaku` panel (see odd/tasks/kankaku-panel.md): the
 * set of screens, the root menu, an immutable navigation stack, the
 * title/footer-hint text every adapter screen renders from, and pure row
 * builders (e.g. {@link buildTargetRows}) that turn kankaku state into row
 * models for a screen's `SettingsList`. No I/O, no pi imports — see
 * AGENTS.md "Architecture (hexagonal)".
 */

import type { WorkTarget } from "./work-target.ts";

export type PanelScreenId = "root" | "target" | "report" | "sync" | "export" | "doctor" | "about";

/** One row of the root menu (`rootMenu`): a section the panel can navigate to. */
export interface PanelMenuItem {
  id: PanelScreenId;
  label: string;
  description: string;
  /** Offered only when the hub (PocketBase) is configured; see {@link rootMenu}. */
  hubOnly: boolean;
}

const ROOT_MENU_ITEMS: PanelMenuItem[] = [
  // Not hub-only: the legacy billing label (`/kankaku client <name>`) is
  // set from this same screen and works with no hub configured at all.
  { id: "target", label: "Target", description: "Billing client, project, hub task, legacy label", hubOnly: false },
  { id: "report", label: "Report", description: "Today/all totals, tasks, sessions, clients, projects", hubOnly: false },
  { id: "sync", label: "Sync", description: "Status, sync now, sync all, backfill, catalog refresh", hubOnly: true },
  { id: "export", label: "Export", description: "Write today's or every task as csv/json", hubOnly: false },
  { id: "doctor", label: "Doctor", description: "Orphan/uncertain subagent counts, ancestor detection", hubOnly: false },
  { id: "about", label: "About", description: "Versions, KANKAKU_DIR, env-only config", hubOnly: false },
];

/**
 * The root menu's rows, in a fixed order. `hubOnly` rows (only `sync`;
 * `target` is not hub-only — see `ROOT_MENU_ITEMS`'s comment) are omitted
 * entirely when the hub is not configured, so the panel offers exactly what
 * `/kankaku` itself would today.
 */
export function rootMenu(options: { hubConfigured: boolean }): PanelMenuItem[] {
  return ROOT_MENU_ITEMS.filter((item) => options.hubConfigured || !item.hubOnly);
}

/** Immutable navigation stack: `stack[0]` is always `"root"`. */
export interface PanelNav {
  stack: PanelScreenId[];
}

/** A fresh navigation stack, positioned at the root screen. */
export function navRoot(): PanelNav {
  return { stack: ["root"] };
}

/** Push a screen onto the stack, returning a new {@link PanelNav}; the input is never mutated. */
export function navPush(nav: PanelNav, id: PanelScreenId): PanelNav {
  return { stack: [...nav.stack, id] };
}

/**
 * Pop the current screen, returning a new {@link PanelNav} and whether the
 * panel should close. At the root, there is nothing left to pop: the stack
 * is returned unchanged and `closed` is `true` — the caller closes the
 * overlay instead of navigating.
 */
export function navBack(nav: PanelNav): { nav: PanelNav; closed: boolean } {
  if (nav.stack.length <= 1) {
    return { nav, closed: true };
  }
  return { nav: { stack: nav.stack.slice(0, -1) }, closed: false };
}

/** The screen currently on top of the stack. */
export function navCurrent(nav: PanelNav): PanelScreenId {
  return nav.stack[nav.stack.length - 1] ?? "root";
}

const SCREEN_TITLES: Record<Exclude<PanelScreenId, "root">, string> = {
  target: "Target",
  report: "Report",
  sync: "Sync",
  export: "Export",
  doctor: "Doctor",
  about: "About",
};

/** `kankaku` at root, `kankaku · <Screen>` on every other screen. */
export function panelTitle(screen: PanelScreenId): string {
  if (screen === "root") return "kankaku";
  return `kankaku · ${SCREEN_TITLES[screen]}`;
}

/** One clickable/keyboard hint shown in the panel's footer. */
export interface PanelHint {
  key: string;
  label: string;
}

/**
 * The footer hint row for a screen: navigation hints, an optional search
 * hint when the current body supports it, and how Escape/left arrow/`q`
 * behave — back at root closes the panel outright, so root shows only
 * `esc close`; every other screen shows both `esc/← back` and `q close`.
 */
export function footerHints(screen: PanelScreenId, options: { searchable: boolean }): PanelHint[] {
  const hints: PanelHint[] = [{ key: "↑↓", label: "move" }];

  if (screen === "root") {
    hints.push({ key: "enter", label: "open" });
    if (options.searchable) hints.push({ key: "/", label: "search" });
    hints.push({ key: "esc", label: "close" });
    return hints;
  }

  hints.push({ key: "enter", label: "select" });
  if (options.searchable) hints.push({ key: "/", label: "search" });
  hints.push({ key: "esc/←", label: "back" }, { key: "q", label: "close" });
  return hints;
}

/** One row of a `SettingsList`-backed screen (e.g. {@link buildTargetRows}'s output). */
export interface PanelRow {
  id: string;
  label: string;
  value: string;
  description?: string;
}

const NONE_VALUE = "— none —";

/** Pure input for {@link buildTargetRows}. */
export interface TargetRowsInput {
  /** Whether the hub (PocketBase) is configured; see `rootMenu`'s `target` row, which is offered either way. */
  hubConfigured: boolean;
  /** The current effective hub target, if any (`SessionTarget#effectiveTarget()`). */
  target?: WorkTarget;
  /** Which source produced {@link target} (already formatted by the caller as `"session" | "config" | "repoPaths"`), or `undefined` for none. */
  source?: string;
  /** The current effective legacy billing label (`SessionClient#effectiveClient()`), if any. */
  legacyLabel?: string;
  /** Which source produced {@link legacyLabel} (already formatted by the caller), or `undefined` for none. */
  legacySource?: string;
}

/**
 * Build the target screen's rows from kankaku's current billing-target
 * state. Pure: the caller (`adapters/panel/screens/target.ts`) resolves
 * `target`/`source`/`legacyLabel`/`legacySource` from `SessionTarget`/
 * `SessionClient` and formats each source name as a plain string, so this
 * function never depends on their concrete types.
 *
 * `client`/`project`/`task`/`source`/`remember` are included only when
 * {@link TargetRowsInput.hubConfigured} is `true` — the panel's `target`
 * screen is offered either way (see `rootMenu`), but those rows only make
 * sense once a hub exists to resolve them against. `legacy` is always
 * included: the legacy billing label works with no hub at all.
 */
export function buildTargetRows(input: TargetRowsInput): PanelRow[] {
  const rows: PanelRow[] = [];
  const target = input.target;
  const hasClient = target !== undefined;
  const hasProject = target !== undefined && target.projectId !== undefined;

  if (input.hubConfigured) {
    rows.push({
      id: "client",
      label: "Client",
      value: hasClient ? `${target.clientName} (${target.clientCode})` : NONE_VALUE,
    });

    rows.push({
      id: "project",
      label: "Project",
      value: hasProject ? (target.projectName ?? NONE_VALUE) : NONE_VALUE,
      ...(hasClient ? {} : { description: "pick a client first" }),
    });

    rows.push({
      id: "task",
      label: "Task",
      value: hasProject && target.hubTaskTitle !== undefined ? target.hubTaskTitle : NONE_VALUE,
      ...(hasProject ? {} : { description: "pick a project first" }),
    });

    rows.push({
      id: "source",
      label: "Source",
      value: input.source ?? "none",
    });

    rows.push({
      id: "remember",
      label: "Remember",
      value: "save to config.json",
      description: "Saves the client and project (never the linked task) to this repository's .kankaku/config.json.",
    });
  }

  rows.push({
    id: "legacy",
    label: "Legacy label",
    value: input.legacyLabel ?? NONE_VALUE,
    description: `Source: ${input.legacySource ?? "none"}`,
  });

  return rows;
}

/**
 * Pure input for {@link buildAboutRows}. Every env-only value is passed in
 * already extracted from `KankakuConfig` (see `config.ts`) rather than the
 * config object itself: `KankakuConfig` lives outside `src/domain/`, and
 * this module must import nothing but `src/domain/`/`src/ports/` (see
 * AGENTS.md "Architecture (hexagonal)").
 */
export interface AboutRowsInput {
  /** kankaku's own version (`adapters/agent-info.ts#resolvePluginVersion`). */
  pluginVersion?: string;
  /** pi's version (`adapters/agent-info.ts#resolveAgentVersion`). */
  agentVersion?: string;
  /** This session's resolved kankaku directory (`adapters/kankaku-dir.ts#resolveKankakuDir`). */
  kankakuDir: string;
  /** The hub (PocketBase) URL, when configured. */
  hubUrl?: string;
  /** `KankakuConfig.interactiveTools`. */
  interactiveTools: string[];
  /** `KankakuConfig.segmentRules.length`. */
  segmentRuleCount: number;
  /** `KankakuConfig.subagentProfiles`' ids. */
  subagentProfileNames: string[];
  /** `KankakuConfig.client`. */
  client?: string;
}

/**
 * Build the panel's `about` screen rows: versions, the resolved directory,
 * the hub URL, and every env-only setting (`KANKAKU_INTERACTIVE_TOOLS`,
 * `KANKAKU_SEGMENTS`, `KANKAKU_SUBAGENT_TOOLS`/`KANKAKU_SUBAGENT_CHILD_ENV`,
 * `KANKAKU_CLIENT`) with its env var name as the row's description — every
 * row is read-only (see `screens/about.ts`).
 */
export function buildAboutRows(input: AboutRowsInput): PanelRow[] {
  return [
    { id: "kankaku", label: "kankaku", value: input.pluginVersion ?? "unknown" },
    { id: "pi", label: "pi", value: input.agentVersion ?? "unknown" },
    { id: "directory", label: "Directory", value: input.kankakuDir },
    { id: "hub", label: "Hub", value: input.hubUrl ?? "not configured" },
    {
      id: "interactive-tools",
      label: "Interactive tools",
      value: input.interactiveTools.length > 0 ? input.interactiveTools.join(", ") : NONE_VALUE,
      description: "KANKAKU_INTERACTIVE_TOOLS",
    },
    {
      id: "segments",
      label: "Segments",
      value: `${input.segmentRuleCount} rule(s)`,
      description: "KANKAKU_SEGMENTS",
    },
    {
      id: "subagent-profiles",
      label: "Subagent profiles",
      value: input.subagentProfileNames.length > 0 ? input.subagentProfileNames.join(", ") : NONE_VALUE,
      description: "KANKAKU_SUBAGENT_TOOLS / KANKAKU_SUBAGENT_CHILD_ENV",
    },
    { id: "client", label: "Client", value: input.client ?? NONE_VALUE, description: "KANKAKU_CLIENT" },
  ];
}
