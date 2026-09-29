/**
 * Writer for a pi-family settings file (`~/.pi/agent/settings.json`,
 * `~/.gentle-shell/agent/settings.json` — same shape, shared here): adds
 * `"npm:kankaku-pi"` to `packages` when no kankaku source is there, repairs
 * a file that lists kankaku through more than one source (it would load the
 * extension, and double every measurement) down to exactly one, and leaves
 * every other key, entry and their order untouched. An entry is either a
 * string or pi's object form `{ "source": "...", "extensions": [...] }`;
 * which sources count, and which one survives a repair, is decided in
 * `domain/kankaku-package.ts`.
 */
import { reconcileKankakuEntries, withoutKankakuEntries } from "../../domain/kankaku-package.ts";
import { backupOnce, readJsonObjectOrEmpty, writeJsonAtomic } from "./json-writer.ts";

export interface PackagesWriteResult {
  changed: boolean;
}

function packagesOf(settings: Record<string, unknown>): unknown[] {
  const packages = settings["packages"];
  return Array.isArray(packages) ? packages : [];
}

export function addKankakuPackage(settingsPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const next = reconcileKankakuEntries(packagesOf(existing));
  if (next === undefined) return { changed: false };

  backupOnce(settingsPath);
  writeJsonAtomic(settingsPath, { ...existing, packages: next });
  return { changed: true };
}

/**
 * Removes every `packages` entry that names kankaku, in either form,
 * leaving every other entry and key untouched. A no-op, with no backup and
 * no write, when none is present.
 */
export function removeKankakuPackage(settingsPath: string): PackagesWriteResult {
  const existing = readJsonObjectOrEmpty(settingsPath);
  const packages = packagesOf(existing);
  const filtered = withoutKankakuEntries(packages);

  if (filtered.length === packages.length) return { changed: false };

  backupOnce(settingsPath);
  writeJsonAtomic(settingsPath, { ...existing, packages: filtered });
  return { changed: true };
}
