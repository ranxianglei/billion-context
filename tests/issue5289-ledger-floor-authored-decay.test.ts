// #5289: the dsh raw-ledger planning floor must follow reality on BOTH guard
// branches (#3617 — both directions of the gate pinned here).
//
// Authored branch (#3733 local answer): dsh records our folded snapshot and its
// raw store shrinks to it — so the floor := the EXACT bytes of the snapshot we
// sent, decaying below any earlier high-water. Pinning the floor to the
// pre-answer envelope peak instead starves small windows permanently (incident
// shape: 128K window − 93K stale floor − margin ≈ 33K max output while the
// folded wire sat at ~49K → long replies truncated at stop_reason=length until
// the user set DSH's window to 256K to dodge the clamp).
//
// Refusal branch: the #2490 sticky high-water over the exact envelope bytes
// stays byte-for-byte (while compaction stays refused the ledger never
// shrinks), and composing authored→refusal re-ratchets ON TOP of the decayed
// value (Math.max — never a reset).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { BILI_SNAPSHOT_TAG_PREFIX } from "../src/server/dsh-authored-compaction.ts";

const WINDOW = 131_072;
const SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// 24 messages × ~1.5k chars: under the window (no preflight); the default
// protection zone leaves m00001..m00008 foldable on the first turn (same shape
// as tests/dsh-authored-compaction.test.ts#conversation()).
function conversation(): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 24; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return out;
}

type Seen = { maxTokens: unknown };

type Harness = {
    url: string;
    seen: Seen[];
    sessionOf: (label: string) => { metadata: Record<string, unknown>; state: { blocks: { active: boolean }[] } } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    const seen: Seen[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { max_tokens?: unknown };
            seen.push({ maxTokens: parsed.max_tokens });
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (seen.length === 1) {
                // First egress: the model compresses the oldest span → active block.
                const args = JSON.stringify({ content: [{ startId: "m00001", endId: "m00008", topic: "setup", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done compressing" } }] }));
            }
            res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
    const h: Harness = {
        url: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        seen,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        delete process.env.BILI_DSH_AUTHORED_COMPACTION;
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

async function turn(h: Harness, label: string, body: string): Promise<{ status: number; body: string }> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body,
    });
    return { status: r.status ?? 0, body: await r.text() };
}

/** One normal turn that leaves an active block behind. */
async function armBlock(h: Harness, label: string): Promise<void> {
    const r = await turn(h, label, JSON.stringify({ model: "gpt-test", messages: conversation(), stream: true }));
    assert.equal(r.status, 200, r.body);
    const s = h.sessionOf(label);
    assert.ok(s, "session exists");
    assert.ok(s!.state.blocks.some((b) => b.active), "setup created an active block");
}

function compactionEnvelope(fillerChars: number): string {
    return JSON.stringify({
        model: "gpt-test",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "x".repeat(fillerChars) },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Condense the conversation above.` },
        ],
        stream: true,
    });
}

test("e2e: authored checkpoint decays the ledger floor to the snapshot sent (small window unstarves)", async () => {
    await withHarness(async (h) => {
        await armBlock(h, "s-decay");
        const before = h.seen.length;
        // ~372KB raw-history replay — the #5289 incident shape on a 128K window.
        const r = await turn(h, "s-decay", compactionEnvelope(372_000));
        assert.equal(r.status, 200, r.body);
        assert.ok(r.body.includes(BILI_SNAPSHOT_TAG_PREFIX), "answered locally with the bili snapshot");
        assert.equal(h.seen.length, before, "zero egress on the authored answer");
        const s = h.sessionOf("s-decay")!;
        assert.equal(s.metadata["dshCompactionRefusedBytes"], Buffer.byteLength(r.body), "floor := the exact snapshot bytes we sent, not the 372KB envelope peak");
        assert.ok(Buffer.byteLength(r.body) < 10_000, "sanity: the snapshot is orders of magnitude smaller than the envelope");

        // Next main turn on the shrunken store: a giant budget request (≥ 25% of
        // the window — the line that engages the ledger floor). Healthy planning
        // yields a full cap (>100K); a stale 93K peak would leave only ~33K.
        const r2 = await turn(h, "s-decay", JSON.stringify({
            model: "gpt-test",
            messages: [{ role: "user", content: "please write a very long detailed report, take your time" }],
            max_tokens: 384_000,
            stream: true,
        }));
        assert.equal(r2.status, 200, r2.body);
        const forwarded = h.seen[h.seen.length - 1].maxTokens;
        assert.equal(typeof forwarded, "number", "max_tokens present on the outbound request");
        assert.ok((forwarded as number) > 100_000, `outbound max_tokens ${String(forwarded)} is healthy (pre-fix it was ~33K, truncating long replies)`);
    });
});

test("e2e: refusal keeps the sticky high-water; authored→refusal composition re-ratchets", async () => {
    await withHarness(async (h) => {
        // Phase 1 — refusal (knob explicitly off; the default is ON): the #2490
        // high-water, byte-for-byte.
        process.env.BILI_DSH_AUTHORED_COMPACTION = "0";
        await armBlock(h, "s-compose");
        const env1 = compactionEnvelope(300_000);
        const r1 = await turn(h, "s-compose", env1);
        assert.equal(r1.status, 422, "refused, not forwarded");
        let s = h.sessionOf("s-compose")!;
        assert.equal(s.metadata["dshCompactionRefusedBytes"], Buffer.byteLength(env1), "refusal stamps the envelope's exact wire bytes");

        // Phase 2 — authored (knob back on): the floor DECAYS below the earlier
        // high-water to the snapshot we sent.
        process.env.BILI_DSH_AUTHORED_COMPACTION = "1";
        const r2 = await turn(h, "s-compose", compactionEnvelope(200_000));
        assert.equal(r2.status, 200, r2.body);
        assert.ok(r2.body.includes(BILI_SNAPSHOT_TAG_PREFIX));
        s = h.sessionOf("s-compose")!;
        assert.equal(s.metadata["dshCompactionRefusedBytes"], Buffer.byteLength(r2.body), "authored answer replaces the 300KB high-water with the snapshot scale");
        assert.ok(Buffer.byteLength(r2.body) < Buffer.byteLength(env1), "decayed below the prior high-water");

        // Phase 3 — refusal again (knob off): the ratchet applies ON TOP of the
        // decayed value (Math.max), never a reset.
        process.env.BILI_DSH_AUTHORED_COMPACTION = "0";
        const env3 = compactionEnvelope(400_000);
        const r3 = await turn(h, "s-compose", env3);
        assert.equal(r3.status, 422);
        s = h.sessionOf("s-compose")!;
        assert.equal(s.metadata["dshCompactionRefusedBytes"], Buffer.byteLength(env3), "later larger refusal re-ratchets above the decayed floor");
    });
});
