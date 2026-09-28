import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { createAboutScreen } from "../src/adapters/panel/screens/about.ts";
import type { KankakuConfig } from "../src/config.ts";
import { BUILTIN_SUBAGENT_PROFILES } from "../src/domain/subagent-profile.ts";
import { ESCAPE, fakeHost } from "./helpers/panel-fakes.ts";

type TestComponent = Component & { handleInput: NonNullable<Component["handleInput"]> };

function makeConfig(overrides: Partial<KankakuConfig> = {}): KankakuConfig {
  return {
    dir: ".kankaku",
    interactiveTools: ["ask_user_question", "ask_user_choice"],
    subagentProfiles: [...BUILTIN_SUBAGENT_PROFILES],
    segmentRules: [],
    rejectedSubagentChildEnvMarkers: [],
    ...overrides,
  };
}

test("renders versions, directory, hub, and env-only settings, all read-only", () => {
  const config = makeConfig({ client: "acme" });
  const factory = createAboutScreen({
    config,
    kankakuDir: "/repo/.kankaku",
    agentVersion: "1.2.3",
    pluginVersion: "0.6.5",
    hubUrl: "https://pb.example.com",
  });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /kankaku\s+0\.6\.5/);
  assert.match(lines, /pi\s+1\.2\.3/);
  assert.match(lines, /\/repo\/\.kankaku/);
  assert.match(lines, /https:\/\/pb\.example\.com/);
  assert.match(lines, /acme/);
});

test("falls back to 'unknown'/'not configured' when versions and the hub are absent", () => {
  const factory = createAboutScreen({ config: makeConfig(), kankakuDir: "/repo/.kankaku" });
  const component = factory(fakeHost()) as TestComponent;

  const lines = component.render(100).join("\n");
  assert.match(lines, /unknown/);
  assert.match(lines, /not configured/);
});

test("escape goes back; there is no submenu or mutation to trigger", () => {
  const factory = createAboutScreen({ config: makeConfig(), kankakuDir: "/repo/.kankaku" });
  const host = fakeHost();
  const component = factory(host) as TestComponent;

  component.handleInput(ESCAPE);
  assert.equal(host.backCalls, 1);
});
