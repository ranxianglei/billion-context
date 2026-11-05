// #2645: prompt_cache_key on a strict direct API 400s every plugin-lane turn
// ("Unsupported parameter(s): `prompt_cache_key`"). The fix is probe-and-
// remember at the relay egress seam: the first key-carrying 400 re-sends the
// IDENTICAL request minus the key once — accepted ⇒ the origin+model pair is
// remembered process-locally and the key is withheld there until restart;
// still failing ⇒ inconclusive, nothing learned, the key stays. These tests
// run the full proxy against a scripted strict/lenient/poisoned upstream.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { pckAblations, pckKeyAbated, recordPckAblation, _resetPckProbeForTest, _pckProbeSessionCountForTest } from "../src/pck-probe.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { Server } from "node:http";

interface Captured {
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
}

type Strictness = "strict" | "lenient" | "poisoned"; // poisoned = 400 no matter what

function chatSse(): string {
    return (
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n"
    );
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    setStrictness(mode: Strictness): void;
    close(): Promise<void>;
}

async function startHarness(strictModels?: Set<string>): Promise<Harness> {
    const captured: Captured[] = [];
    let strictness: Strictness = "lenient";
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            captured.push({ headers: req.headers, body });
            const hasKey = typeof body.prompt_cache_key === "string";
            // #2645 evidence table: NVIDIA's strictness is MODEL-level on one
            // origin — honor an explicit strict-model set when given.
            const strictHit = strictness === "poisoned" ||
                (strictness === "strict" && hasKey && (strictModels ? strictModels.has(String(body.model)) : true));
            if (strictHit) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: hasKey ? 'Validation: Unsupported parameter(s): `prompt_cache_key`' : "always broken", type: "invalid_request_error" } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(chatSse());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPckProbeForTest();
    const proxy: Server = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyPort,
        upstreamPort,
        captured,
        setStrictness: (mode) => { strictness = mode; },
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hello " + Math.random() }],
        ...extra,
    };
}

function pluginHeaders(sid: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": sid };
}

test("#2645 probe: strict API self-heals in one turn, later turns skip the 400 entirely", async () => {
    const h = await startHarness();
    try {
        h.setStrictness("strict");
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        // Turn 1: stamped key 400s, the A/B retry without the key succeeds —
        // the client never sees the 400 at all.
        const r1 = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-probe-1"), body: JSON.stringify(chatBody()) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(h.captured.length, 2);
        assert.equal(h.captured[0].body.prompt_cache_key, "dsh-probe-1"); // original attempt carried the stamp
        assert.equal(h.captured[1].body.prompt_cache_key, undefined);   // probe stripped it
        assert.deepEqual(Object.keys(h.captured[1].body).sort(), Object.keys(h.captured[0].body).sort().filter((k) => k !== "prompt_cache_key"));
        // Remembered per origin+model…
        const abled = pckAblations();
        assert.equal(abled.length, 1);
        assert.equal(abled[0].origin, `http://127.0.0.1:${h.upstreamPort}`);
        assert.equal(abled[0].model, "gpt-test");
        assert.deepEqual(abled[0].sessions, ["dsh-probe-1"]);
        // …and visible on the operator surface (web overview payload).
        const ov = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/overview`).then((r) => r.json() as Promise<Record<string, unknown>>);
        const sups = ov.pckSuppressions as Array<Record<string, unknown>>;
        assert.equal(sups.length, 1);
        assert.equal(sups[0].origin, abled[0].origin);
        // Turn 2: the key is withheld before egress — exactly ONE upstream hit, key-less.
        const r2 = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-probe-1"), body: JSON.stringify(chatBody()) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(h.captured.length, 3);
        assert.equal(h.captured[2].body.prompt_cache_key, undefined);
    } finally {
        await h.close();
    }
});

test("#2645 probe: lenient pool keeps receiving the key every turn, nothing learned", async () => {
    const h = await startHarness();
    try {
        h.setStrictness("lenient");
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        for (let i = 0; i < 2; i++) {
            const r = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-pool-1"), body: JSON.stringify(chatBody()) });
            assert.equal(r.status, 200);
            await r.text();
        }
        assert.equal(h.captured.length, 2);
        for (const c of h.captured) assert.equal(c.body.prompt_cache_key, "dsh-pool-1");
        assert.equal(pckAblations().length, 0);
    } finally {
        await h.close();
    }
});

test("#2645 probe: unrelated persistent 400 is NOT attributed to the key — key stays, 400 passes through", async () => {
    const h = await startHarness();
    try {
        h.setStrictness("poisoned");
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        const r = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-poison-1"), body: JSON.stringify(chatBody()) });
        assert.equal(r.status, 400);
        await r.text();
        // original attempt (key) + one inconclusive key-less probe
        assert.equal(h.captured.length, 2);
        assert.equal(h.captured[0].body.prompt_cache_key, "dsh-poison-1");
        assert.equal(h.captured[1].body.prompt_cache_key, undefined);
        assert.equal(pckAblations().length, 0);
        // the NEXT turn re-runs the same experiment: stamp + one probe again
        const r2 = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-poison-1"), body: JSON.stringify(chatBody()) });
        assert.equal(r2.status, 400);
        await r2.text();
        assert.equal(h.captured.length, 4);
        assert.equal(h.captured[2].body.prompt_cache_key, "dsh-poison-1");
        assert.equal(h.captured[3].body.prompt_cache_key, undefined);
        assert.equal(pckAblations().length, 0);
    } finally {
        await h.close();
    }
});

test("#2645 probe: model-level granularity — sibling model on the same strict origin keeps the key", async () => {
    const h = await startHarness(new Set(["nim-550b"]));
    try {
        h.setStrictness("strict");
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        // #2645 evidence table: super-120b accepts the key while ultra-550b on
        // the SAME origin rejects it — strictness is model-level.
        const rA = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-mix-a"), body: JSON.stringify(chatBody({ model: "nim-550b" })) });
        assert.equal(rA.status, 200);
        await rA.text();
        assert.equal(h.captured[0].body.prompt_cache_key, "dsh-mix-a");
        assert.equal(h.captured[1].body.prompt_cache_key, undefined);
        // A different model on the same origin must still get stamped (and pay
        // its own one-time probe if that model is strict too).
        const rB = await fetch(base, { method: "POST", headers: pluginHeaders("dsh-mix-a"), body: JSON.stringify(chatBody({ model: "nim-120b" })) });
        assert.equal(rB.status, 200);
        await rB.text();
        assert.equal(h.captured[2].body.model, "nim-120b");
        assert.equal(h.captured[2].body.prompt_cache_key, "dsh-mix-a");
        assert.equal(pckAblations().length, 1);
        assert.equal(pckAblations()[0].model, "nim-550b");
    } finally {
        await h.close();
    }
});

test("#2645 probe: client-supplied keys pass through verbatim, then get withheld after their pair is A/B-ablated", async () => {
    const h = await startHarness();
    try {
        h.setStrictness("strict");
        const base = `http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`;
        // Plain client (no identity header): its own key rides through turn 1,
        // the 400 triggers the probe, the pair gets ablated…
        const r1 = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody({ prompt_cache_key: "client-owned-key" })) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(h.captured[0].body.prompt_cache_key, "client-owned-key");
        assert.equal(h.captured[1].body.prompt_cache_key, undefined);
        // …so turn 2 drops even the client's OWN key (otherwise every turn
        // re-paid the 400 round trip) — visible via the same surfaces.
        const r2 = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody({ prompt_cache_key: "client-owned-key" })) });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(h.captured.length, 3);
        assert.equal(h.captured[2].body.prompt_cache_key, undefined);
        assert.equal(pckAblations().length, 1);
        assert.equal(pckAblations()[0].model, "gpt-test");
    } finally {
        await h.close();
    }
});

test("#2645 probe: memory resets between processes (no persistence)", () => {
    const base1 = "http://127.0.0.1:9999/v1/chat/completions";
    const origin = "http://127.0.0.1:9999";
    _resetPckProbeForTest();
    assert.equal(pckKeyAbated(`${origin}/chat/completions`, origin, "m1"), false);
    recordPckAblation({ origin: base1, model: "m1", sessionId: "s-x", statusWithKey: 400, errSnippet: "x" });
    // origin normalization: recorded via a pathed URL, looked up via bare origin
    assert.equal(pckKeyAbated(origin, undefined, "m1"), true);
    _resetPckProbeForTest();
    assert.equal(pckKeyAbated(`${origin}/chat/completions`, origin, "m1"), false);
    assert.equal(pckAblations().length, 0);
});

// #3813: the registry must stay bounded even when an untrusted tunnel client
// drives egress facts without limit — both growth axes (distinct pairs AND
// per-pair session ids) are capped. These are pure unit tests (no server): the
// caps live entirely in recordPckAblation's bookkeeping.
test("#3813 bound: a flood of distinct (origin,model) pairs cannot grow the registry without limit", () => {
    _resetPckProbeForTest();
    const N = 200; // well past the pair-table ceiling
    for (let i = 0; i < N; i++) {
        recordPckAblation({ origin: `http://host-${i}.example.com/v1`, model: "m-flood", sessionId: `s-${i}`, statusWithKey: 400, errSnippet: "x" });
    }
    const abled = pckAblations();
    // Bounded, not pinned to the exact ceiling: an unbounded regression would return N.
    assert.ok(abled.length <= 128, `registry grew to ${abled.length} after ${N} pairs — expected a bounded cap`);
    // LRU discipline: the most-recently-confirmed destination survives the flood…
    assert.ok(abled.some((e) => e.origin === "http://host-199.example.com"), "newest-confirmed pair was evicted");
    // …and the oldest one is gone (it had no reconfirmation to protect it).
    assert.ok(!abled.some((e) => e.origin === "http://host-0.example.com"), "oldest un-reconfirmed pair should have been evicted");
});

test("#3813 bound: unlimited distinct session ids on ONE pair cannot grow its session map", () => {
    _resetPckProbeForTest();
    const origin = "http://cap.example.com/v1";
    for (let i = 0; i < 200; i++) {
        recordPckAblation({ origin, model: "m-cap", sessionId: `sess-${i}`, statusWithKey: 400, errSnippet: "x" });
    }
    // The underlying per-pair map is capped (the display array alone can't show this).
    assert.ok(_pckProbeSessionCountForTest(origin, undefined, "m-cap") <= 32, "per-pair session map exceeded its cap");
    // …while the public display width is unchanged (top-N only).
    const abled = pckAblations();
    assert.equal(abled.length, 1);
    assert.ok(abled[0].sessions.length > 0 && abled[0].sessions.length <= 8, "display array must list at most 8 sessions");
});
