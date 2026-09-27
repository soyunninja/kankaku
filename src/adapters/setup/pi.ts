/**
 * Writer for a pi-family settings file (`~/.pi/agent/settings.json`,
 * `~/.gentle-shell/agent/settings.json` — same shape, shared here): adds
 * `"npm:kankaku"` to `packages`, leaving every other key and its order
 * untouched. A no-op when kankaku is already present (`npm:kankaku`, a
 * versioned spec, or a local path — see `domain/setup-plan.ts#isKankakuPackage`).
 */
import { isKankakuPackage } from "../../domain/setup-plan.ts";
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

export interface PackagesWriteResult {
  changed: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function addKankakuPackage(settingsPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const packages = isStringArray(existing["packages"]) ? existing["packages"] : [];

  if (packages.some(isKankakuPackage)) return { changed: false };

  backupOnce(settingsPath);
  writeJsonAtomic(settingsPath, { ...existing, packages: [...packages, "npm:kankaku"] });
  return { changed: true };
}
