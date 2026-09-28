---
description: Show the current kankaku session states tracked for this project (pid liveness, open prompt, last cost)
allowed-tools: Bash(node:*)
---

Run the kankaku CLI status command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" status
