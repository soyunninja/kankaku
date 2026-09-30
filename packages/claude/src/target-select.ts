import type { Client, HubTask, Project } from "kankaku-pi/domain";
import type { SessionList } from "./session-target-store.ts";

/**
 * Pure selection logic for `/kankaku:target`. Only active entries are ever
 * selectable, and a client flagged `unassigned` never is. A numeric argument
 * is ALWAYS a number on the last list printed for the session (the same rule
 * as `task-select.ts`), never a code or a name.
 */
export function activeClients(clients: Client[]): Client[] {
  return clients.filter((client) => client.active && client.unassigned !== true).sort(byName);
}

/** The client's active projects, by name (the order the list is numbered in). */
export function activeProjects(projects: Project[], clientId: string): Project[] {
  return projects.filter((project) => project.active && project.clientId === clientId).sort(byName);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

export interface SelectionContext {
  /** Every client and project of the catalog; eligibility is decided here. */
  clients: Client[];
  projects: Project[];
  /** The session's target client, when one was picked. */
  clientId?: string;
  /** The last list printed for this session. */
  lastList: SessionList;
}

export type TargetPick =
  | { kind: "client"; client: Client }
  | { kind: "project"; project: Project }
  | { kind: "ambiguous"; of: "clients"; candidates: Client[] }
  | { kind: "ambiguous"; of: "projects"; candidates: Project[] }
  | { kind: "unknown"; message: string };

export type BothPick =
  | { kind: "both"; client: Client; project: Project }
  | TargetPick;

type Match<T> = { kind: "picked"; item: T } | { kind: "ambiguous"; candidates: T[] } | { kind: "none" };

const NUMBER = /^-?\d+$/;

/** Exact code, else exact name, else a unique case-insensitive name substring; all case-insensitive. */
function match<T extends { name: string; code?: string }>(text: string, entries: T[]): Match<T> {
  const needle = text.toLowerCase();
  const stages = [
    entries.filter((entry) => entry.code?.toLowerCase() === needle),
    entries.filter((entry) => entry.name.toLowerCase() === needle),
    entries.filter((entry) => entry.name.toLowerCase().includes(needle)),
  ];
  for (const found of stages) {
    if (found.length === 1) return { kind: "picked", item: found[0]! };
    if (found.length > 1) return { kind: "ambiguous", candidates: found };
  }
  return { kind: "none" };
}

function usableClient(clients: Client[], id: string): Client | undefined {
  return activeClients(clients).find((client) => client.id === id);
}

function unknown(message: string): { kind: "unknown"; message: string } {
  return { kind: "unknown", message };
}

/** A number on the last list, checked against the kind wanted and against the entries still eligible. */
function byNumber<T extends { id: string }>(n: number, wanted: "clients" | "projects", list: SessionList, eligible: T[]): { item: T } | { message: string } {
  if (list.ids.length === 0) return { message: `no ${wanted.slice(0, -1)} list shown yet in this session; list the ${wanted} first` };
  if (list.kind !== wanted) {
    return { message: `the last list shown was ${list.kind}, not ${wanted}; list the ${wanted} first` };
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > list.ids.length) return { message: `${n} is not on the list (1-${list.ids.length})` };
  const item = eligible.find((entry) => entry.id === list.ids[n - 1]);
  return item ? { item } : { message: `${wanted.slice(0, -1)} ${n} is no longer available; list the ${wanted} again` };
}

function pickClient(text: string, ctx: SelectionContext): TargetPick {
  const clients = activeClients(ctx.clients);
  if (NUMBER.test(text)) {
    const r = byNumber(Number(text), "clients", ctx.lastList, clients);
    return "item" in r ? { kind: "client", client: r.item } : unknown(r.message);
  }
  const m = match(text, clients);
  if (m.kind === "picked") return { kind: "client", client: m.item };
  if (m.kind === "ambiguous") return { kind: "ambiguous", of: "clients", candidates: m.candidates };
  return unknown(`no client matches "${text}"`);
}

/**
 * One argument of `target <arg>`. With a projects list on screen (and the
 * session client still eligible) a number can only mean one of THOSE
 * projects, and text is tried against them first, then against the clients.
 */
export function pickTarget(arg: string, ctx: SelectionContext): TargetPick {
  const text = arg.trim();
  if (text === "") return unknown("no client given");
  const sessionClient = ctx.clientId !== undefined ? usableClient(ctx.clients, ctx.clientId) : undefined;
  if (ctx.lastList.kind !== "projects" || sessionClient === undefined) return pickClient(text, ctx);

  const projects = activeProjects(ctx.projects, sessionClient.id);
  if (NUMBER.test(text)) {
    const r = byNumber(Number(text), "projects", ctx.lastList, projects);
    return "item" in r ? { kind: "project", project: r.item } : unknown(r.message);
  }
  const m = match(text, projects);
  if (m.kind === "picked") return { kind: "project", project: m.item };
  if (m.kind === "ambiguous") return { kind: "ambiguous", of: "projects", candidates: m.candidates };
  const client = pickClient(text, ctx);
  return client.kind === "unknown" ? unknown(`no project of ${sessionClient.name} or client matches "${text}"`) : client;
}

function pickProjectOf(client: Client, text: string, ctx: SelectionContext): BothPick | { kind: "project"; project: Project } {
  if (NUMBER.test(text)) return unknown(`a project is given by code or name here, not by number: "${text}"`);
  const m = match(text, activeProjects(ctx.projects, client.id));
  if (m.kind === "picked") return { kind: "project", project: m.item };
  if (m.kind === "ambiguous") return { kind: "ambiguous", of: "projects", candidates: m.candidates };
  const others = ctx.projects.filter((project) => project.clientId !== client.id && usableClient(ctx.clients, project.clientId));
  const other = match(text, others);
  const owner = other.kind === "picked" ? usableClient(ctx.clients, other.item.clientId) : undefined;
  if (other.kind === "picked" && owner) return unknown(`${other.item.name} belongs to ${owner.name}, not ${client.name}`);
  return unknown(`no project of ${client.name} matches "${text}"`);
}

/**
 * `target <client> <project>`: the arguments are split at every position
 * (a name can hold spaces); exactly one split must yield a client and one
 * of ITS projects. A number can name the client (from the clients list) but
 * never the project.
 */
export function pickBoth(args: string[], ctx: SelectionContext): BothPick {
  if (args.length < 2) return unknown("give a client and a project");
  const successes: { client: Client; project: Project }[] = [];
  let failure: BothPick | undefined;
  let clientFailure: BothPick | undefined;
  for (let i = 1; i < args.length; i++) {
    const client = pickClient(args.slice(0, i).join(" "), ctx);
    if (client.kind !== "client") {
      clientFailure ??= client as BothPick;
      continue;
    }
    const project = pickProjectOf(client.client, args.slice(i).join(" "), ctx);
    if (project.kind === "project") successes.push({ client: client.client, project: project.project });
    else failure ??= project as BothPick;
  }
  if (successes.length === 1) return { kind: "both", ...successes[0]! };
  if (successes.length > 1) return unknown(`"${args.join(" ")}" can be split into a client and a project in more than one way; use the client code`);
  return failure ?? clientFailure ?? unknown("give a client and a project");
}

export interface TaskLinkOutcome {
  keep: boolean;
  message: string;
}

/**
 * The task-link rule for any change of the session target: the link
 * survives only when the linked task belongs to the resulting project.
 * `undefined` when there is no link to decide about.
 */
export function taskLinkOutcome(
  link: { hubTaskId: string; hubTaskTitle?: string } | undefined,
  tasks: HubTask[],
  project: { id: string; name: string } | undefined,
): TaskLinkOutcome | undefined {
  if (link === undefined) return undefined;
  const title = link.hubTaskTitle ?? link.hubTaskId;
  if (project === undefined) return { keep: false, message: `task link dropped (${title} needs a project)` };
  const task = tasks.find((candidate) => candidate.id === link.hubTaskId);
  if (task?.projectId === project.id) return { keep: true, message: "task link kept" };
  return { keep: false, message: `task link dropped (${title} is not in ${project.name})` };
}
