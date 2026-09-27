/**
 * Pi-free home for {@link KankakuReportData}, the shape every `/kankaku`
 * report view and the panel's report screen produce. Extracted out of
 * `kankaku-command.ts` (which still re-exports it) so `report-views.ts` can
 * be published through `kankaku/hub` without pulling in anything that
 * touches `@earendil-works/*` — see AGENTS.md "Code conventions".
 */

/** Durable report rendered inside the chat transcript; never sent to the LLM. */
export interface KankakuReportData {
  title: string;
  lines: string[];
}
