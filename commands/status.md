---
description: Show the current kankaku session states tracked for this project (pid liveness, open prompt, last cost)
---

Run the kankaku CLI status command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" status
