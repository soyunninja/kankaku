---
description: Choose the client and project this session works for (list clients, pick one, or clear)
argument-hint: [number | code | text] [project] | clear
allowed-tools: Bash(node:*)
---

Run the kankaku CLI target command and show its output to the user verbatim,
inside a code block, with no summarizing or reformatting:

!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" target $ARGUMENTS

If the output lists clients or projects, ask the user which one they want,
by number, then run the same CLI command with that number and show its output
verbatim in a code block.

Never pick a client or a project on the user's behalf.

The choice lasts for this session only: it does not change the project's
`config.json`.
