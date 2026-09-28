/**
 * Word-wrap `text` to at most `width` visible characters per line. Explicit
 * `\n` in `text` starts a new wrap group (so a multi-line prompt keeps its
 * own line breaks); a single word longer than `width` is hard-broken into
 * `width`-sized chunks rather than overflowing. `width` below 1 is treated
 * as 1, so this never loops forever or drops characters. Pure and
 * deterministic: used by `ui/tasks-screen.tsx`'s detail panel to know how
 * many lines a long prompt needs before deciding how much of it fits a
 * fixed-height panel (see AGENTS.md-equivalent "the layout must never
 * move" rule in `odd/tasks/`).
 */
export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(Math.floor(width), 1);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of paragraph.split(" ")) {
      if (word.length > safeWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = "";
        }
        let remaining = word;
        while (remaining.length > safeWidth) {
          lines.push(remaining.slice(0, safeWidth));
          remaining = remaining.slice(safeWidth);
        }
        current = remaining;
        continue;
      }

      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (candidate.length > safeWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }

  return lines;
}
