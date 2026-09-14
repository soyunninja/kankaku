import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { LazyJsonlWorkLog } from "./adapters/lazy-jsonl-work-log.ts";
import { LazyFileInflightStore } from "./adapters/lazy-file-inflight-store.ts";
import { createPiTracker } from "./adapters/pi-tracker.ts";
import { LazyProjectClientSource } from "./adapters/project-config.ts";
import { LazyExportWriter } from "./adapters/export-writer.ts";

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
  const inflight = new LazyFileInflightStore(config.dir, process.pid);

  const projectClient = new LazyProjectClientSource(config.dir);
  const exportWriter = new LazyExportWriter(config.dir);

  createPiTracker(pi, {
    tracker,
    log,
    inflight,
    role,
    pid: process.pid,
    parentPid: process.ppid,
    ...(config.client !== undefined ? { envClient: config.client } : {}),
    resolveProjectClient: () => projectClient.read(),
    writeExportFile: (name, content) => exportWriter.write(name, content),
  });
}
