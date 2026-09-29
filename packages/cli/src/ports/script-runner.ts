/**
 * Runs external scripts, injected so `adapters/setup/local-hub.ts` can be
 * driven by a real child process (`adapters/setup/child-process-runner.ts`)
 * or a fake in tests. `run` waits for completion (e.g. `pb-download.sh`,
 * `create-dev-accounts.sh`); `spawnDetached` starts a long-running process
 * (`dev.sh`) that outlives the caller, returning immediately with its pid.
 */
export interface ScriptRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScriptRunner {
  run(cmd: string, args: string[], opts: { cwd: string }): Promise<ScriptRunResult>;
  spawnDetached(cmd: string, args: string[], opts: { cwd: string; logFile: string }): { pid: number };
}
