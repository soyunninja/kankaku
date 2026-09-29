/**
 * `node:readline/promises`-backed `Prompter`. `secret()` hides typed input
 * by routing readline's own echo through a `Writable` that swallows bytes
 * while muted — readline only echoes per keystroke when it treats the
 * output as a terminal (`terminal: true`, the default when `output.isTTY`
 * is set), which is exactly the case that needs hiding; a piped/non-tty
 * output (as in tests) never echoes per keystroke in the first place, so
 * muting there is a no-op rather than a behaviour change.
 */
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { Prompter } from "../../ports/prompter.ts";

function createMutableOutput(realOutput: NodeJS.WritableStream): { stream: NodeJS.WritableStream; setMuted: (muted: boolean) => void } {
  let muted = false;
  const stream = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) realOutput.write(chunk, encoding as BufferEncoding);
      callback();
    },
  });
  // Mirror `isTTY` so readline's terminal-mode autodetection (based on
  // `output.isTTY`) behaves the same as it would against `realOutput`.
  (stream as unknown as { isTTY?: boolean }).isTTY = (realOutput as unknown as { isTTY?: boolean }).isTTY;
  return { stream, setMuted: (value: boolean) => (muted = value) };
}

export function createReadlinePrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  return {
    async confirm(question, defaultValue) {
      const rl = readline.createInterface({ input, output });
      try {
        const suffix = defaultValue ? "[Y/n]" : "[y/N]";
        const raw = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
        if (raw === "") return defaultValue;
        return raw === "y" || raw === "yes";
      } finally {
        rl.close();
      }
    },

    async text(question, defaultValue) {
      const rl = readline.createInterface({ input, output });
      try {
        const raw = (await rl.question(`${question} (${defaultValue}) `)).trim();
        return raw === "" ? defaultValue : raw;
      } finally {
        rl.close();
      }
    },

    async secret(question) {
      const mutable = createMutableOutput(output);
      const rl = readline.createInterface({ input, output: mutable.stream });
      try {
        mutable.setMuted(false);
        output.write(`${question} `);
        mutable.setMuted(true);
        const answer = await rl.question("");
        return answer;
      } finally {
        mutable.setMuted(false);
        output.write("\n");
        rl.close();
      }
    },
  };
}
