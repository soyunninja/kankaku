import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "commands");

test("every command file has a description, allowed-tools and runs the compiled CLI", () => {
  const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
  assert.ok(files.includes("task.md"));
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.match(text, /^---\ndescription: .+\n(argument-hint: .+\n)?allowed-tools: Bash\(node:\*\)\n---\n/, name);
    assert.ok(text.includes('!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"'), name);
  }
});

test("task.md forwards its arguments, and never picks on the user's behalf", () => {
  const text = readFileSync(join(dir, "task.md"), "utf8");
  assert.match(text, /^argument-hint: \[number \| id \| text \| clear\]$/m);
  assert.ok(text.includes('!node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" task $ARGUMENTS'));
  assert.match(text, /verbatim/);
  assert.match(text, /ask the user which one/);
  assert.match(text, /Never pick a task on the user's behalf/);
});
