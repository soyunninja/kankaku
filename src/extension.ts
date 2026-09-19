import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectRole, loadConfig, loadMachine } from "./config.ts";
import { WorkTracker } from "./domain/work-tracker.ts";
import { LazyJsonlWorkLog } from "./adapters/lazy-jsonl-work-log.ts";
import { LazyFileInflightStore } from "./adapters/lazy-file-inflight-store.ts";
import { createPiTracker } from "./adapters/pi-tracker.ts";
import { LazyProjectClientSource, LazyProjectTargetSource } from "./adapters/project-config.ts";
import { LazyExportWriter } from "./adapters/export-writer.ts";
import { resolveHubCredentials } from "./adapters/hub-credentials.ts";
import { PocketBaseClient } from "./adapters/pocketbase-client.ts";
import { createPocketBaseCatalogFetcher } from "./adapters/pocketbase-catalog.ts";
import { CachedCatalog } from "./adapters/cached-catalog.ts";
import { createSessionTarget } from "./adapters/session-target.ts";
import type { Catalog } from "./ports/catalog.ts";
import type { SessionTarget } from "./adapters/session-target.ts";

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

  // Hub (PocketBase) wiring: entirely optional. When unconfigured, every
  // variable below stays undefined and createPiTracker's behaviour is
  // exactly as it is without this feature. See README "Hub (PocketBase)".
  let catalog: Catalog | undefined;
  let sessionTarget: SessionTarget | undefined;
  let machine: string | undefined;
  let hubConfigError: string | undefined;

  const hub = resolveHubCredentials({ env: process.env, homeDir: homedir() });
  hubConfigError = hub.invalidReason;

  if (hub.credentials) {
    const client = new PocketBaseClient({ url: hub.credentials.url, email: hub.credentials.email, password: hub.credentials.password });
    catalog = new CachedCatalog({
      // Machine-wide cache: several projects on the same machine share one
      // catalog fetch, and it survives across projects.
      filePath: join(homedir(), ".kankaku", "catalog.json"),
      url: hub.credentials.url,
      clock: { now: () => Date.now() },
      fetchCatalog: createPocketBaseCatalogFetcher(client),
    });

    const projectTarget = new LazyProjectTargetSource(config.dir);
    sessionTarget = createSessionTarget({
      role,
      catalog,
      resolveProjectConfigIds: () => projectTarget.read(),
      persistProjectConfig: (ids) => projectTarget.write(ids),
    });

    machine = loadMachine(process.env, () => hostname());
  }

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
    ...(sessionTarget !== undefined ? { sessionTarget } : {}),
    ...(catalog !== undefined ? { catalog } : {}),
    ...(machine !== undefined ? { machine } : {}),
    ...(hubConfigError !== undefined ? { hubConfigError } : {}),
  });
}
