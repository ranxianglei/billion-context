import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BILI_COMPACTION_DISABLE_SERVICE, compactionDisablePatchRows, declareDshCompactionActive, detectCompactionOverlayGap, disableBasicCompaction, registerCompactionDisable, _resetDshCompactionVerdictForTest } from "../src/agent/dsh-compaction-disable.ts";
import { writeDshAcpPatch } from "../src/launcher.ts";

// #3354: the vendored dsh basic-compaction disable overlay (deshark42/
// dsh-compaction-basic-disable, MIT) — pure-function behavior, registration
// degradation, and the two patch carriers' agreement on the preset gate rows.
// The apply-level wiring is covered in tests/dsh-native.test.ts.

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRESET_ROWS = compactionDisablePatchRows();
// #3662: both carriers must mount the always-on gate entry alongside
// bili-native — without it the preset inject rows pend forever whenever
// bili-native does not run. #4627: the two carriers now target different-but-
// equivalent gate packages (bundle subpath vs own bare package), so they can
// no longer share one byte-exact constant.
const BUNDLE_GATE_INSERT = `- insert:\n    - id: bili-native\n      name: billion-context\n    - id: bili-compaction-gate\n      name: billion-context/dsh-gate\n`;
const LAUNCHER_BARE_GATE_INSERT = `- insert:\n    - id: bili-native\n      name: billion-context\n    - id: bili-compaction-gate\n      name: billion-context-dsh-gate\n`;

test("#3354 disableBasicCompaction: marks both compaction rows at any depth", () => {
    const rows = [
        { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
        { name: "@deepseek-ai/dsh-command-compact" },
        { name: "@deepseek-ai/dsh-other" },
        {
            id: "compaction",
            name: "cordis:group",
            group: true,
            config: [
                { name: "@deepseek-ai/dsh-compaction-basic" },
                { name: "@deepseek-ai/dsh-command-compact" },
                { group: true, config: [{ name: "@deepseek-ai/dsh-compaction-basic" }] },
            ],
        },
    ];
    const out = disableBasicCompaction(rows) as Array<Record<string, unknown>>;
    assert.equal(out[0].disabled, true);
    assert.equal(out[1].disabled, true);
    assert.equal(out[2].disabled, undefined);
    const group = out[3] as Record<string, unknown>;
    assert.equal(group.group, true);
    const inner = group.config as Array<Record<string, unknown>>;
    assert.equal(inner[0].disabled, true);
    assert.equal(inner[1].disabled, true);
    assert.equal((inner[2].config as Array<Record<string, unknown>>)[0].disabled, true);
});

test("#3354 disableBasicCompaction: pure — input untouched, output detached", () => {
    const row: Record<string, unknown> = { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } };
    const group = { group: true, config: [{ name: "@deepseek-ai/dsh-command-compact" }] };
    const input = [row, group];
    const snapshot = JSON.stringify(input);
    const out = disableBasicCompaction(input) as Array<Record<string, unknown>>;
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(out, input);
    assert.notEqual(out[0], row);
    assert.notEqual(out[1], group);
    assert.deepEqual((out[0] as Record<string, unknown>).config, { auto: true });
    // mutating the output must not leak back into the input
    (out[0] as Record<string, unknown>).x = 1;
    assert.equal(row.x, undefined);
});

test("#3354 disableBasicCompaction: degenerate inputs pass through", () => {
    assert.deepEqual(disableBasicCompaction([]), []);
    const mixed: unknown[] = [null, 42, "s", { name: "other" }, { group: true, config: { not: "an array" } }];
    const out = disableBasicCompaction(mixed) as Array<unknown>;
    assert.deepEqual(out, mixed);
    // an already-disabled row stays disabled (idempotent overlay)
    const done = disableBasicCompaction([{ name: "@deepseek-ai/dsh-compaction-basic", disabled: true }]) as Array<Record<string, unknown>>;
    assert.equal(done[0].disabled, true);
});

test("#3354 registerCompactionDisable: degrades per layer without throwing", () => {
    // no host surface at all — pre-hook builds / stripped hosts
    registerCompactionDisable({});
    // registry only, no event bus
    const provided: string[] = [];
    registerCompactionDisable({ reflect: { provide: (name) => provided.push(name) } });
    assert.deepEqual(provided, [BILI_COMPACTION_DISABLE_SERVICE]);
    // bus only, no registry — the middleware still registers
    let seen: unknown[] = [];
    registerCompactionDisable({ on: (_event, listener) => { seen.push(listener); } });
    assert.equal(seen.length, 1);
});

test("#3806 detectCompactionOverlayGap: latched when both capabilities are present", () => {
    assert.equal(detectCompactionOverlayGap({ on: () => {}, reflect: { provide: () => {} } }), null);
});

test("#3806 detectCompactionOverlayGap: missing internal/config hook -> no-config-hook", () => {
    assert.equal(detectCompactionOverlayGap({ reflect: { provide: () => {} } }), "no-config-hook");
    assert.equal(detectCompactionOverlayGap({}), "no-config-hook");
});

test("#3806 detectCompactionOverlayGap: missing service provide -> no-service-provide", () => {
    assert.equal(detectCompactionOverlayGap({ on: () => {} }), "no-service-provide");
});

test("#3354 registerCompactionDisable: transform honors the entry predicate and preserves siblings", () => {
    type Mw = (raw: unknown, next: () => unknown) => unknown;
    let mw: Mw | undefined;
    let options: unknown;
    // #3662: the transform acts only while bili-native declared the lane owned.
    _resetDshCompactionVerdictForTest();
    declareDshCompactionActive();
    try {
        registerCompactionDisable({
            on: (_event, listener, opts) => { mw = listener as Mw; options = opts; },
            reflect: {},
        });
        assert.equal(typeof mw, "function");
        assert.deepEqual(options, { global: true });
        const plugins = [
            { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
            { name: "@deepseek-ai/dsh-command-compact" },
            { name: "@deepseek-ai/dsh-tool-result-pruner" },
        ];
        const cfg: Record<string, unknown> = { plugins, isolate: { compaction: true } };
        const self = { entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } };
        const out = mw?.call(self, null, () => cfg) as { plugins?: Array<Record<string, unknown>>; isolate?: Record<string, unknown> };
        assert.deepEqual(out.isolate, { compaction: true });
        assert.equal(out.plugins?.[0]?.disabled, true);
        assert.equal(out.plugins?.[1]?.disabled, true);
        assert.equal(out.plugins?.[2]?.disabled, undefined);
        // #4147: the match is STRUCTURAL — a non-agent-preset entry nesting
        // compaction rows is rewritten too (custom presets), while an entry
        // whose plugins carry none keeps its resolved config object identity.
        const custom: Record<string, unknown> = { plugins: [{ name: "@deepseek-ai/dsh-compaction-basic" }] };
        const customOut = mw?.call({ entry: { options: { name: "preset-general" } } }, null, () => custom) as { plugins?: Array<Record<string, unknown>> };
        assert.equal(customOut.plugins?.[0]?.disabled, true);
        const untouched: Record<string, unknown> = { plugins: [{ name: "@deepseek-ai/dsh-other" }] };
        assert.equal(mw?.call({ entry: { options: { name: "other-entry" } } }, null, () => untouched), untouched);
        assert.equal(mw?.call(undefined, null, () => untouched), untouched);
        // next() returning nothing → verbatim passthrough
        assert.equal(mw?.call(self, null, () => undefined), undefined);
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#3354 patch carriers agree: root bundle yml and launcher overlay carry the identical preset gate rows", () => {
    // #2631: normalize CRLF checkouts before the byte-exact includes
    const bundle = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
    for (const id of ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]) {
        const row = `- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`;
        assert.ok(bundle.includes(row), `bundle yml must carry the ${id} gate row`);
    }
    assert.ok(bundle.includes(PRESET_ROWS), "bundle yml must carry the gate rows contiguously");
    assert.ok(bundle.includes(BUNDLE_GATE_INSERT), "bundle yml must mount the always-on gate entry (#3662)");

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cd-patch-"));
    try {
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "overlay patch must be written");
        const overlay = fs.readFileSync(file!, "utf8").replaceAll("\r\n", "\n");
        assert.ok(overlay.includes(PRESET_ROWS), "launcher overlay must carry the same gate rows");
        assert.ok(overlay.includes(LAUNCHER_BARE_GATE_INSERT), "launcher overlay must mount the same gate entry (#3662)");
        // the overlay still stands down the host plane and keeps the #2605 retries
        assert.ok(overlay.includes("- id: compaction-basic\n  config:\n    auto: false\n"));
        assert.match(overlay, /retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});
