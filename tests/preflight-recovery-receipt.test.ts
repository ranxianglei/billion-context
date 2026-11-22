import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { outboundContextEstimates, preflightCompressIfNeeded, type Prepared } from "../src/server.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));
const SUMMARY = "SUMMARY: retain the task goal and acceptance criteria; the repetitive fixture is disposable.";

function fixture(url = "http://127.0.0.1:1/responses") {
    const session = getSession(`recovery-receipt-${randomUUID()}`);
    const core = createCore();
    const config = defaultConfig(6000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue." },
    ];
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", input: messages.map(m => ({ role: m.role, content: m.text })) }),
        session, processedMessages: messages, originalMessages: messages,
        protocol: "responses", stream: false, compressInjected: false,
    };
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: 6000, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const logs: string[] = [];
    return { session, core, config, messages, prepared, req, res, opts, logs };
}

type Fixture = ReturnType<typeof fixture>;
function gate(f: Fixture, rebuild: () => Promise<Prepared> = async () => f.prepared, anonymous = false, model = "test-model") {
    return preflightCompressIfNeeded(f.prepared, rebuild, f.req, Buffer.from(f.prepared.body), f.res,
        f.opts, f.core, f.config, f.config.modelContextLimit, model, undefined, undefined,
        { upstream: f.opts.upstream, rewrittenUrl: f.opts.upstream }, undefined, anonymous,
        (_level, message) => { f.logs.push(message); }, "recovery-receipt-test");
}

async function withUpstream(run: (url: string, calls: () => number) => Promise<void>, beforeResponse?: () => void) {
    let calls = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            beforeResponse?.();
            calls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY }] }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`, () => calls);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
    }
}

function fit(f: Fixture): Prepared {
    const messages: CoreMessage[] = [{ id: "small", role: "user", contentType: "text", text: "Continue." }];
    return { ...f.prepared, processedMessages: messages, originalMessages: messages,
        body: JSON.stringify({ model: "test-model", input: messages.map(m => ({ role: m.role, content: m.text })) }) };
}

test("estimate-only evidence probe is spent before an interrupted retry", async () => {
    const f = fixture();
    f.session.stats.lastInputTokens = 30_000;
    f.session.stats.lastInputTokensSource = "estimate";
    assert.equal(await gate(f), f.prepared, "one evidence probe remains available");
    f.session.metadata = JSON.parse(JSON.stringify(f.session.metadata)) as Record<string, unknown>;
    f.res.destroy();
    const retried = await gate(f);
    assert.ok("failFast" in retried, "an aborted probe must not reopen the evidence return");
    assert.equal(retried.respond, false);
});

for (const pluginMode of [false, true]) {
    test(`interrupted over-window walk records pending recovery before awaits (plugin=${pluginMode})`, async () => {
        await withUpstream(async (url, calls) => {
            const f = fixture(url);
            f.prepared.pluginMode = pluginMode;
            const retried = await gate(f, async () => {
                const saved = JSON.parse(JSON.stringify(f.session.metadata)) as Record<string, unknown>;
                assert.ok(saved.preflightRecovery, "recovery receipt must already be persisted before rebuilding");
                f.session.metadata = saved;
                f.res.emit("close");
                return f.prepared;
            });
            assert.ok("failFast" in retried);
            assert.equal(retried.respond, false);
            assert.ok(f.session.state.blocks.length > 0, "completed summaries survive interruption");
            const summaryCalls = calls();
            f.res.destroy();
            const retry = await gate(f);
            assert.ok("failFast" in retry);
            assert.equal(calls(), summaryCalls, "closed retry cannot call the upstream");
        });
    });
}

for (const dimension of ["origin", "model", "window"] as const) {
    test(`a changed ${dimension} starts a fresh evidence scope`, async () => {
        const f = fixture();
        f.session.stats.lastInputTokens = 30_000;
        f.session.stats.lastInputTokensSource = "estimate";
        assert.equal(await gate(f), f.prepared);
        let model = "test-model";
        if (dimension === "origin") f.opts.upstream = "http://127.0.0.1:2/responses";
        if (dimension === "model") model = "other-model";
        if (dimension === "window") f.config.modelContextLimit = 6500;
        assert.equal(await gate(f, undefined, false, model), f.prepared);
        const receipt = f.session.metadata.preflightRecovery as { origin: string; model: string; window: number };
        assert.equal(receipt.origin, new URL(f.opts.upstream).origin);
        assert.equal(receipt.model, model);
        assert.equal(receipt.window, f.config.modelContextLimit);
        f.res.destroy();
        assert.ok("failFast" in await gate(f, undefined, false, model), "new scope also gets only one probe");
    });
}

test("a verified fitting payload clears recovery and does not block unrelated traffic", async () => {
    const f = fixture();
    f.session.stats.lastInputTokens = 30_000;
    f.session.stats.lastInputTokensSource = "estimate";
    await gate(f);
    const oversized = f.prepared;
    f.prepared = fit(f);
    assert.equal(await gate(f), f.prepared);
    assert.equal(f.session.metadata.preflightRecovery, undefined);
    f.prepared = oversized;
    assert.equal(await gate(f), oversized, "a completed fitting turn permits a fresh episode");
});

for (const anonymous of [false, true]) {
    test(`pending recovery cannot forward an oversized rebuilt body (anonymous=${anonymous})`, async () => {
        await withUpstream(async url => {
            const f = fixture(url);
            f.session.metadata.preflightRecovery = { origin: new URL(url).origin, model: "test-model", window: 6000, pending: true, probeUsed: true };
            const result = await gate(f, async () => ({ ...f.prepared,
                processedMessages: fit(f).processedMessages }), anonymous);
            assert.ok("failFast" in result, "judge the actual rebuilt wire, not the summary walk or processed view");
            assert.ok(f.session.state.blocks.length > 0);
            assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY));
            assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
        });
    });
}

function anonymousGreyZone(f: Fixture): Prepared {
    const messages: CoreMessage[] = [{ id: "grey", role: "user", contentType: "text", text: "dense_code_".repeat(700) }];
    const prepared = { ...f.prepared, processedMessages: messages, originalMessages: messages,
        body: JSON.stringify({ model: "test-model", input: messages.map(m => ({ role: m.role, content: m.text })) }) };
    const estimate = outboundContextEstimates(prepared, prepared.body, f.opts, f.opts.upstream);
    assert.ok(estimate.textOverhead + estimate.imageTokens < 6000);
    assert.ok(estimate.upperBound > 6000);
    return prepared;
}

test("anonymous grey-zone cancellation cannot clear pending recovery or reopen probes", async () => {
    const f = fixture();
    f.prepared = anonymousGreyZone(f);
    f.session.metadata.preflightRecovery = { origin: new URL(f.opts.upstream).origin, model: "test-model", window: 6000, pending: true, probeUsed: true };
    f.res.destroy();
    const result = await gate(f, undefined, true);
    assert.ok("failFast" in result);
    assert.equal(result.respond, false);
    assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
    assert.equal((f.session.metadata.preflightRecovery as { probeUsed: boolean }).probeUsed, true);
});

for (const upperFits of [false, true]) {
    test(`anonymous rebuilt wire keeps the conservative upper-bound fit policy (upperFits=${upperFits})`, async () => {
        await withUpstream(async url => {
            const f = fixture(url);
            const rebuilt = upperFits ? fit(f) : anonymousGreyZone(f);
            f.session.metadata.preflightRecovery = { origin: new URL(url).origin, model: "test-model", window: 6000, pending: true, probeUsed: true };
            const result = await gate(f, async () => ({ ...rebuilt, processedMessages: fit(f).processedMessages }), true);
            assert.equal("failFast" in result, !upperFits, "judge actual wire upper bound, not optimistic processed messages");
            if (upperFits) assert.equal(f.session.metadata.preflightRecovery, undefined);
            else assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
            assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY));
        });
    });
}

test("a fresh post-fold arbitration remains available once, not after interruption", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const first = await gate(f, async () => f.prepared, true);
        assert.ok(!("failFast" in first), "the first uncalibrated fresh request keeps its evidence bet");
        assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
        f.session.metadata = JSON.parse(JSON.stringify(f.session.metadata)) as Record<string, unknown>;
        f.res.destroy();
        assert.ok("failFast" in await gate(f, undefined, true), "pending retry cannot repeat post-fold arbitration");
    });
});

test("pending recovery is visible before the first summary request completes", async () => {
    let active: Fixture | undefined;
    let observed = false;
    await withUpstream(async url => {
        const f = fixture(url);
        active = f;
        assert.ok(!("failFast" in await gate(f, async () => fit(f))));
    }, () => {
        assert.ok(active);
        assert.equal((active.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
        observed = true;
    });
    assert.equal(observed, true);
});

test("cancellation restores the pending receipt after a fitting rebuild rebases metadata", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const result = await gate(f, async () => {
            f.session.metadata = {};
            f.res.emit("close");
            return fit(f);
        });
        assert.ok("failFast" in result);
        assert.equal(result.respond, false);
        assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
        assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY));
    });
});

test("live verified fitting rebuild clears pending recovery and retains summaries", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const result = await gate(f, async () => fit(f));
        assert.ok(!("failFast" in result));
        assert.equal(f.session.metadata.preflightRecovery, undefined);
        assert.ok(JSON.stringify(f.session.state.blocks).includes(SUMMARY));
    });
});

test("image arbitration also spends its one evidence probe", async () => {
    const f = fixture();
    f.prepared = fit(f);
    f.prepared.body = JSON.stringify({ model: "test-model", input: [{ role: "user", content: [
        { type: "input_text", text: "Describe the image." },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.alloc(40_000).toString("base64")}` },
    ] }] });
    assert.equal(await gate(f), f.prepared, "first image-only estimate can ask the upstream");
    assert.equal((f.session.metadata.preflightRecovery as { probeUsed: boolean }).probeUsed, true);
    f.res.destroy();
    assert.ok("failFast" in await gate(f), "the same image scope cannot arbitrate again after interruption");
});

for (const mismatch of ["origin", "model"] as const) {
    test(`calibration from another ${mismatch} does not suppress the first probe`, async () => {
        const f = fixture();
        f.session.stats.lastInputTokens = 30_000;
        f.session.stats.lastInputTokensSource = "estimate";
        f.session.stats.calibratedEstimate = 2;
        f.session.stats.calibratedEstimateOrigin = mismatch === "origin" ? "http://127.0.0.1:2" : new URL(f.opts.upstream).origin;
        f.session.stats.calibratedEstimateModel = mismatch === "model" ? "other-model" : "test-model";
        f.session.metadata.lastModel = "test-model";
        assert.equal(await gate(f), f.prepared);
        assert.equal((f.session.metadata.preflightRecovery as { probeUsed: boolean }).probeUsed, true);
    });
}

test("auxiliary requests without a model cannot erase pending recovery", async () => {
    const f = fixture();
    const receipt = { origin: new URL(f.opts.upstream).origin, model: "test-model", window: 6000, pending: true, probeUsed: true };
    f.session.metadata.preflightRecovery = receipt;
    assert.equal(await gate(f, undefined, false, ""), f.prepared);
    assert.equal(f.session.metadata.preflightRecovery, receipt);
});

test("calibrated over-limit payload cannot take an estimate-only evidence escape", async () => {
    const f = fixture();
    f.session.stats.lastInputTokens = 30_000;
    f.session.stats.lastInputTokensSource = "estimate";
    f.session.stats.calibratedEstimate = 2;
    f.session.stats.calibratedEstimateOrigin = new URL(f.opts.upstream).origin;
    f.session.stats.calibratedEstimateModel = "test-model";
    f.session.metadata.lastModel = "test-model";
    f.res.destroy();
    assert.ok("failFast" in await gate(f));
    assert.equal((f.session.metadata.preflightRecovery as { pending: boolean }).pending, true);
});
