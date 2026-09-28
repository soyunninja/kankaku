---
description: Show local kankaku hub sync status
allowed-tools: Bash(node:*)
---

Run the kankaku CLI sync status command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" sync status
