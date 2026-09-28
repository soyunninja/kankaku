---
description: Manually sync local kankaku work records to the hub
allowed-tools: Bash(node:*)
---

Run the kankaku CLI sync command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" sync

For a full sync or local sync status, use the direct CLI instead:
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" sync all` or
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" sync status`.
This slash command runs the default sync only; it does not forward arguments.
