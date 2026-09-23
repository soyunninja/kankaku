/**
 * Public library entrypoint (`kankaku/domain`): the pure domain layer, with
 * no I/O and no pi imports. See AGENTS.md "Architecture (hexagonal)" and
 * odd/tasks/library-exports.md.
 */
export * from "./ancestry-match.ts";
export * from "./client-label.ts";
export * from "./day.ts";
export * from "./export.ts";
export * from "./hub-entry.ts";
export * from "./intervals.ts";
export * from "./registry-health.ts";
export * from "./segment-rule.ts";
export * from "./subagent-profile.ts";
export * from "./sync-plan.ts";
export * from "./task-view.ts";
export * from "./work-record.ts";
export * from "./work-target.ts";
export * from "./work-tracker.ts";
