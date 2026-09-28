/**
 * Builds pi-tui `SelectListTheme`/`SettingsListTheme` objects from a pi
 * `Theme` instance, mirroring the role mapping pi's own `/settings`
 * (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/
 * theme/theme.js`'s `getSelectListTheme`/`getSettingsListTheme`) uses —
 * so the panel looks and behaves like every other pi list, without
 * depending on pi's internal (non-exported-per-extension) theme singleton.
 */
import type { SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** `SelectListTheme` for the panel's root menu and other select lists. */
export function buildSelectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
  };
}

/** `SettingsListTheme` for screens built on `SettingsList` (e.g. the target screen). */
export function buildSettingsListTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}
