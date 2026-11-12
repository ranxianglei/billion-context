import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLaneDecisions, surfaceOffDetail } from "../src/server/lane-decisions.ts";
import { biliToolsDeclaredOnWire, declaredToolEntries } from "../src/session-self-heal.ts";

// #5527 (DSH pi-ai codex path): Codex-shaped hosts declare the model-visible
// bili tools in `input[].type==="additional_tools"` preamble items and send NO
// top-level `tools` array. Both reachability consumers (#3417 discipline:
// observeDeclaredTools in lane-decisions + biliToolsDeclaredOnWire feeding the
// session-self-heal zombie signal) read only the top level, so the request was
// read as "no tools at all": surface=off(no-tools), nudge ARMED-SUPPRESSED
// forever while the model could in fact call compress (issue log:
// pendingT1=62364/50000). Fix: declaredToolEntries is the single collector for
// every wire declaration location; both consumers share it. This file pins the
// unit surface that the matrix rows (real chain, responses wire) complement:
//   - positive: compress inside additional_tools reads reachable (issue shape);
//   - negative: a preamble exposing only acp_status keeps the surface OFF
//     (named-tool precision — the protection the reporter asked to retain);
//   - negative: non-responses protocols do not scan input[] (wire-specific);
//   - controls: top-level declarations unchanged; omnibus names (#3600/#3884)
//     work from the preamble too.

process.env.NODE_ENV = "test";

const root = mkdtempSync(join(tmpdir(), "bili-5527-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

// Exact entry shape from the issue report (Responses dialect, flat name).
const responsesTool = (name: string) => ({ type: "function", name, description: "d", parameters: { type: "object", properties: {} } });

/** Issue shape: no top-level tools, one additional_tools preamble item carrying the declarations. */
function additionalToolsBody(toolNames: string[]) {
    return {
        model: "gpt-6.1-sol",
        input: [
            { type: "additional_tools", role: "developer", tools: toolNames.map(responsesTool) },
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
        max_output_tokens: 1024,
        stream: false,
    };
}

function decide(parsed: unknown, protocol: "anthropic" | "openai" | "google" | "responses" = "responses") {
    return resolveLaneDecisions({ protocol, pluginMode: true, pluginAgent: "dsh", parsed, shouldInject: true, pluginHeaderPresent: true });
}

test("unit: compress declared in additional_tools reads reachable (#5527 issue shape)", () => {
    const got = decide(additionalToolsBody(["compress", "acp_status"]));
    assert.deepEqual([...got.observed.declaredTools].sort(), ["acp_status", "compress"]);
    assert.equal(got.toolsReachable.compress, true);
    assert.equal(got.compressSurfaceOn, true);
    assert.equal(got.mcpDialect, false, "bare-name declaration must not flip the MCP dialect note");
});

test("unit: acp_status-only additional_tools keeps the surface OFF (precision retained)", () => {
    const got = decide(additionalToolsBody(["acp_status"]));
    assert.deepEqual([...got.observed.declaredTools], ["acp_status"]);
    assert.equal(got.toolsReachable.compress, false);
    assert.equal(got.compressSurfaceOn, false);
    assert.equal(surfaceOffDetail(got, true), "surface=off(top-level=[acp_status])");
});

test("unit: omnibus names inside additional_tools stay reachable (#3600/#3884 family via preamble)", () => {
    assert.equal(decide(additionalToolsBody(["run_code"])).compressSurfaceOn, true);
    assert.equal(decide(additionalToolsBody(["code_run"])).compressSurfaceOn, true);
    // Hostile single regular tool inside the preamble stays a true negative.
    assert.equal(decide(additionalToolsBody(["get_weather"])).compressSurfaceOn, false);
});

test("unit: non-responses protocols do not scan input[] (location is wire-specific)", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }], input: [{ type: "additional_tools", role: "developer", tools: [responsesTool("compress")] }] };
    assert.equal(decide(body, "openai").compressSurfaceOn, false);
    assert.equal(decide(body, "anthropic").compressSurfaceOn, false);
    assert.equal(decide(body, "google").compressSurfaceOn, false);
});

test("unit: top-level declarations unchanged (control)", () => {
    const top = { model: "m", input: [{ role: "user", content: [] }], tools: [responsesTool("compress")] };
    assert.equal(decide(top).compressSurfaceOn, true);
    assert.equal(biliToolsDeclaredOnWire(top, "responses", "compress"), true);
});

test("unit: mixed locations union (top-level + preamble)", () => {
    const body = { ...additionalToolsBody(["acp_status"]), tools: [responsesTool("compress")] };
    const got = decide(body);
    assert.deepEqual([...got.observed.declaredTools].sort(), ["acp_status", "compress"]);
    assert.equal(got.compressSurfaceOn, true);
});

test("unit: biliToolsDeclaredOnWire reads the preamble (self-heal zombie signal, #2155 path)", () => {
    assert.equal(biliToolsDeclaredOnWire(additionalToolsBody(["compress"]), "responses", "compress"), true, "named compress in the preamble counts as live-lane evidence");
    assert.equal(biliToolsDeclaredOnWire(additionalToolsBody(["acp_status"]), "responses", "compress"), false, "named precision holds through the preamble");
    assert.equal(biliToolsDeclaredOnWire(additionalToolsBody(["mcp__bili__compress"]), "responses"), true, "legacy any-bili form counts the MCP dialect");
    assert.equal(biliToolsDeclaredOnWire(additionalToolsBody(["get_weather"]), "responses"), false);
});

test("unit: declaredToolEntries collector shapes", () => {
    assert.deepEqual(declaredToolEntries(null, "responses"), []);
    assert.deepEqual(declaredToolEntries("not-an-object", "responses"), []);
    assert.deepEqual(declaredToolEntries({}, "responses"), []);
    // All three per-entry dialects survive collection verbatim; non-object
    // entries and preamble items without a tools array are skipped.
    const mixed = {
        tools: [{ name: "flat" }, { function: { name: "fn" } }, { functionDeclarations: [{ name: "decl" }] }, null, 42],
        input: [
            { type: "additional_tools", role: "developer", tools: [{ name: "preamble" }] },
            { type: "additional_tools" },
            { role: "user", content: [] },
            null,
        ],
    };
    const entries = declaredToolEntries(mixed, "responses");
    assert.equal(entries.length, 4, "three valid top-level objects + one valid preamble item");
    assert.deepEqual(entries.map((e) => e["name"]).filter((n) => typeof n === "string"), ["flat", "preamble"]);
    // Protocol gate: the same body on another wire exposes only its top level.
    assert.equal(declaredToolEntries(mixed, "openai").length, 3);
});
