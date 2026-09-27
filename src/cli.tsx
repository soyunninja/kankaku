#!/usr/bin/env node
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { render } from "ink";
import { readTuiConfig } from "./adapters/tui-config.ts";
import { discoverProjects } from "./adapters/project-discovery.ts";
import { readProjectRecords } from "./adapters/worklog-reader.ts";
import { buildTodayRows, formatTodayLines } from "./domain/today-model.ts";
import type { TodayModel } from "./domain/today-model.ts";
import { App } from "./ui/app.tsx";

export interface CliDeps {
  homeDir: string;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  renderApp: (roots: string[]) => void;
}

const USAGE = "usage: kankaku [today] [--roots a,b]\n";

/** Load today's model for `roots`: discover projects, read their worklogs, build rows. */
export function loadToday(roots: string[]): TodayModel {
  const projects = discoverProjects(roots);
  const withRecords = projects.map((project) => ({ name: project.name, records: readProjectRecords(project) }));
  return buildTodayRows(withRecords);
}

function parseRoots(argv: string[], deps: Pick<CliDeps, "homeDir" | "cwd">): { roots: string[]; rest: string[] } {
  const flagIndex = argv.indexOf("--roots");
  if (flagIndex === -1) {
    return { roots: readTuiConfig(deps.homeDir, deps.cwd).roots, rest: argv };
  }
  const value = argv[flagIndex + 1] ?? "";
  const roots = value.split(",").filter((root) => root.length > 0);
  const rest = [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 2)];
  return { roots, rest };
}

/** Parse `argv` and run the requested mode against injected `deps`. No logic beyond argv handling belongs here. */
export function runCli(argv: string[], deps: CliDeps): void {
  const { roots, rest } = parseRoots(argv, deps);
  const [command] = rest;

  if (command === undefined) {
    deps.renderApp(roots);
    return;
  }

  if (command === "today") {
    const model = loadToday(roots);
    deps.stdout(formatTodayLines(model.rows, model.total).join("\n"));
    return;
  }

  deps.stderr(USAGE);
  deps.exit(1);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli(process.argv.slice(2), {
    homeDir: homedir(),
    cwd: process.cwd(),
    stdout: (text) => {
      console.log(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    exit: (code) => {
      process.exit(code);
    },
    renderApp: (roots) => {
      render(<App load={() => loadToday(roots)} roots={roots} />, { alternateScreen: true, exitOnCtrlC: true });
    },
  });
}
