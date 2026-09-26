---
description: Request a full sync of local kankaku work records to the hub
allowed-tools: Bash(node:*)
---

Run the kankaku CLI sync all command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" sync all
