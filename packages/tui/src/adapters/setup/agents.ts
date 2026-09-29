/**
 * Reads the real per-agent settings/config files under `homeDir` into the
 * plain facts `domain/setup-plan.ts#detectAgents` expects. Never throws: a
 * missing or malformed file reads as absent, exactly like
 * `adapters/tui-config.ts#readTuiConfig` and kankaku's own
 * `hub-credentials.ts#readCredentialsFile`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDetectionFacts, ClaudeSettingsFacts, ConfigFileFacts, SettingsPackagesFacts } from "../../domain/setup-plan.ts";
import { ourCommandFileRoot, ourHookCommandMatch } from "../../domain/claude-integration.ts";
import type { CommandMatch } from "../../domain/claude-integration.ts";
import { commandsDirectory } from "./claude-commands.ts";

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readSettingsPackages(settingsPath: string): SettingsPackagesFacts | undefined {
  const parsed = readJsonObject(settingsPath);
  if (!parsed) return undefined;
  const packages = isStringArray(parsed["packages"]) ? parsed["packages"] : [];
  return { settingsPath, packages };
}

/** Scans every event's hook entries for a command that is one of kankaku's own (see `domain/claude-integration.ts#ourHookCommandMatch`), returning the first match (root + whether it's the legacy `/src/hook.ts` form), or `undefined` when none is found. */
function extractHooksMatch(parsed: Record<string, unknown>): CommandMatch | undefined {
  const hooks = parsed["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const innerHooks = (entry as Record<string, unknown>)["hooks"];
      if (!Array.isArray(innerHooks)) continue;
      for (const hook of innerHooks) {
        if (!hook || typeof hook !== "object") continue;
        const command = (hook as Record<string, unknown>)["command"];
        if (typeof command !== "string") continue;
        const match = ourHookCommandMatch(command);
        if (match !== undefined) return match;
      }
    }
  }
  return undefined;
}

/** The root(s) our generated command files under `homeDir` point at, distinct and sorted, joined by `", "`; `undefined` when there are none. */
function readCommandsRoot(homeDir: string): string | undefined {
  const dir = commandsDirectory(homeDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const roots = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const root = ourCommandFileRoot(readFileSync(join(dir, entry), "utf8"));
      if (root !== undefined) roots.add(root);
    } catch {
      // unreadable entry: not ours
    }
  }
  return roots.size === 0 ? undefined : [...roots].sort().join(", ");
}

function readClaudeSettings(settingsPath: string, homeDir: string): ClaudeSettingsFacts | undefined {
  const parsed = readJsonObject(settingsPath);
  if (!parsed) return undefined;
  const statusLine = parsed["statusLine"];
  const command =
    statusLine && typeof statusLine === "object" && !Array.isArray(statusLine) && typeof (statusLine as Record<string, unknown>)["command"] === "string"
      ? ((statusLine as Record<string, unknown>)["command"] as string)
      : undefined;
  const hooksMatch = extractHooksMatch(parsed);
  return {
    settingsPath,
    statusLineCommand: command,
    hooksRoot: hooksMatch?.root,
    hooksLegacy: hooksMatch?.legacy ?? false,
    commandsRoot: readCommandsRoot(homeDir),
  };
}

function readConfigFilePresence(configPath: string): ConfigFileFacts | undefined {
  return existsSync(configPath) ? { configPath } : undefined;
}

/** Read every agent's settings/config file under `homeDir`, tolerating any absence or malformed content. */
export function readAgentFacts(homeDir: string): AgentDetectionFacts {
  return {
    pi: readSettingsPackages(join(homeDir, ".pi", "agent", "settings.json")),
    gentleShell: readSettingsPackages(join(homeDir, ".gentle-shell", "agent", "settings.json")),
    claudeCode: readClaudeSettings(join(homeDir, ".claude", "settings.json"), homeDir),
    codex: readConfigFilePresence(join(homeDir, ".codex", "config.toml")),
    opencode: readConfigFilePresence(join(homeDir, ".config", "opencode", "opencode.json")),
  };
}
