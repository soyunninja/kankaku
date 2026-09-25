import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Client, HubTask, Project, WorkTarget } from "../domain/work-target.ts";

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

export type PickHubTaskResult = { kind: "picked"; task: HubTask } | { kind: "skipped" } | { kind: "empty" };

/**
 * Build `label -> task` options for {@link pickHubTask}, sorted by title.
 * When two tasks share the same title, disambiguate every colliding label
 * with the task's `externalRef` when it has one, or its bare id otherwise —
 * unlike {@link labelOptions}, a hub task has no `code`, and every task
 * needs a disambiguator, not just the ones lucky enough to have one.
 */
function labelTaskOptions(tasks: HubTask[]): LabeledOption<HubTask>[] {
  const sorted = [...tasks].sort((a, b) => a.title.localeCompare(b.title));
  const titleCounts = new Map<string, number>();
  for (const task of sorted) {
    titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  }

  return sorted.map((task) => {
    const collides = (titleCounts.get(task.title) ?? 0) > 1;
    const label = collides ? `${task.title} (${task.externalRef ?? task.id})` : task.title;
    return { label, item: task };
  });
}

/**
 * Run the hub-task picker (`ctx.ui.select`) for `projectId`'s open/doing
 * tasks. Pure UI interaction: no network, no persistence — the caller
 * (`session-target.ts#pickTask`) decides what to do with the result.
 * `{ kind: "empty" }` is returned without ever prompting when the project
 * has no open/doing task, so the caller can tell "nothing to pick from"
 * apart from "the user skipped".
 */
export async function pickHubTask(ctx: ExtensionContext, tasks: HubTask[], projectId: string): Promise<PickHubTaskResult> {
  const pickable = tasks.filter((task) => task.status !== "done" && task.projectId === projectId);
  if (pickable.length === 0) return { kind: "empty" };

  const taskOptions = labelTaskOptions(pickable);
  const choice = await ctx.ui.select("kankaku — task", [...taskOptions.map((option) => option.label), SKIP_OPTION]);
  if (choice === undefined || choice === SKIP_OPTION) return { kind: "skipped" };

  const task = taskOptions.find((option) => option.label === choice)?.item;
  if (!task) return { kind: "skipped" };

  return { kind: "picked", task };
}
