// #2499: proxy-mode Anthropic round-2 rebuild dropped the CLIENT's own
// message-level cache_control breakpoints. The steady path returns them
// (`prepareAnthropic`: `anthropicCacheMarks ?? cacheControls`), but the
// compress-loop round-2 adapter only received `anthropicCacheMarks` — which is
// `undefined` for a client-managed session — so the rebuilt messages carried
// zero breakpoints. The post-fold prefix was never written to the prefix cache,
// so the very next request re-billed the whole history at the system head.
//
// Pinned here on the anthropic wire with one compress round-trip: the client
// marks its own trigger turn (and nothing else); the scripted upstream emits a
// `compress` tool_use over an EARLY range so the marked trigger turn survives
// the fold. Assertions target the SECOND upstream body (round 2).
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const anthropicSse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Enough distinct mass per message that the folded range clears the kernel's
// 5000-char minCompressRange floor (#402) and the compress actually commits.
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

// Seven single-block turns (u,a,u,a,u,a,user-trigger) → refs m00001..m00007.
// The compress folds m00001..m00002 — OUTSIDE the kernel's last-5 protected
// zone (m00003..m00007) — so it commits, while the marked trigger turn (m00007,
// the most recent user message) stays live and is what round-2 must re-stamp.
type TurnMsg = { role: string; content: Array<Record<string, unknown>> };
const buildTurns = (triggerText: string, cc?: unknown): TurnMsg[] => {
    const out: TurnMsg[] = [];
    // Each turn is ~8KB so the folded pair (m00001+m00002) clears the 5000-char
    // minCompressRange floor AND the trailing 5000-token protect window
    // (preserveRecentTokens) stays in the recent tail, leaving m00001..m00002
    // compressible while the trigger turn (most recent user msg) stays live.
    for (let i = 1; i <= 3; i++) {
        out.push({ role: "user", content: [{ type: "text", text: `user turn ${i}: examine subsystem ${i} and report every failure mode you can find in the current implementation. ` + FILLER(i, 8) }] });
        out.push({ role: "assistant", content: [{ type: "text", text: `assistant ${i}: subsystem ${i} shows three notable failure modes centered on state recovery under load. ` + FILLER(100 + i, 8) }] });
    }
    out.push({ role: "user", content: [{ type: "text", text: triggerText + " " + FILLER(900, 1.0), ...(cc ? { cache_control: cc } : {}) }] });
    return out;
};

function compressSse(startId: string, endId: string): string {
    const args = JSON.stringify({ startId, endId, topic: "fold", summary: "Folded the early subsystem-analysis turns; state-recovery failure modes and their remediation notes are retained in this summary." });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c_2499", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");
}

const TEXT_SSE = [
    anthropicSse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", usage: { input_tokens: 20 } } }),
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
    anthropicSse("message_stop", { type: "message_stop" }),
].join("");

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            // The client sends seven single-block turns → refs m00001..m00007.
            // Fold the first two (m00001..m00002); the marked trigger turn
            // (m00007, the most recent user message) survives the fold.
            const sse = call === 0 ? compressSse("m00001", "m00002") : TEXT_SSE;
            call += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        captured,
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

type Block = { type?: string; text?: string; cache_control?: unknown };
type Body = { system?: string | Block[]; messages: Array<{ role: string; content: string | Block[] }> };

const messageMarkedBlocks = (raw: string): Block[] => {
    const sent = JSON.parse(raw) as Body;
    const out: Block[] = [];
    for (const m of sent.messages) {
        const blocks = typeof m.content === "string" ? [{ text: m.content }] : m.content;
        for (const b of blocks) if (b.cache_control !== undefined) out.push(b);
    }
    return out;
};
const systemMarkCount = (raw: string): number => {
    const sent = JSON.parse(raw) as Body;
    return Array.isArray(sent.system) ? sent.system.filter((b) => b.cache_control !== undefined).length : 0;
};

test("#2499: client-managed caching — round-2 rebuild preserves the client's trigger-turn breakpoint verbatim", async () => {
    const h = await startHarness();
    try {
        const CC = { type: "ephemeral", ttl: "1h" };
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue2499-client-managed" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: buildTurns("TRIGGER_TURN_C: now patch the refresh-token rotation so a revoked token cannot mint a fresh one.", CC),
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.ok(h.captured.length >= 2, `expected a round-2 re-request, got ${h.captured.length} upstream bodies`);
        const r2 = h.captured[1]!;
        assert.ok(r2.includes("tokens saved"), "compress committed — the post-fold view actually reached upstream");

        const marked = messageMarkedBlocks(r2);
        assert.equal(marked.length, 1, `exactly ONE message-level breakpoint on round 2, got ${marked.length}`);
        assert.ok(marked[0]!.text?.includes("TRIGGER_TURN_C"), "the sole breakpoint sits on the client's trigger turn");
        assert.deepEqual(marked[0]!.cache_control, CC, "client's breakpoint value (incl. ttl) preserved byte-for-byte");
        assert.equal(systemMarkCount(r2), 0, "bili adds NO system breakpoint in a client-managed session");
    } finally {
        await h.close();
    }
});

test("#2499 control: bili-managed caching unaffected — round-2 still carries bili's own system + message breakpoints", async () => {
    const h = await startHarness();
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue2499-bili-managed" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: buildTurns("TRIGGER_TURN_C2: fix the proration rounding so monthly and annual plans reconcile."),
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.ok(h.captured.length >= 2, `expected a round-2 re-request, got ${h.captured.length} upstream bodies`);
        const r2 = h.captured[1]!;
        assert.equal(systemMarkCount(r2), 1, "bili-managed: the system breakpoint is stamped on round 2");
        assert.ok(messageMarkedBlocks(r2).length >= 1, "bili-managed: at least one message breakpoint survives onto round 2");
    } finally {
        await h.close();
    }
});
