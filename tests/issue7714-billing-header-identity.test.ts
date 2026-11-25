// #7714: Claude Code prepends a billing-attribution text block to `system`
// (starting with "x-anthropic-billing-header:") and rotates `cch` /
// `cc_prev_msg` inside it on EVERY turn. That volatile block must never enter a
// system-IDENTITY derivation — it would flip sessionFp (#1930) on every turn and
// make the #5095 lane-token subagent key change on every turn even when the real
// persona prompt is byte-identical.
//
// The fix excludes the billing block from the two identity views
// (noteSystemPromptFingerprint in prepare-anthropic, and personaSystemText in
// handle) while forwarding parsed.system (including the block) byte-exact
// upstream and leaving the #2189 preflight extraction untouched.
//
// This file pins: (1) the helper contract, (2) fingerprint stability across
// billing rotation, (3) the e2e lane-key stability across billing rotation.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, _sessionsSizeForTest, peekSession, type Session } from "../src/session.ts";
import { noteSystemPromptFingerprint } from "../src/fold-reconcile.ts";
import { systemExcludingBilling } from "../src/preflight.ts";
import { mintClaudeLaneToken, LANE_TOKEN_MARKER } from "../src/claude-lane-token.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// --- fixtures ---

const BILLING_A = "x-anthropic-billing-header: cc_version=2.1.300; cc_entrypoint=cli; cch=aaa111;";
const BILLING_B = "x-anthropic-billing-header: cc_version=2.1.300; cc_entrypoint=cli; cch=bbb222; cc_prev_msg=m00042;";
const PERSONA_A = "You are a Claude agent, built on Anthropic's...";
const PERSONA_B = "You are a file search specialist for...";
const MAIN_SYSTEM = ["You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent..."];

const sysBlocks = (system: string[]) => system.map((t) => ({ type: "text", text: t }));
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const personaTag = `${PERSONA_A}\n\n${PERSONA_B}`;

// --- Unit: the helper contract ---

test("#7714 systemExcludingBilling: drops billing blocks, keeps everything else", () => {
    // Array with billing + persona → billing removed, persona kept, order preserved.
    assert.deepEqual(
        systemExcludingBilling([
            { type: "text", text: BILLING_A },
            { type: "text", text: PERSONA_A },
            { type: "text", text: PERSONA_B },
        ]),
        [
            { type: "text", text: PERSONA_A },
            { type: "text", text: PERSONA_B },
        ],
    );
    // No billing → unchanged.
    const plain = [
        { type: "text", text: PERSONA_A },
        { type: "text", text: PERSONA_B },
    ];
    assert.deepEqual(systemExcludingBilling(plain), plain);
    // String system → pass-through unchanged (only the block-array wire carries the block).
    assert.equal(systemExcludingBilling("a string system"), "a string system");
    // undefined → pass-through.
    assert.equal(systemExcludingBilling(undefined), undefined);
    // Non-text blocks preserved.
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } };
    assert.deepEqual(systemExcludingBilling([img, { type: "text", text: BILLING_A }]), [img]);
    // Leading whitespace before the prefix still matches (trimStart).
    assert.deepEqual(
        systemExcludingBilling([{ type: "text", text: `  ${BILLING_A}` }, { type: "text", text: PERSONA_A }]),
        [{ type: "text", text: PERSONA_A }],
    );
    // Multiple billing blocks all removed.
    assert.deepEqual(
        systemExcludingBilling([
            { type: "text", text: BILLING_A },
            { type: "text", text: BILLING_B },
            { type: "text", text: PERSONA_A },
        ]),
        [{ type: "text", text: PERSONA_A }],
    );
    // Billing-only array → empty array.
    assert.deepEqual(systemExcludingBilling([{ type: "text", text: BILLING_A }]), []);
    // A text block that merely MENTIONS the prefix mid-string is NOT a billing block.
    const mention = `note: ${BILLING_A}`;
    assert.deepEqual(systemExcludingBilling([{ type: "text", text: mention }]), [{ type: "text", text: mention }]);
});

// --- Unit: fingerprint stability across billing rotation (the prepare-anthropic composition) ---

function fakeSession(): Session {
    return { state: { blocks: [] }, metadata: {} } as unknown as Session;
}

test("#7714 fingerprint: stable across billing rotation, flips on a genuine persona edit", () => {
    const session = fakeSession();
    const logs: string[] = [];
    const logOpts = { sessionId: "s7714", log: (_l: string, m: string) => logs.push(m) };
    // Two turns of the SAME persona, only the billing block's cch/cc_prev_msg rotates.
    const turn1 = sysBlocks([BILLING_A, PERSONA_A, PERSONA_B]);
    const turn2 = sysBlocks([BILLING_B, PERSONA_A, PERSONA_B]);
    // The prepare-anthropic call site: fingerprint the billing-excluded view.
    noteSystemPromptFingerprint(session, systemExcludingBilling(turn1), logOpts);
    const fp1 = (session.metadata.systemFp as { fp: string }).fp;
    assert.ok(fp1 !== "-" && fp1.length > 0, "first turn records a real fingerprint");
    noteSystemPromptFingerprint(session, systemExcludingBilling(turn2), logOpts);
    const fp2 = (session.metadata.systemFp as { fp: string }).fp;
    assert.equal(fp2, fp1, "billing rotation alone must not flip systemFp");
    assert.equal(logs.length, 0, "no spurious 'system prompt changed' log on billing rotation");

    // A genuine persona edit (billing unchanged) still flips the fingerprint.
    const turn3 = sysBlocks([BILLING_B, PERSONA_A, PERSONA_B + " (edited)"]);
    noteSystemPromptFingerprint(session, systemExcludingBilling(turn3), logOpts);
    const fp3 = (session.metadata.systemFp as { fp: string }).fp;
    assert.notEqual(fp3, fp1, "a genuine persona edit must still flip systemFp");
    assert.equal(logs.length, 1, "the persona edit logs exactly one change");
    assert.match(logs[0], /system prompt changed/);
});

// --- E2E: rotating billing header keeps the subagent on ONE lane ---

type Msg = { role: string; content: string | { type: string; text?: string; source?: unknown }[] };

function history(prefix: string, turns: number): Msg[] {
    const out: Msg[] = [];
    for (let i = 1; i <= turns; i++) {
        out.push({ role: "user", content: `${prefix}-user-${i}` });
        out.push({ role: "assistant", content: `${prefix}-assistant-${i}` });
    }
    return out;
}

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): string {
    return (
        sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sse("content_block_stop", { index: 0 }) +
        sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        sse("message_stop", {})
    );
}

function startMockUpstream(): http.Server {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(anthropicStream());
        res.end();
    });
    server.listen(0, "127.0.0.1");
    return server;
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startHarness(upstream: http.Server, over: Partial<ProxyOptions> = {}): Promise<{ proxy: http.Server; post: (headers: Record<string, string>, body?: Record<string, unknown>) => Promise<{ status: number; text: string }> }> {
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
        ...over,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const post = async (headers: Record<string, string>, body?: Record<string, unknown>) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? { model: "claude-test", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
            duplex: "half",
        } as RequestInit);
        const text = await res.text();
        return { status: res.status, text };
    };
    return { proxy, post };
}

function freshState(): void {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
}

const ccHeadersFor = (id: string) => ({ "x-claude-code-session-id": id });
const mainBody = (hist: Msg[], system: string[] = MAIN_SYSTEM): Record<string, unknown> =>
    ({ model: "claude-test", stream: true, max_tokens: 1024, system: sysBlocks(system), messages: hist });

/** A subagent history whose FIRST user message carries the hook-injected token. */
function tokenedHistory(prefix: string, turns: number, token: string): Msg[] {
    const base = history(prefix, turns);
    const first = base[0];
    return [{ role: "user", content: [{ type: "text", text: `<system-reminder>${LANE_TOKEN_MARKER}${token}</system-reminder>` }, { type: "text", text: String(first.content) }] }, ...base.slice(1)];
}

test("#7714 end to end: rotating billing header keeps the subagent on ONE lane", async () => {
    freshState();
    const SESSION = randomUUID();
    const ccHeaders = ccHeadersFor(SESSION);
    const tok = mintClaudeLaneToken();
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        // Parent turns establish the raw-key session.
        for (let t = 1; t <= 2; t++) {
            const r = await post(ccHeaders, mainBody(history("main", t)));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const parent = peekSession(SESSION);
        assert.ok(parent, "parent session exists");
        assert.equal(parent.stats.requests, 2);

        // The billing-excluded lane key: persona only (billing dropped), token T.
        const laneKey = `${SESSION}|sub:${fp16(personaTag)}:t:${tok}`;

        // Subagent turn 1: billing A.
        const sysTurn1 = [BILLING_A, PERSONA_A, PERSONA_B];
        const s1 = await post(ccHeaders, mainBody(tokenedHistory("subA", 2, tok), sysTurn1));
        assert.equal(s1.status, 200, `subagent turn 1 (billing A): ${s1.text}`);
        assert.ok(peekSession(laneKey), "subagent turn 1 rides the billing-excluded lane");
        assert.equal(peekSession(laneKey)!.stats.requests, 1);

        // Subagent turn 2: billing B (rotated cch + cc_prev_msg), SAME persona, SAME token.
        const sysTurn2 = [BILLING_B, PERSONA_A, PERSONA_B];
        const s2 = await post(ccHeaders, mainBody(tokenedHistory("subA", 3, tok), sysTurn2));
        assert.equal(s2.status, 200, `subagent turn 2 (billing B): ${s2.text}`);
        assert.equal(peekSession(laneKey)!.stats.requests, 2, "billing rotation alone must NOT split the lane");

        // No stray session from the billing flip: parent + one lane = 2 total.
        assert.equal(_sessionsSizeForTest(), 2, "no extra session minted by the billing rotation");
        assert.equal(peekSession(SESSION), parent, "parent session object unchanged");
        assert.equal(parent.stats.requests, 2, "parent untouched by the subagent turns");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
