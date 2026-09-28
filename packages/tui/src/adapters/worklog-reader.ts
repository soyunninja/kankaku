import { join } from "node:path";
import { JsonlWorkLog } from "kankaku/hub";
import type { WorkRecord } from "kankaku/domain";
import type { ProjectRef } from "../ports/project-source.ts";

/**
 * Read every {@link WorkRecord} appended under `<project.dir>/.kankaku`,
 * via kankaku's own `JsonlWorkLog` (which reads `<dir>/worklog.jsonl`).
 */
export function readProjectRecords(project: ProjectRef): WorkRecord[] {
  return new JsonlWorkLog(join(project.dir, ".kankaku")).readAll();
}
