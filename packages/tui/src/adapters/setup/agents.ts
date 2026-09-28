/**
 * Reads the real per-agent settings/config files under `homeDir` into the
 * plain facts `domain/setup-plan.ts#detectAgents` expects. Never throws: a
 * missing or malformed file reads as absent, exactly like
 * `adapters/tui-config.ts#readTuiConfig` and kankaku's own
 * `hub-credentials.ts#readCredentialsFile`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDetectionFacts, ClaudeSettingsFacts, ConfigFileFacts, SettingsPackagesFacts } from "../../domain/setup-plan.ts";

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

function readClaudeSettings(settingsPath: string): ClaudeSettingsFacts | undefined {
  const parsed = readJsonObject(settingsPath);
  if (!parsed) return undefined;
  const statusLine = parsed["statusLine"];
  const command =
    statusLine && typeof statusLine === "object" && !Array.isArray(statusLine) && typeof (statusLine as Record<string, unknown>)["command"] === "string"
      ? ((statusLine as Record<string, unknown>)["command"] as string)
      : undefined;
  return { settingsPath, statusLineCommand: command };
}

function readConfigFilePresence(configPath: string): ConfigFileFacts | undefined {
  return existsSync(configPath) ? { configPath } : undefined;
}

/** Read every agent's settings/config file under `homeDir`, tolerating any absence or malformed content. */
export function readAgentFacts(homeDir: string): AgentDetectionFacts {
  return {
    pi: readSettingsPackages(join(homeDir, ".pi", "agent", "settings.json")),
    gentleShell: readSettingsPackages(join(homeDir, ".gentle-shell", "agent", "settings.json")),
    claudeCode: readClaudeSettings(join(homeDir, ".claude", "settings.json")),
    codex: readConfigFilePresence(join(homeDir, ".codex", "config.toml")),
    opencode: readConfigFilePresence(join(homeDir, ".config", "opencode", "opencode.json")),
  };
}
