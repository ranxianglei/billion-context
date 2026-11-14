import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { lookupContextLimit, tierGatedStandardWindow, type ProxyOptions } from "../src/config.ts";
import { capRegistryWindowByStandard } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #6433: the 5.x-generation Claude line (Opus 4.6+/5.x, Sonnet 5.x, Fable,
// Mythos) serves 1M NATIVELY — no context-Nm beta header or [Nm] suffix
// required. The #1321 tier-gate assumed every claude-* id was 200K-standard
// (1M beta-gated), which held for the 4.x line but is stale for these: the
// registry advertises 1M (correct) and the cap clamped it back to 200K,
// firing a spurious preflight + deep fold + cold cache on a request that
// already fit. Field evidence: claude-fable-5-2 forwarded 282K cleanly with
// no tier evidence. Fix: a specific 1M row BEFORE the generic claude- row so
// both the fallback lookup and the tier-gate standard resolve to 1M (the cap
// becomes a no-op); genuinely beta-gated ids (Sonnet 4.x, Opus ≤4.5, Haiku)
// still fall through to the 200K row.

const ONE_M = 1_000_000;
const STANDARD_200K = 200_000;

// 1M-native ids (standard window IS 1M, no beta needed).
const ONE_M_NATIVE = [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-opus-5-0",
    "claude-sonnet-5-0",
    "claude-sonnet-5-5",
    "claude-mythos-5-1",
    "claude-opus-4-6",
    "claude-opus-4-9",
];

// Genuinely beta-gated ids (standard 200K; 1M needs the context-Nm beta).
const BETA_GATED = [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-haiku-4-5",
];

test("#6433: lookupContextLimit resolves 1M for the 1M-native Claude line", () => {
    for (const id of ONE_M_NATIVE) {
        assert.equal(lookupContextLimit(id), ONE_M, `${id} → 1M (was 200K before the fix)`);
    }
});

test("#6433: lookupContextLimit keeps 200K for genuinely beta-gated Claude ids", () => {
    for (const id of BETA_GATED) {
        assert.equal(lookupContextLimit(id), STANDARD_200K, `${id} → 200K (beta-gated, unchanged)`);
    }
});

test("#6433: prefixed ids resolve by basename (relay deployments)", () => {
    assert.equal(lookupContextLimit("anthropic/claude-fable-5-2"), ONE_M, "basename wins");
    assert.equal(lookupContextLimit("anthropic/claude-sonnet-4-5"), STANDARD_200K, "beta-gated basename wins");
});

test("#6433: tierGatedStandardWindow is 1M for 1M-native, 200K for beta-gated", () => {
    for (const id of ONE_M_NATIVE) {
        assert.equal(tierGatedStandardWindow(id), ONE_M, `${id} standard is 1M → cap is a no-op`);
    }
    for (const id of BETA_GATED) {
        assert.equal(tierGatedStandardWindow(id), STANDARD_200K, `${id} standard is 200K → cap applies`);
    }
    assert.equal(tierGatedStandardWindow("gpt-5"), undefined, "non-claude family stays uncapped (#344)");
});

test("#6433: capRegistryWindowByStandard no-ops for 1M-native, caps for beta-gated", () => {
    // 1M-native: the registry's 1M stands (no tier evidence needed).
    for (const id of ONE_M_NATIVE) {
        assert.equal(capRegistryWindowByStandard(id, ONE_M, false), ONE_M, `${id}: advertised 1M stands without tier evidence`);
        assert.equal(capRegistryWindowByStandard(id, 200_000, false), 200_000, `${id}: sub-standard registry wins (fresher source)`);
    }
    // Beta-gated: the registry's 1M is capped to the 200K standard without evidence.
    for (const id of BETA_GATED) {
        assert.equal(capRegistryWindowByStandard(id, ONE_M, false), STANDARD_200K, `${id}: advertised max capped to standard`);
        assert.equal(capRegistryWindowByStandard(id, ONE_M, true), ONE_M, `${id}: tier evidence bypasses the cap`);
    }
});

// --- E2E: resolution through the real proxy pipeline ---

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
}

async function startRig(model: string): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({ [`anthropic/${model}`]: { limit: { context: ONE_M } } });
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxyPort, upstreamPort, proxy, upstream };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("e2e: #6433 — 1M-native claude-fable-5-2 is NOT capped to 200K without tier evidence", async () => {
    const rig = await startRig("claude-fable-5-2");
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fable-sess" },
            body: JSON.stringify({ model: "claude-fable-5-2", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, ONE_M, "1M-native model budgeted at the advertised 1M, not capped to 200K");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: #6433/#1321 — beta-gated claude-sonnet-4-5 IS still capped to 200K without tier evidence", async () => {
    const rig = await startRig("claude-sonnet-4-5");
    try {
        const r = await fetch(url(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sonnet4-sess" },
            body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(listSessions()[0]?.metadata.effectiveContextLimit, STANDARD_200K, "beta-gated model still capped to the 200K standard (#1321 preserved)");
    } finally {
        await closeRig(rig);
    }
});
