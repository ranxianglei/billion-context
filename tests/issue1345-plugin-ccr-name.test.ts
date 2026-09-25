import test from "node:test";
import assert from "node:assert/strict";
import { setLogCapture } from "../src/logger.ts";
import { advertisedRetrieveToolName, normalizePluginCcrName, retrieveToolName, storeEffectiveCcr } from "../src/store.ts";
import { warnCcrToolNameOverrides } from "../src/config.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { defaultConfig } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { ProviderRoutes } from "../src/config.ts";

/**
 * #1345: the plugin manifest advertises the BASE-config ccr.toolName while
 * execution gated on the session-effective (deepest-wins) name. A
 * provider/model-level toolName override left the plugin host registering one
 * name while the runtime dispatched another — model calls rejected as unknown
 * tools with CCR reporting enabled.
 *
 * Fix contract: plugin mode normalizes the session stamp to the advertised
 * (base) name and warns (once per session at runtime, once per load at
 * config load); proxy mode keeps the per-route rename untouched.
 */

function freshSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

test("normalizePluginCcrName: divergent override is normalized to the advertised name, warned once", () => {
    const session = freshSession("n1");
    const logs: string[] = [];
    const log = (_l: string, m: string) => logs.push(m);
    const resolved = { enabled: true, toolName: "retrieve_original", minToolTokens: 500 };

    const normalized = normalizePluginCcrName(resolved, undefined, session, log);
    assert.equal(normalized.toolName, "acp_retrieve", "falls back to the kernel default as advertised");
    assert.equal(normalized.minToolTokens, 500, "sub-fields ride along untouched");
    assert.equal(logs.length, 1, "warned once");
    assert.match(logs[0]!, /plugin mode: ignoring provider\/model ccr\.toolName "retrieve_original"/);
    assert.match(logs[0]!, /manifest advertises "acp_retrieve"/);

    // Second request on the same session: still normalized, no repeat warn.
    const again = normalizePluginCcrName(resolved, undefined, session, log);
    assert.equal(again.toolName, "acp_retrieve");
    assert.equal(logs.length, 1, "warn flag sticky per session");
});

test("normalizePluginCcrName: matching name (explicit or default) passes through untouched", () => {
    const session = freshSession("n2");
    const logs: string[] = [];
    const log = (_l: string, m: string) => logs.push(m);

    const same = { enabled: true, toolName: "get_context" };
    const out = normalizePluginCcrName(same, { enabled: true, toolName: "get_context" }, session, log);
    assert.equal(out, same, "identical reference — nothing to do");
    assert.equal(logs.length, 0);

    // No override anywhere: undefined resolves to the same default on both
    // sides — no warn, no copy.
    const noOverride = { enabled: true };
    const out2 = normalizePluginCcrName(noOverride, { enabled: true }, session, log);
    assert.equal(out2, noOverride);
    assert.equal(logs.length, 0);
});

test("stamped session dispatches under the advertised name end-to-end", () => {
    const session = freshSession("n3");
    const logs: string[] = [];
    const resolved = { enabled: true, toolName: "retrieve_original" };
    storeEffectiveCcr(session, normalizePluginCcrName(resolved, { enabled: true, toolName: "acp_retrieve" }, session, (_l, m) => logs.push(m)));
    // The manifest, the gate, and the placeholder hint all read the same name.
    assert.equal(retrieveToolName(session), advertisedRetrieveToolName({ enabled: true, toolName: "acp_retrieve" }));
    assert.equal(retrieveToolName(session), "acp_retrieve");
});

test("manifest advertises the base name even when a provider override exists", () => {
    const routes: ProviderRoutes = {
        "https://example.com": {
            compress: { ccr: { enabled: true, toolName: "retrieve_original" } },
            models: { "some-model": { compress: { ccr: { toolName: "get_context" } } } },
        },
    };
    const baseConfig = applyCompressSettings(defaultConfig(100000), 100000, { ccr: { enabled: true } });

    let manifest = "";
    const res = {
        writeHead: () => {},
        end: (body: string) => {
            manifest = body;
        },
    } as unknown as import("node:http").ServerResponse;
    handlePluginManifest(res, baseConfig);
    const parsed = JSON.parse(manifest) as { toolNames: string[] };
    assert.ok(parsed.toolNames.includes("acp_retrieve"), "base-config name advertised");
    assert.ok(!parsed.toolNames.includes("retrieve_original"), "override never reaches the manifest");

    // Config load surfaces the half-applied override at load time.
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    try {
        warnCcrToolNameOverrides(routes, { enabled: true });
        assert.equal(captured.length, 2, "provider + model overrides both named");
        assert.match(captured[0]!, /providers\["https:\/\/example\.com"\]\.compress\.ccr\.toolName="retrieve_original"/);
        assert.match(captured[0]!, /base name "acp_retrieve"/);
        assert.match(captured[1]!, /models\["some-model"\]\.compress\.ccr\.toolName="get_context"/);
        // Matching names stay silent.
        captured.length = 0;
        warnCcrToolNameOverrides({ "https://ok.example": { compress: { ccr: { toolName: "acp_retrieve" } } } }, { enabled: true });
        assert.equal(captured.length, 0);
    } finally {
        setLogCapture(null);
    }
});
