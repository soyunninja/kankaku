import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createReadlinePrompter } from "../src/adapters/setup/readline-prompter.ts";

function makeStreams(): { input: PassThrough; output: PassThrough; chunks: string[] } {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(String(chunk)));
  return { input, output, chunks };
}

test("confirm: an empty answer returns the default (true)", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.confirm("Install in pi?", true);
  input.write("\n");
  assert.equal(await promise, true);
});

test("confirm: an empty answer returns the default (false)", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.confirm("Refresh the catalog now?", false);
  input.write("\n");
  assert.equal(await promise, false);
});

test("confirm: 'n'/'no' overrides a true default; 'y'/'yes' overrides a false default; case-insensitive", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);

  const p1 = prompter.confirm("q", true);
  input.write("N\n");
  assert.equal(await p1, false);

  const p2 = prompter.confirm("q", false);
  input.write("Yes\n");
  assert.equal(await p2, true);
});

test("confirm: writes the question with the default marked to output", async () => {
  const { input, output, chunks } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.confirm("Install in pi?", true);
  input.write("\n");
  await promise;
  const written = chunks.join("");
  assert.match(written, /Install in pi\?/);
  assert.match(written, /Y\/n/i);
});

test("text: an empty answer returns the default", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.text("Roots?", "/workspace");
  input.write("\n");
  assert.equal(await promise, "/workspace");
});

test("text: a non-empty answer overrides the default", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.text("Roots?", "/workspace");
  input.write("/other/path\n");
  assert.equal(await promise, "/other/path");
});

test("secret: returns the typed value", async () => {
  const { input, output } = makeStreams();
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.secret("Password?");
  input.write("hunter2\n");
  assert.equal(await promise, "hunter2");
});

test("secret: never writes the typed characters to output, even when output looks like a TTY", async () => {
  const { input, output, chunks } = makeStreams();
  (output as unknown as { isTTY: boolean }).isTTY = true;
  const prompter = createReadlinePrompter(input, output);
  const promise = prompter.secret("Password?");
  input.write("h");
  input.write("u");
  input.write("n");
  input.write("ter2\n");
  await promise;
  const written = chunks.join("");
  assert.doesNotMatch(written, /hunter2/);
  assert.match(written, /Password\?/);
});
