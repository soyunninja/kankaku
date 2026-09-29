---
description: Link this session to a hub task (list open tasks, pick one, or clear the link)
argument-hint: [number | id | text | clear]
allowed-tools: Bash(node:*)
---

Run the kankaku CLI task command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" task $ARGUMENTS

If no argument was given and the output lists tasks, ask the user which one
they want (by number), then run the same CLI command with that number and show
its output verbatim in a code block. Never pick a task on the user's behalf.
