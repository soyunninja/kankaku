import { renderStatusline } from "./statusline-core.ts";
import { readState } from "./session-state.ts";
import { writeCost } from "./cost-store.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    const text = await readStdin();
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  const line = renderStatusline(input, {
    env: process.env,
    now: () => Date.now(),
    readState,
    writeCost,
  });
  process.stdout.write(`${line}\n`);
}

main()
  .catch(() => {
    process.stdout.write("kankaku\n");
  })
  .finally(() => {
    process.exit(0);
  });
