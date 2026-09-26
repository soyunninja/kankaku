import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { runCli } from "./cli-core.ts";
import { isAlive } from "./claude-pid.ts";

// src/cli.ts -> src -> repo root (the directory that contains .claude-plugin/).
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const result = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  now: () => Date.now(),
  isAlive,
  pluginRoot,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
