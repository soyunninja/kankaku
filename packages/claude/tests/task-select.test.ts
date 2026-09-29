import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubTask } from "kankaku-pi/domain";
import { listOpenTasks, isOpenTask, selectTask } from "../src/task-select.ts";

const T = (id: string, title: string, projectId = "p1", status: HubTask["status"] = "open", externalRef?: string): HubTask =>
  ({ id, title, projectId, status, ...(externalRef ? { externalRef } : {}) });

const TASKS: HubTask[] = [
  T("t3", "Zeta report"),
  T("t1", "Alpha login fix"),
  T("t2", "Beta login page", "p1", "doing"),
  T("t4", "Gamma done", "p1", "done"),
  T("x1", "Other project login", "p2"),
];

test("isOpenTask: open and doing are open, done is not (pi's rule: status !== done)", () => {
  assert.equal(isOpenTask(T("a", "a", "p", "open")), true);
  assert.equal(isOpenTask(T("a", "a", "p", "doing")), true);
  assert.equal(isOpenTask(T("a", "a", "p", "done")), false);
});

test("listOpenTasks keeps only this project's open tasks, sorted by title", () => {
  assert.deepEqual(listOpenTasks(TASKS, "p1").map((t) => t.id), ["t1", "t2", "t3"]);
  assert.deepEqual(listOpenTasks(TASKS, "p2").map((t) => t.id), ["x1"]);
  assert.deepEqual(listOpenTasks([], "p1"), []);
});

const open = listOpenTasks(TASKS, "p1");
const seen = ["t1", "t2", "t3"];
const pick = (arg: string, lastList: string[] = seen) => selectTask(arg, { open, lastList });

test("a number picks from the last list shown", () => {
  assert.deepEqual(pick("1"), { kind: "picked", task: open[0] });
  assert.deepEqual(pick("3"), { kind: "picked", task: open[2] });
  // the list the user saw, not the current sort order
  assert.deepEqual(pick("1", ["t3", "t1"]), { kind: "picked", task: open[2] });
});

test("numbers out of range, zero and negative are rejected", () => {
  for (const arg of ["0", "4", "-1", "-0", "99"]) {
    const r = pick(arg);
    assert.equal(r.kind, "unknown", arg);
  }
});

test("a number with no list shown yet asks for the list first", () => {
  const r = pick("1", []);
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /list/);
});

test("a listed task that is no longer open is reported, not silently swapped", () => {
  const r = pick("1", ["gone", "t2"]);
  assert.equal(r.kind, "unknown");
  assert.match((r as { message: string }).message, /no longer open/);
});

test("a purely numeric argument is always a list number, even if a task id looks numeric", () => {
  const numericId = [T("12345", "Numeric id task"), T("a1", "Other")];
  const list = listOpenTasks(numericId, "p1");
  const r = selectTask("12345", { open: list, lastList: list.map((t) => t.id) });
  assert.equal(r.kind, "unknown");
  assert.deepEqual(selectTask("2", { open: list, lastList: list.map((t) => t.id) }), { kind: "picked", task: list[1] });
});

test("a hub id picks the task, but only within the project's open tasks", () => {
  assert.deepEqual(pick("t2"), { kind: "picked", task: open[1] });
  assert.equal(pick("t4").kind, "unknown"); // done
  assert.equal(pick("x1").kind, "unknown"); // another project
});

test("text picks on a unique case-insensitive title substring", () => {
  assert.deepEqual(pick("ZETA"), { kind: "picked", task: open[2] });
  assert.deepEqual(pick("  page "), { kind: "picked", task: open[1] });
});

test("ambiguous text lists the candidates and picks nothing", () => {
  const r = pick("login");
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual((r as { candidates: HubTask[] }).candidates.map((t) => t.id), ["t1", "t2"]);
});

test("text never matches another project's or a done task", () => {
  assert.equal(pick("Other project").kind, "unknown");
  assert.equal(pick("Gamma").kind, "unknown");
});

test("empty and whitespace-only arguments are unknown, an id beats a title that contains it", () => {
  assert.equal(pick("   ").kind, "unknown");
  const tricky = [T("t1", "First"), T("t9", "t1 in the title")];
  const list = listOpenTasks(tricky, "p1");
  assert.deepEqual(selectTask("t1", { open: list, lastList: [] }), { kind: "picked", task: list[0] });
});
