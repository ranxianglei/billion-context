// #3936/#3937: tsup.config.ts aliases @earendil-works/pi-coding-agent to
// src/agent/pi-host-stub.ts for every entry that inlines
// billion-context-pi-subagents; that package's config-dir module
// (pi-subagents/src/config-dir.ts) namespace-imports the aliased package and
// reads CONFIG_DIR_NAME from it. The stub must keep providing that export:
// reverting it to `export {}` resurrects esbuild's import-is-undefined build
// warning, which does not fail the build — this pins the export so the
// regression is caught by CI instead of surfacing as silent log noise. The
// value must stay pi's canonical ".pi" (== pi-subagents' own fallback
// literal), so the bundled result never depends on which side supplies it.
import test from "node:test";
import assert from "node:assert/strict";
import * as piHostStub from "../src/agent/pi-host-stub.ts";

test("pi-host-stub provides the CONFIG_DIR_NAME export the inlined pi-subagents reads", () => {
    assert.equal(piHostStub.CONFIG_DIR_NAME, ".pi");
});
