import type { WorkRecord } from "../domain/work-record.ts";

export interface WorkLog {
  append(record: WorkRecord): void;
  readAll(): WorkRecord[];
}
