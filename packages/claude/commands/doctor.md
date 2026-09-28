---
description: Show a read-only local kankaku installation and sync diagnostic
allowed-tools: Bash(node:*)
---

Run the kankaku CLI doctor command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" doctor
