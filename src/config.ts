export interface KankakuConfig {
  /** Directory for the work log, relative to the project cwd unless absolute. */
  dir: string;
  /** Tool names whose execution span counts as waiting time. */
  interactiveTools: string[];
  /** Tool name used to run subagents. */
  subagentTool: string;
}

const DEFAULT_DIR = ".kankaku";
const DEFAULT_INTERACTIVE_TOOLS = ["ask_user_question", "ask_user_choice"];
const SUBAGENT_TOOL = "subagent_run";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KankakuConfig {
  const dir = env["KANKAKU_DIR"]?.trim() || DEFAULT_DIR;
  const interactiveToolsRaw = env["KANKAKU_INTERACTIVE_TOOLS"]?.trim();
  const interactiveTools = interactiveToolsRaw
    ? interactiveToolsRaw
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
    : DEFAULT_INTERACTIVE_TOOLS;

  return {
    dir,
    interactiveTools,
    subagentTool: SUBAGENT_TOOL,
  };
}

export function detectRole(env: NodeJS.ProcessEnv = process.env): "orchestrator" | "subagent" {
  return env["GENTLE_PI_AGENTS_CHILD"] === "1" ? "subagent" : "orchestrator";
}
