import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Client, Project, WorkTarget } from "../domain/work-target.ts";

const SKIP_OPTION = "— skip —";
const NO_PROJECT_OPTION = "(no project)";

export interface PickerCatalog {
  clients: Client[];
  projects: Project[];
}

export type PickResult = { kind: "picked"; target: WorkTarget } | { kind: "skipped" };

interface LabeledOption<T> {
  label: string;
  item: T;
}

/**
 * Build `label -> item` options, sorted by name. When two items share the
 * same name, disambiguate every colliding label by appending ` (code)` so
 * every option maps back to exactly one id.
 */
function labelOptions<T extends { name: string; code?: string }>(items: T[]): LabeledOption<T>[] {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const nameCounts = new Map<string, number>();
  for (const item of sorted) {
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  }

  return sorted.map((item) => {
    const collides = (nameCounts.get(item.name) ?? 0) > 1;
    const label = collides && item.code ? `${item.name} (${item.code})` : item.name;
    return { label, item };
  });
}

/**
 * Run the client/project picker (`ctx.ui.select`) against an already-loaded
 * catalog snapshot. Pure UI interaction: no network, no persistence — the
 * caller (`session-target.ts`) decides what to do with the result.
 *
 * Declining at either step — choosing "— skip —" or dismissing the dialog
 * (`undefined`) — cancels the whole pick, not just that step.
 */
export async function pickTarget(ctx: ExtensionContext, catalog: PickerCatalog): Promise<PickResult> {
  const pickableClients = catalog.clients.filter((client) => client.active && !client.unassigned);
  const clientOptions = labelOptions(pickableClients);

  const clientChoice = await ctx.ui.select("kankaku — client", [...clientOptions.map((option) => option.label), SKIP_OPTION]);
  if (clientChoice === undefined || clientChoice === SKIP_OPTION) return { kind: "skipped" };

  const client = clientOptions.find((option) => option.label === clientChoice)?.item;
  if (!client) return { kind: "skipped" };

  const pickableProjects = catalog.projects.filter((project) => project.active && project.clientId === client.id);
  const projectOptions = labelOptions(pickableProjects);

  const projectChoice = await ctx.ui.select("kankaku — project", [
    ...projectOptions.map((option) => option.label),
    NO_PROJECT_OPTION,
    SKIP_OPTION,
  ]);
  if (projectChoice === undefined || projectChoice === SKIP_OPTION) return { kind: "skipped" };

  const project = projectChoice === NO_PROJECT_OPTION ? undefined : projectOptions.find((option) => option.label === projectChoice)?.item;

  const target: WorkTarget = {
    clientId: client.id,
    clientCode: client.code,
    clientName: client.name,
    ...(project !== undefined
      ? {
          projectId: project.id,
          ...(project.code !== undefined ? { projectCode: project.code } : {}),
          projectName: project.name,
        }
      : {}),
  };

  return { kind: "picked", target };
}
