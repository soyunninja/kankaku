/**
 * Bounded, scroll-free line rendering shared by the panel's report and
 * doctor screens' body area (see odd/tasks/kankaku-panel.md P3): show at
 * most `maxLines` lines, with a "… N more" footer when the content was
 * truncated. Plain array/string logic, no pi imports, reused by
 * `screens/report.ts` and `screens/doctor.ts`.
 */
export function renderBoundedLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  const shown = lines.slice(0, maxLines);
  const more = lines.length - maxLines;
  return [...shown, `… ${more} more`];
}
