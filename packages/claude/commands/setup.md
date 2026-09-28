---
description: Print the statusLine snippet to add to ~/.claude/settings.json so kankaku can read per-prompt cost
allowed-tools: Bash(node:*)
---

Run the kankaku CLI setup command and show its output to the user verbatim.
Then tell the user, briefly: paste the printed `statusLine` block into their
`~/.claude/settings.json` (merging it if that file already has other keys),
because a Claude Code plugin cannot set `statusLine` for itself — the
statusline is the only documented source of per-session cost.

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" setup
