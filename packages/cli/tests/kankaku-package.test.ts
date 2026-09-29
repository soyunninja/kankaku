import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANKAKU_PI_SPEC,
  classifyKankakuSource,
  entrySource,
  isKankakuPackage,
  loadedKankakuSources,
  pickKankakuSourceToKeep,
  reconcileKankakuEntries,
  withoutKankakuEntries,
} from "../src/domain/kankaku-package.ts";

test("classifyKankakuSource: recognises every documented source form", () => {
  const cases: [string, string | undefined][] = [
    ["npm:kankaku-pi", "npm-pi"],
    ["npm:kankaku-pi@^1.0.0", "npm-pi"],
    ["npm:kankaku", "npm"],
    ["npm:kankaku@0.12.1", "npm"],
    ["git:github.com/soyunninja/kankaku", "git"],
    ["git:github.com/soyunninja/kankaku@v1.0.0", "git"],
    ["git:https://github.com/soyunninja/kankaku.git@main", "git"],
    ["https://github.com/soyunninja/kankaku", "git"],
    ["https://github.com/soyunninja/kankaku.git", "git"],
    ["git@github.com:soyunninja/kankaku.git", "git"],
    ["/Users/me/dev/kankaku", "local"],
    ["../../workspace/kankaku", "local"],
    ["~/dev/kankaku/", "local"],
    ["/Users/me/dev/kankaku/packages/pi", "local"],
    ["/Users/me/dev/kankaku/packages/kankaku", "local"],
    ["npm:kankaku-pi-extras", undefined],
    ["npm:other", undefined],
    ["npm:@scope/kankaku", undefined],
    ["git:github.com/someone/kankaku", undefined],
    ["https://github.com/someone/else", undefined],
    ["/Users/me/dev/pi", undefined],
    ["/Users/me/dev/kankaku-hub", undefined],
  ];
  for (const [source, kind] of cases) assert.equal(classifyKankakuSource(source), kind, source);
  assert.equal(isKankakuPackage("npm:kankaku-pi"), true);
  assert.equal(isKankakuPackage("npm:pi-lens"), false);
});

test("entrySource: reads a string entry and the source of an object-form entry, nothing else", () => {
  assert.equal(entrySource("npm:kankaku"), "npm:kankaku");
  assert.equal(entrySource({ source: "npm:kankaku-pi", extensions: [] }), "npm:kankaku-pi");
  assert.equal(entrySource({ extensions: [] }), undefined);
  assert.equal(entrySource({ source: 3 }), undefined);
  assert.equal(entrySource(null), undefined);
  assert.equal(entrySource(["npm:kankaku"]), undefined);
});

test("loadedKankakuSources: one source per distinct package identity, in order; a versioned duplicate of the same package is not a second load", () => {
  assert.deepEqual(loadedKankakuSources(["npm:pi-lens", "npm:kankaku", "npm:kankaku-pi"]), ["npm:kankaku", "npm:kankaku-pi"]);
  assert.deepEqual(loadedKankakuSources(["npm:kankaku-pi", "npm:kankaku-pi@1.0.0"]), ["npm:kankaku-pi"]);
  assert.deepEqual(loadedKankakuSources(["git:github.com/soyunninja/kankaku", "https://github.com/soyunninja/kankaku.git@v1"]), ["git:github.com/soyunninja/kankaku"]);
  assert.deepEqual(loadedKankakuSources(["npm:pi-lens"]), []);
});

test("pickKankakuSourceToKeep: local path > npm:kankaku-pi > git > npm:kankaku", () => {
  const local = "/dev/kankaku";
  const pi = "npm:kankaku-pi";
  const git = "git:github.com/soyunninja/kankaku";
  const npm = "npm:kankaku";
  assert.equal(pickKankakuSourceToKeep([npm, git, pi, local]), local);
  assert.equal(pickKankakuSourceToKeep([npm, git, pi]), pi);
  assert.equal(pickKankakuSourceToKeep([npm, git]), git);
  assert.equal(pickKankakuSourceToKeep([npm]), npm);
  assert.equal(pickKankakuSourceToKeep(["npm:pi-lens"]), undefined);
});

test("reconcileKankakuEntries: appends npm:kankaku-pi when nothing is recognised", () => {
  assert.deepEqual(reconcileKankakuEntries(["npm:pi-lens"]), ["npm:pi-lens", KANKAKU_PI_SPEC]);
  assert.deepEqual(reconcileKankakuEntries([]), [KANKAKU_PI_SPEC]);
});

test("reconcileKankakuEntries: leaves a single recognised source (npm:kankaku included) alone", () => {
  assert.equal(reconcileKankakuEntries(["npm:pi-lens", "npm:kankaku"]), undefined);
  assert.equal(reconcileKankakuEntries([{ source: "npm:kankaku", extensions: [] }]), undefined);
});

test("reconcileKankakuEntries: with several loads keeps exactly one by precedence and touches nothing else", () => {
  const filtered = { source: "npm:kankaku-pi", extensions: ["!x"] };
  assert.deepEqual(reconcileKankakuEntries(["npm:pi-lens", "npm:kankaku", filtered, { theme: 1 }, 7]), ["npm:pi-lens", filtered, { theme: 1 }, 7]);
  assert.deepEqual(reconcileKankakuEntries(["npm:kankaku", "npm:kankaku-pi", "/dev/kankaku"]), ["/dev/kankaku"]);
  assert.deepEqual(reconcileKankakuEntries(["npm:kankaku", "git:github.com/soyunninja/kankaku"]), ["git:github.com/soyunninja/kankaku"]);
});

test("withoutKankakuEntries: drops every recognised entry, string or object form", () => {
  const other = { source: "npm:pi-lens", skills: [] };
  assert.deepEqual(withoutKankakuEntries(["npm:kankaku", { source: "/dev/kankaku" }, other, "npm:kankaku-pi@1"]), [other]);
});
