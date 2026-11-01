// #5460(P2): perf fixture determinism + bench report math + CLI wiring.
// The end-to-end harness boot (real proxy child + fake upstream) is gated
// behind ACP_TEST_BENCH=1 and needs a built dist (npm run build first) —
// same convention as the other e2e lanes (tests/e2e/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFixture, renderAnthropicBody, renderOpenaiBody, type FixtureMessage } from "../src/perf-fixture.js";
import { computeStats, BENCH_SCENARIOS } from "../src/bench.js";
import { parseArgs } from "../src/cli.js";

const fixtureJson = (spec: { seed: number; msgs: number; shape: "openai" | "anthropic" }) => JSON.stringify(generateFixture(spec));

test("fixture: deterministic — same seed yields identical bytes", () => {
    const a = fixtureJson({ seed: 42, msgs: 64, shape: "openai" });
    const b = fixtureJson({ seed: 42, msgs: 64, shape: "openai" });
    assert.equal(a, b);
});

test("fixture: different seeds diverge", () => {
    const a = fixtureJson({ seed: 42, msgs: 64, shape: "openai" });
    const b = fixtureJson({ seed: 43, msgs: 64, shape: "openai" });
    assert.notEqual(a, b);
});

test("fixture: content carries compression sentinels and doc refs", () => {
    const fx = generateFixture({ seed: 7, msgs: 128, shape: "anthropic" });
    assert.equal(fx.count, 128);
    assert.ok(fx.bytes > 0);
    let sentinelSeen = false;
    let docSeen = false;
    for (const m of fx.messages) {
        if (/sentinel value:\s*\d+/.test(m.content)) sentinelSeen = true;
        if (/doc#\d+/.test(m.content)) docSeen = true;
    }
    assert.ok(sentinelSeen, "at least one sentinel line");
    assert.ok(docSeen, "at least one doc# ref");
});

test("fixture: S-large size matches the #5403 shape (~80 MiB)", () => {
    const fx = generateFixture({ seed: 1, msgs: 20_000, shape: "openai" });
    const mb = fx.bytes / (1024 * 1024);
    assert.ok(mb > 40 && mb < 160, `S-large should land near 80 MiB, got ${mb.toFixed(1)} MiB`);
});

test("fixture: renders both wires deterministically from the same history", () => {
    const fx = generateFixture({ seed: 9, msgs: 12, shape: "openai" });
    const prefix = fx.messages.slice(0, 5);
    const o1 = renderOpenaiBody("m", prefix);
    const o2 = renderOpenaiBody("m", prefix);
    assert.deepEqual(o1, o2);
    assert.equal(o1.model, "m");
    assert.equal(o1.stream, true);
    assert.deepEqual(o1.messages, prefix);
    const a1 = renderAnthropicBody("m", prefix);
    assert.equal(a1.max_tokens, 1024);
    assert.deepEqual(a1.messages, prefix);
});

test("computeStats: nearest-rank percentiles", () => {
    assert.equal(computeStats([]), null);
    assert.deepEqual(computeStats([7]), { min: 7, p50: 7, p95: 7, max: 7, mean: 7 });
    const s = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
    assert.equal(s.min, 1);
    assert.equal(s.max, 10);
    assert.equal(s.p50, 5);
    assert.equal(s.p95, 10);
    assert.equal(s.mean, 5.5);
});

test("scenarios: catalog is well-formed and covers the P2 matrix axes", () => {
    const ids = BENCH_SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes("smoke-openai-tiny"));
    assert.ok(BENCH_SCENARIOS.some((s) => s.shape === "anthropic"));
    assert.ok(BENCH_SCENARIOS.some((s) => s.window !== undefined));
    assert.ok(BENCH_SCENARIOS.some((s) => s.tier === "nightly" && s.msgs === 20_000));
    for (const s of BENCH_SCENARIOS) {
        assert.ok(s.msgs >= 1, `${s.id}: msgs`);
        assert.match(s.id, /^[a-z0-9-]+$/);
    }
});

test("cli: bench flags parse", () => {
    const p = parseArgs(["bench", "proxy-append-openai-s-med", "--rounds", "3", "--out", "x.json"]);
    assert.equal(p.command, "bench");
    assert.equal(p.benchScenario, "proxy-append-openai-s-med");
    assert.equal(p.benchRounds, 3);
    assert.equal(p.outFile, "x.json");
    const list = parseArgs(["bench"]);
    assert.equal(list.command, "bench");
    assert.equal(list.benchScenario, undefined);
});

test("cli: fixture-gen flags parse", () => {
    const p = parseArgs(["fixture-gen", "--seed", "42", "--msgs", "50", "--shape", "anthropic", "--out", "f.json"]);
    assert.equal(p.command, "fixture-gen");
    assert.equal(p.fixtureSeed, 42);
    assert.equal(p.fixtureMsgs, 50);
    assert.equal(p.fixtureShape, "anthropic");
    assert.equal(p.outFile, "f.json");
});

test("bench: end-to-end hermetic run (smoke scenario)", { timeout: 180_000 }, async (t) => {
    if (!process.env.ACP_TEST_BENCH) {
        t.skip("set ACP_TEST_BENCH=1 (and npm run build first) to run the hermetic harness");
        return;
    }
    const { runBench } = await import("../src/bench.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bench-test-"));
    try {
        const { artifact } = await runBench({ scenarioId: "smoke-openai-tiny", workdirRoot: dir, log: () => { /* quiet */ } });
        assert.equal(artifact.schema_version, 1);
        assert.equal(artifact.scenario.id, "smoke-openai-tiny");
        assert.equal(artifact.env.storage_mode, "full");
        assert.equal(artifact.runs.length, 1);
        const run = artifact.runs[0]!;
        assert.equal(run.rounds_run, 8);
        assert.equal(run.rounds_failed, 0);
        assert.ok(run.metrics.req_rows >= 8, `expected >=8 req rows, got ${run.metrics.req_rows}`);
        assert.ok(run.metrics.total_ms !== null, "total_ms stats present");
        assert.ok(run.metrics.inbound_bytes !== null && run.metrics.inbound_bytes.total > 0);
        assert.ok(run.metrics.mem_hwm === null || run.metrics.mem_hwm.rss_bytes > 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
