/**
 * The real `ScriptRunner`: `node:child_process` over the given cmd/args.
 * `run` collects stdout/stderr and waits for exit; `spawnDetached` starts a
 * detached, unref'd process whose combined output is appended to `logFile`,
 * for `local-hub.ts#installLocalHub`'s `dev.sh`.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import type { ScriptRunner, ScriptRunResult } from "../../ports/script-runner.ts";

export function createChildProcessRunner(): ScriptRunner {
  return {
    run(cmd, args, opts) {
      return new Promise<ScriptRunResult>((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: opts.cwd });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    },

    spawnDetached(cmd, args, opts) {
      const fd = openSync(opts.logFile, "a");
      const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
      return { pid: child.pid ?? -1 };
    },
  };
}
