import type { SegmentRule } from "./domain/segment-rule.ts";

export interface KankakuConfig {
  /** Directory for the work log, relative to the project cwd unless absolute. */
  dir: string;
  /** Tool names whose execution span counts as waiting time. */
  interactiveTools: string[];
  /** Tool name used to run subagents. */
  subagentTool: string;
  /** Rules that tag a tool execution's span under a named segment (e.g. `review`). */
  segmentRules: SegmentRule[];
  /** Default billing client for this project, from `KANKAKU_CLIENT`. See `domain/client-label.ts`. */
  client?: string;
}

const DEFAULT_DIR = ".kankaku";
const DEFAULT_INTERACTIVE_TOOLS = ["ask_user_question", "ask_user_choice"];
const SUBAGENT_TOOL = "subagent_run";

/**
 * Default segment rule: with gentle-ai, the review-with-receipts step runs
 * as `gentle-ai review ...` commands through the `bash` tool, so tag that
 * span `review`.
 */
const DEFAULT_SEGMENT_RULES: SegmentRule[] = [{ tag: "review", tool: "bash", pattern: /\bgentle-ai review\b/ }];

/** Tags allowed for a segment rule: letters, digits, `_` and `-`, 1-32 chars. */
const SAFE_TAG = /^[A-Za-z0-9_-]{1,32}$/;
/** Property names that behave specially on a plain object; never usable as a tag. */
const RESERVED_TAGS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeTag(tag: string): boolean {
  return SAFE_TAG.test(tag) && !RESERVED_TAGS.has(tag);
}

/**
 * Parse `KANKAKU_SEGMENTS`, a `;`-separated list of `tag=tool:regex`
 * entries (example: `review=bash:gentle-ai review;commit=bash:git commit`).
 * Malformed entries (missing tag, tool or regex, an invalid regex source,
 * or a tag that is not a safe identifier such as `__proto__`) are skipped
 * rather than failing the whole variable.
 */
function parseSegmentRules(raw: string): SegmentRule[] {
  const rules: SegmentRule[] = [];

  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const tag = trimmed.slice(0, eqIndex).trim();
    const rest = trimmed.slice(eqIndex + 1);
    const colonIndex = rest.indexOf(":");
    if (colonIndex <= 0) continue;

    const tool = rest.slice(0, colonIndex).trim();
    const regexSource = rest.slice(colonIndex + 1).trim();
    if (!tag || !tool || !regexSource || !isSafeTag(tag)) continue;

    try {
      rules.push({ tag, tool, pattern: new RegExp(regexSource) });
    } catch {
      continue;
    }
  }

  return rules;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KankakuConfig {
  const dir = env["KANKAKU_DIR"]?.trim() || DEFAULT_DIR;
  const interactiveToolsRaw = env["KANKAKU_INTERACTIVE_TOOLS"]?.trim();
  const interactiveTools = interactiveToolsRaw
    ? interactiveToolsRaw
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
    : DEFAULT_INTERACTIVE_TOOLS;

  const segmentsRaw = env["KANKAKU_SEGMENTS"]?.trim();
  const segmentRules = segmentsRaw ? parseSegmentRules(segmentsRaw) : DEFAULT_SEGMENT_RULES;

  const client = env["KANKAKU_CLIENT"]?.trim() || undefined;

  return {
    dir,
    interactiveTools,
    subagentTool: SUBAGENT_TOOL,
    segmentRules,
    ...(client !== undefined ? { client } : {}),
  };
}

export function detectRole(env: NodeJS.ProcessEnv = process.env): "orchestrator" | "subagent" {
  return env["GENTLE_PI_AGENTS_CHILD"] === "1" ? "subagent" : "orchestrator";
}
