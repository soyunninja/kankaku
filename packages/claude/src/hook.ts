import { handleHook } from "./handle-hook.ts";
import { isAlive, runPsProcess } from "./claude-pid.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const text = await readStdin();
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    process.stderr.write(`kankaku: could not parse hook input: ${String(error)}\n`);
    return;
  }
  await handleHook(input, {
    env: process.env,
    now: () => Date.now(),
    sleep,
    isAlive,
    runPs: runPsProcess,
    stderr: (message) => process.stderr.write(`${message}\n`),
  });
}

main()
  .catch((error) => {
    process.stderr.write(`kankaku: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  })
  .finally(() => {
    process.exit(0);
  });
