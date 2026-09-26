import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1339 track: claude-bridge (Claude Code behind the bili proxy) end-to-end
// health on the anthropic wire. Three confirmations, per the tracking issue:
//   1. compression takes effect on bridge/CC traffic: a compress tool_use
//      round-trip actually removes the folded content from the next forwarded
//      request (the wire shrinks, not just the ledger);
//   2. the bridge path's anthropic-beta: context-1m negotiation resolves the
//      window to 1M and a 261K-declared-usage compression session stays
//      healthy (no EMERGENCY nudge, no local over-window refusal);
//   3. without the beta header the same traffic must still never hit a LOCAL
//      refusal — the upstream arbitrates. (The never-compressed EMERGENCY
//      differential at 131% of 200K is pinned by tests/anthropic-beta-window
//      .test.ts on the same /bili/http lane; after a fold the kernel's
//      decideNudge pressure gate stays silent BY DESIGN because no
//      compressible content is pending — acp-kernel dist decideNudge,
//      `bestPending >= minPressureBenefit`.)
//
// Documented kernel behavior pinned here on purpose:
//   - the FIRST user message of a conversation is exempt from fold removal
//     (rebuildMessages keeps `firstUserIndex` even when covered), so the
//     folded range m00001–m00006 leaves payload 1 on the wire next to the
//     summary marker.
const MODEL = "claude-sonnet-4-5"; // model-table default 200K (config.ts)
const BETA = "context-1m-2025-08-07";
const UPSTREAM_SYSTEM = "You are a test assistant.";
const MEASURED = 261_206; // declared upstream usage: 26% of 1M, 131% of 200K

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: string[];
    /** SSE scripts the mock upstream replays, one per upstream call. */
    scripts: string[][];
    close(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const scripts: string[][] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", async () => {
            forwards.push(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "text/event-stream" });
            const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
            call += 1;
            for (const line of script) {
                if (line === "[WAIT]") {
                    await new Promise((r) => setTimeout(r, 40));
                    continue;
                }
                res.write(line);
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;
    return {
        proxyPort,
        upstreamPort,
        forwards,
        scripts,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

function url(rig: Rig): string {
    return `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
}

function round1Script(opts: { compress: boolean; usage?: { input_tokens: number } }): string[] {
    const lines = [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_bridge_1", role: "assistant", usage: opts.usage ?? { input_tokens: 37 } },
        }),
    ];
    if (opts.compress) {
        const args = JSON.stringify({
            startId: "m00001",
            endId: "m00006",
            topic: "bridge fixture topic",
            summary: "bridge fixture summary covering the early large user turns",
        });
        lines.push(
            anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bridge_1", name: "compress", input: {} } }),
            anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 40) } }),
            anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(40) } }),
            anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
            anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        );
    } else {
        lines.push(
            anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
            anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
            anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
            anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        );
    }
    lines.push(anthropicSse("message_stop", { type: "message_stop" }));
    return lines;
}

function round2Script(opts: { usage?: { input_tokens: number } }): string[] {
    return [
        anthropicSse("message_start", {
            type: "message_start",
            message: { id: "msg_bridge_2", role: "assistant", usage: opts.usage ?? { input_tokens: 20 } },
        }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

interface WireMessage {
    role: "user" | "assistant";
    content: string;
}

// 12 large user turns — the fold range m00001–m00006 sits mid-conversation so
// the folded payloads actually leave the wire (payload 1 stays via the kernel
// first-user exemption) and the default protected zone keeps the tail intact.
function bridgeConversation(): { messages: WireMessage[] } {
    const big = (i: number): string => `bridge load payload ${i} ` + `x`.repeat(3000);
    const messages: WireMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        messages.push({ role: "user", content: big(i) });
        messages.push({ role: "assistant", content: `ack ${i}` });
    }
    messages.push({ role: "user", content: "keep this recent tail visible" });
    return { messages };
}

interface CallResult {
    status: number;
    raw: string;
}

async function callBridge(rig: Rig, sessionId: string, messages: WireMessage[], beta: boolean): Promise<CallResult> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-acp-session": sessionId,
    };
    if (beta) headers["anthropic-beta"] = BETA;
    const resp = await fetch(url(rig), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: UPSTREAM_SYSTEM, messages }),
    });
    let raw = "";
    assert.ok(resp.body, "bridge response had no body");
    for await (const chunk of resp.body) raw += Buffer.from(chunk).toString("utf8");
    return { status: resp.status, raw };
}

function hasEmergencyNudge(body: string): boolean {
    return body.includes("Context limit reached");
}

function effectiveContextLimitOf(sessionId: string): unknown {
    const session = listSessions().find((s) => s.id === sessionId);
    assert.ok(session, `${sessionId} session missing`);
    return (session.metadata as unknown as Record<string, unknown>)["effectiveContextLimit"];
}

test("#1339 bridge e2e: compress round-trip removes the folded content from the forwarded conversation", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(round1Script({ compress: true }));
        rig.scripts.push(round2Script({}));
        const conv = bridgeConversation();
        const first = await callBridge(rig, "bridge-wire", conv.messages, false);
        assert.equal(first.status, 200, `round 1 status: ${first.raw.slice(0, 300)}`);
        assert.match(first.raw, /Done after compress/);

        // forwards[0] = initial forward, [1] = in-turn loop re-request (keeps
        // this turn's rendered messages by wire fidelity), [2] = turn-2
        // initial forward — the one the fold must shrink.
        const initial = rig.forwards[0]!;
        assert.ok(initial.includes("bridge load payload 2"), "sanity: round-1 forward carried the full conversation");

        const second = await callBridge(rig, "bridge-wire", [...conv.messages, { role: "user", content: "second turn after compress" }], false);
        assert.equal(second.status, 200, `turn-2 status: ${second.raw.slice(0, 300)}`);
        assert.equal(rig.forwards.length, 3, `expected 3 upstream forwards, got ${rig.forwards.length}`);
        const after = rig.forwards[2]!;

        assert.ok(!after.includes("bridge load payload 2") && !after.includes("bridge load payload 3"), "folded payloads still on the wire — compression did not shrink the forwarded conversation");
        assert.ok(after.includes("Compressed conversation section"), "turn-2 forward lacks the summary marker replacing the folded range");
        assert.ok(after.includes("bridge fixture summary covering the early large user turns"), "turn-2 forward lacks the block summary body");
        // Kernel rebuildMessages keeps the FIRST user message even when folded
        // (firstUserIndex exemption) — pinned as documented behavior.
        assert.ok(after.includes("bridge load payload 1"), "first-user exemption regressed: payload 1 should stay on the wire");
        assert.ok(after.includes("bridge load payload 4"), "unfolded mid-conversation payload disappeared");
        assert.ok(after.includes("keep this recent tail visible"), "turn-2 forward lost the protected recent tail");
        assert.ok(after.includes("second turn after compress"), "turn-2 forward lost the new user turn");
        assert.ok(after.length < initial.length - 5_000, `turn-2 forward did not shrink meaningfully (${initial.length} → ${after.length})`);
    } finally {
        await rig.close();
    }
});

test("#1339 bridge e2e: anthropic-beta context-1m keeps a 261K-usage compression session healthy (1M window, no EMERGENCY, no local refusal)", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(round1Script({ compress: true, usage: { input_tokens: MEASURED } }));
        rig.scripts.push(round2Script({ usage: { input_tokens: MEASURED } }));
        rig.scripts.push(round1Script({ compress: false, usage: { input_tokens: MEASURED } }));
        const conv = bridgeConversation();
        const first = await callBridge(rig, "bridge-beta-1m", conv.messages, true);
        assert.equal(first.status, 200, `round 1 status: ${first.raw.slice(0, 300)}`);
        assert.match(first.raw, /Done after compress/);
        assert.equal(effectiveContextLimitOf("bridge-beta-1m"), 1_000_000, "anthropic-beta did not resolve the window to 1M on the bridge lane");

        // Turn 2 through prepare — where an EMERGENCY nudge / local over-window
        // refusal would fire at 131% of a 200K window. Under the beta-resolved
        // 1M window the same usage is 26%: healthy.
        const second = await callBridge(rig, "bridge-beta-1m", [...conv.messages, { role: "user", content: "second turn after compress" }], true);
        assert.equal(second.status, 200, `turn-2 status: ${second.raw.slice(0, 300)}`);
        assert.match(second.raw, /ok/);

        for (const body of rig.forwards) {
            assert.ok(!hasEmergencyNudge(body), "EMERGENCY nudge fired at 26% of the 1M window");
        }
        assert.ok(!first.raw.includes("Prompt is too long") && !second.raw.includes("Prompt is too long"), "local over-window refusal surfaced to the client");
        const after = rig.forwards[rig.forwards.length - 1]!;
        assert.ok(!after.includes("bridge load payload 2"), "folded content must leave the wire under the beta path too");
        assert.ok(after.includes("Compressed conversation section"), "beta path lost the summary marker");
    } finally {
        await rig.close();
    }
});

test("#1339 bridge e2e: without the beta header the same 261K post-compress traffic still never hits a local refusal", async () => {
    const rig = await startRig();
    try {
        rig.scripts.push(round1Script({ compress: true, usage: { input_tokens: MEASURED } }));
        rig.scripts.push(round2Script({ usage: { input_tokens: MEASURED } }));
        rig.scripts.push(round1Script({ compress: false, usage: { input_tokens: MEASURED } }));
        const conv = bridgeConversation();
        const first = await callBridge(rig, "bridge-beta-200k", conv.messages, false);
        assert.equal(first.status, 200, `round 1 status: ${first.raw.slice(0, 300)}`);
        assert.equal(effectiveContextLimitOf("bridge-beta-200k"), 200_000, "model-table window should stay 200K without the beta header");

        // 131% of the 200K table window with nothing left to compress (the
        // fold already ran; the kernel's nudge pressure gate is silent by
        // design). The proxy must forward and let the upstream arbitrate —
        // never reject locally ("Prompt is too long" family).
        const second = await callBridge(rig, "bridge-beta-200k", [...conv.messages, { role: "user", content: "second turn no beta" }], false);
        assert.equal(second.status, 200, `turn-2 status: ${second.raw.slice(0, 300)}`);
        assert.ok(!first.raw.includes("Prompt is too long") && !second.raw.includes("Prompt is too long"), "false local over-window refusal on post-compress traffic");
        assert.ok(rig.forwards.length >= 3, "turn-2 was not forwarded upstream");
        assert.ok(!rig.forwards[rig.forwards.length - 1]!.includes("bridge load payload 2"), "folded content reappeared on the wire");
    } finally {
        await rig.close();
    }
});
