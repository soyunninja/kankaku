/**
 * Public library entrypoint (`kankaku/ports`): the port interfaces, with
 * no implementations. See AGENTS.md "Architecture (hexagonal)" and
 * odd/tasks/library-exports.md.
 */
export type * from "./catalog.ts";
export type * from "./clock.ts";
export type * from "./inflight-store.ts";
export type * from "./process-registry.ts";
export type * from "./work-log.ts";
export type * from "./work-sink.ts";
