import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { LazyJsonlWorkLog } from "./adapters/lazy-jsonl-work-log.ts";
import { createPiTracker } from "./adapters/pi-tracker.ts";

export default function kankaku(pi: ExtensionAPI): void {
  const config = loadConfig();
  const role = detectRole();

  const tracker = new WorkTracker({
    clock: { now: () => Date.now() },
    interactiveTools: config.interactiveTools,
    subagentTool: config.subagentTool,
    segmentRules: config.segmentRules,
  });

  const log = new LazyJsonlWorkLog(config.dir);

  createPiTracker(pi, {
    tracker,
    log,
    role,
    pid: process.pid,
    parentPid: process.ppid,
  });
}
