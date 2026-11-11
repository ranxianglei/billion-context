import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

process.env.NODE_ENV = "test";
// Isolate state from the real machine state (same discipline as
// tests/price-profile-stamp.test.ts) and keep the config hermetic — a
// developer's real billion-context.json must not leak billing overrides in.
process.env.XDG_STATE_HOME = `${import.meta.dirname ?? "."}/.billing-state-${process.pid}`;
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-billing-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import {
    billInputUsage,
    billOutputUsage,
    billingOverrides,
    parseBillingSettings,
    resolveBillingPrice,
    savedUsdFromFolds,
    setBillingOverrides,
    stampBillingPrice,
    stampedBillingPrice,
} from "../src/billing.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, listSessions } from "../src/session.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

function resetState(): void {
    setRegistryForTest({});
    setBillingOverrides(undefined);
    _resetPluginStateForTest();
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
}

// ---------------------------------------------------------------------------
// parseBillingSettings — loud-reject discipline (#155): any shape violation
// rejects the whole block; a typo'd price must never silently no-op.
// ---------------------------------------------------------------------------

test("#4899 parseBillingSettings: accepts full, partial, and empty shapes", () => {
    assert.deepEqual(parseBillingSettings(undefined), undefined);
    assert.deepEqual(parseBillingSettings(null), undefined);
    assert.deepEqual(parseBillingSettings({}), { prices: {} });
    assert.deepEqual(parseBillingSettings({ prices: {} }), { prices: {} });
    assert.deepEqual(
        parseBillingSettings({ prices: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } }),
        { prices: { "anthropic/claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } },
    );
    assert.deepEqual(
        parseBillingSettings({ prices: { "openai/gpt-5": { input: 1.25 } } }),
        { prices: { "openai/gpt-5": { input: 1.25 } } },
    );
});

test("#4899 parseBillingSettings: rejects every invalid shape loudly", () => {
    assert.equal(parseBillingSettings([]), undefined, "array root");
    assert.equal(parseBillingSettings("nope"), undefined, "string root");
    assert.equal(parseBillingSettings({ prices: [] }), undefined, "prices array");
    assert.equal(parseBillingSettings({ prices: null }), undefined, "prices null");
    assert.equal(parseBillingSettings({ prices: "x" }), undefined, "prices string");
    assert.equal(parseBillingSettings({ prices: { m: "x" } }), undefined, "entry not object");
    assert.equal(parseBillingSettings({ prices: { m: null } }), undefined, "entry null");
    assert.equal(parseBillingSettings({ prices: { m: { output: 15 } } }), undefined, "input missing");
    assert.equal(parseBillingSettings({ prices: { m: { input: 0 } } }), undefined, "input zero — a price anchored on nothing bills nothing");
    assert.equal(parseBillingSettings({ prices: { m: { input: -3 } } }), undefined, "input negative");
    assert.equal(parseBillingSettings({ prices: { m: { input: 3, output: -1 } } }), undefined, "output negative");
    assert.equal(parseBillingSettings({ prices: { m: { input: 3, cost: 1 } } }), undefined, "unknown field");
    assert.equal(parseBillingSettings({ prices: { m: { input: Number.NaN } } }), undefined, "NaN");
    assert.equal(parseBillingSettings({ prices: { m: { input: "3" } } }), undefined, "string number");
});

// ---------------------------------------------------------------------------
// resolveBillingPrice — overrides first (same name matching as the registry),
// registry second, nothing third. Conservative fallbacks: a spend estimate
// never invents a discount (no kernel r=0.1w / q=4w ratios here).
// ---------------------------------------------------------------------------

test("#4899 resolveBillingPrice: overrides win over the registry, matching model-name variants", () => {
    resetState();
    setRegistryForTest({}, { "somehost/claude-x": { input: 2, output: 8, cache_read: 0.2 } });
    setBillingOverrides({ "anthropic/claude-x": { input: 3, output: 15 } });

    // Bare model name hits the override through the basename root ("claude-x").
    const viaOverride = resolveBillingPrice("claude-x");
    assert.ok(viaOverride);
    assert.equal(viaOverride.source, "config");
    assert.equal(viaOverride.input, 3);
    assert.equal(viaOverride.output, 15);
    assert.equal(viaOverride.cacheRead, 3, "missing cacheRead falls back to the input rate, never an invented discount");
    assert.equal(viaOverride.cacheWrite, 3, "missing cacheWrite falls back to the input rate");

    // Case drift folds onto the same override key.
    assert.equal(resolveBillingPrice("Anthropic/Claude-X")?.source, "config");

    // A model with no override still resolves through the registry snapshot.
    setBillingOverrides({ "anthropic/claude-x": { input: 3 } });
    const viaRegistry = resolveBillingPrice("claude-reg-only");
    assert.equal(viaRegistry, undefined, "no row anywhere: unpriced, tokens only");
    setRegistryForTest({}, {
        "somehost/claude-x": { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 },
        "somehost/claude-reg-only": { input: 2, cache_read: 0.2 },
    });
    const reg = resolveBillingPrice("claude-reg-only");
    assert.ok(reg);
    assert.equal(reg.source, "registry");
    assert.equal(reg.input, 2);
    assert.equal(reg.output, 2, "registry row without output: output bills at the input rate");
    assert.equal(reg.cacheRead, 0.2);
    assert.equal(reg.cacheWrite, 2, "registry row without cache_write: falls back to input");
    // The override still outranks the registry row for the same model.
    assert.equal(resolveBillingPrice("claude-x")?.input, 3);

    // Empty-string / undefined models resolve nothing.
    assert.equal(resolveBillingPrice(undefined), undefined);
    assert.equal(resolveBillingPrice(""), undefined);
});

// ---------------------------------------------------------------------------
// Stamp + ledger math.
// ---------------------------------------------------------------------------

function fakeSession(): Session {
    return {
        id: "bill-1",
        meta: { protocol: "anthropic" },
        metadata: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, contextTokens: 0, cacheSamples: 0, lastInputTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, compressCreditTokens: 0, rangeRestores: 0 },
        state: { blocks: [], messages: [], lastCompressedIndex: 0, blockSeq: 0, refCounter: 0, messageRefs: {}, byRef: {}, byRaw: {} },
        lastSeen: Date.now(),
        restored: false,
        persisted: false,
    } as unknown as Session;
}

test("#4899 stampBillingPrice: unresolvable model leaves no stamp", () => {
    resetState();
    const s = fakeSession();
    stampBillingPrice(s, "claude-x", "api.somehost.com");
    assert.equal(s.metadata.billingPrice, undefined, "no override, no registry row: no stamp, session bills nothing");
    stampBillingPrice(s, "claude-x");
    assert.equal(s.metadata.billingPrice, undefined);
    stampBillingPrice(s, "");
    assert.equal(s.metadata.billingPrice, undefined, "empty model keeps the previous (absent) stamp");
});

test("#4899 billInputUsage: prices the settled report (fresh at input, read at cacheRead, write at cacheWrite)", () => {
    resetState();
    setBillingOverrides({ "anthropic/claude-x": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } });
    const s = fakeSession();
    stampBillingPrice(s, "claude-x");
    // Split semantics: total = fresh(1000) + read(400) + write(100) = 1500.
    settleUsageReport(s, { total: 1500, reportedCached: 400, output: 2000, creation: 100 });
    billOutputUsage(s, 2000);
    const c = s.stats.costUsd;
    assert.ok(c, "ledger created");
    assert.ok(Math.abs(c.input - 1000 * 3 / 1e6) < 1e-12, `fresh input billed at input rate (${c.input})`);
    assert.ok(Math.abs(c.cacheRead - 400 * 0.3 / 1e6) < 1e-12, `cache reads at cacheRead (${c.cacheRead})`);
    assert.ok(Math.abs(c.cacheWrite - 100 * 3.75 / 1e6) < 1e-12, `cache writes at cacheWrite (${c.cacheWrite})`);
    assert.ok(Math.abs(c.output - 2000 * 15 / 1e6) < 1e-12, `output at output rate (${c.output})`);

    // Inclusive semantics (openai-style): total includes cached, no creation.
    settleUsageReport(s, { total: 1400, reportedCached: 400, output: 0 });
    const c2 = s.stats.costUsd!;
    assert.ok(Math.abs(c2.input - (1000 * 3 + 1000 * 3) / 1e6) < 1e-12, `inclusive second report adds fresh 1000 (${c2.input})`);
    assert.ok(Math.abs(c2.cacheRead - (400 * 0.3 + 400 * 0.3) / 1e6) < 1e-12, "cache reads accumulate");
});

test("#4899 billInputUsage: unpriced session bills nothing, corrupt stamp disables billing", () => {
    resetState();
    const unpriced = fakeSession();
    stampBillingPrice(unpriced, "claude-unknown-everywhere");
    assert.equal(unpriced.metadata.billingPrice, undefined, "no price anywhere: no stamp, no dollars");
    settleUsageReport(unpriced, { total: 1500, reportedCached: 400, creation: 100 });
    assert.equal(unpriced.stats.costUsd, undefined, "never a fabricated $0 ledger");

    const corrupt = fakeSession();
    corrupt.metadata.billingPrice = { input: -5, output: 99 } as unknown;
    settleUsageReport(corrupt, { total: 1500, reportedCached: 400, creation: 100 });
    assert.equal(corrupt.stats.costUsd, undefined, "corrupt stamp rejected by re-validation, ledger untouched");

    const partial = fakeSession();
    partial.metadata.billingPrice = { input: 2, source: "registry", cacheRead: "free!" } as unknown;
    const p = stampedBillingPrice(partial);
    assert.ok(p);
    assert.equal(p.cacheRead, 2, "non-numeric optional fields degrade to the input rate");
    assert.equal(p.output, 2);
});

test("#4899 billOutputUsage: output-only samples still bill (mirrors stats.outputTokens accumulation)", () => {
    resetState();
    setBillingOverrides({ "anthropic/claude-x": { input: 3, output: 15 } });
    const s = fakeSession();
    stampBillingPrice(s, "claude-x");
    billOutputUsage(s, 2000);
    assert.ok(Math.abs(s.stats.costUsd!.output - 0.03) < 1e-12);
    billOutputUsage(s, 0);
    assert.ok(Math.abs(s.stats.costUsd!.output - 0.03) < 1e-12, "zero output adds nothing");
});

// ---------------------------------------------------------------------------
// savedUsdFromFolds — the money mirror of the fold economics the panel
// already shows in tokens: same {w,r,q} absolute-$/Mtok profile the kernel
// report prices with (computeFoldEconomics' oneTimeCostUnits formula).
// ---------------------------------------------------------------------------

test("#4899 savedUsdFromFolds: mirrors the kernel fold economics in dollars; unpriced stays undefined", () => {
    assert.equal(savedUsdFromFolds([{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }], undefined), undefined, "no profile: never priced on fabricated defaults");
    assert.equal(savedUsdFromFolds([], { w: 3.75, r: 0.3, q: 15 }), undefined, "no folds: no number");
    assert.equal(savedUsdFromFolds([{ S: 1, sigma: 1, T: 1, requestsAfter: 1 }], { w: NaN, r: 0.3, q: 15 }), undefined, "corrupt profile rejected");

    // per-fold $ = (S−σ)·ra·r − [(w−r)·T + q·σ − r·S] (kernel/cache-report.ts)
    const got = savedUsdFromFolds([{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 10 }], { w: 3.75, r: 0.3, q: 15 });
    const perTurn = (50000 - 5000) * 10 * 0.3;
    const oneTime = (3.75 - 0.3) * 3000 + 15 * 5000 - 0.3 * 50000;
    assert.ok(got !== undefined && Math.abs(got - (perTurn - oneTime) / 1e6) < 1e-15, `expected ${(perTurn - oneTime) / 1e6}, got ${got}`);

    // An unpaid fold goes negative — honest, like the token display.
    const early = savedUsdFromFolds([{ S: 50000, sigma: 5000, T: 3000, requestsAfter: 0 }], { w: 3.75, r: 0.3, q: 15 });
    assert.ok(early !== undefined && early < 0, "fold at k=0 has not paid back yet");
});

// ---------------------------------------------------------------------------
// End-to-end through the real proxy: an anthropic usage report (fresh + cache
// read + cache write + output) settles a USD ledger on the session, stamped
// from the registry row the request's model resolved to.
// ---------------------------------------------------------------------------

async function anthropicUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2000 } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    return { port, close: () => new Promise<void>((r) => upstream.close(() => r())) };
}

function optsFor(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: {
                models: { "claude-bill": { context: 100_000 } },
            },
        },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        streamErrorShape: "protocol",
        passthroughSource: null,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        mitm: { enabled: false, domains: [] },
    };
}

test("#4899 e2e: one anthropic turn settles the full USD ledger from the registry price row", async () => {
    resetState();
    setRegistryForTest({}, {
        // Unknown relay host (127.0.0.1): the lookup runs its cross-host suffix
        // scan and finds this row for the bare model name — same discipline as
        // tests/price-profile-stamp.test.ts.
        "somehost/claude-bill": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    });
    const upstream = await anthropicUpstream();
    const proxy = await startServer(optsFor(upstream.port));
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "billing-e2e-conv" },
            // max_tokens stays above SIDE_REQUEST_MAX_TOKENS so the request is
            // a main turn (prepare runs, the stamp happens) — same note as the
            // price-profile stamp suite.
            body: JSON.stringify({ model: "claude-bill", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r.status, 200, "request served");
        const s = listSessions().find((x) => x.id.includes("billing-e2e") || (x.metadata as Record<string, unknown>)["billingPrice"] !== undefined);
        assert.ok(s, "session found");
        const stamp = s.metadata.billingPrice as Record<string, number> | undefined;
        assert.ok(stamp, "billing price stamped on the session");
        assert.equal(stamp!.source, "registry");
        const c = s.stats.costUsd;
        assert.ok(c, "USD ledger settled");
        // Split semantics: total 1500 = fresh 1000 + read 400 + write 100.
        assert.ok(Math.abs(c!.input - 0.003) < 1e-9, `input ${c!.input}`);
        assert.ok(Math.abs(c!.cacheRead - 0.00012) < 1e-9, `cacheRead ${c!.cacheRead}`);
        assert.ok(Math.abs(c!.cacheWrite - 0.000375) < 1e-9, `cacheWrite ${c!.cacheWrite}`);
        assert.ok(Math.abs(c!.output - 0.03) < 1e-9, `output ${c!.output}`);
    } finally {
        await new Promise<void>((r2) => proxy.close(() => r2()));
        await upstream.close();
    }
});

test("#4899 e2e: an unpriced model never produces a ledger (tokens only, no fake $)", async () => {
    resetState();
    const upstream = await anthropicUpstream();
    const proxy = await startServer(optsFor(upstream.port));
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "billing-e2e-unpriced" },
            body: JSON.stringify({ model: "claude-bill", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r.status, 200, "request served");
        const s = listSessions().find((x) => (x.metadata as Record<string, unknown>)["billingPrice"] !== undefined || x.stats.costUsd !== undefined);
        assert.equal(s, undefined, "no stamp, no ledger — tokens only");
        assert.deepEqual(billingOverrides(), {}, "no overrides active");
    } finally {
        await new Promise<void>((r2) => proxy.close(() => r2()));
        await upstream.close();
    }
});
