/**
 * #5293: pressing Esc mid-stream in pi persists the partial assistant
 * message (pi's agent-loop appends the interrupted message to the transcript) and the
 * continuation turn resends it — but the interrupted turn never reports usage for that
 * output. The next usage-grade reading jumps by exactly the unreported partial, and the
 * flat-growth nudge cadence counts it as organic growth, so a "compress now" nudge lands
 * right on the user's redirect continuation (esc → continue → immediate compression
 * injection).
 *
 * Fix under test: host-side event-driven re-anchor (src/session.ts). The plugin pipes
 * stamp session.transient.abortReanchor on client abort (noteAbortedTurn); the first
 * prepare decision whose meter has moved past the pre-abort anchor re-anchors the
 * low-water growth reference to the current reading (absorbAbortedTurnGrowth). No kernel
 * change.
 *
 * Scenario (deterministic sizes; token model = ceil(chars/4), matching the mock's
 * reported input_tokens):
 *   r1 warmup        baseline stamped (low-water rule)
 *   r2 small growth  below the ready gate → no nudge
 *   r3 ABORT         partial streamed, then stall; client aborts; anchor stamped
 *   r4 resume        meter == anchor → flag survives; growth mass-blocked → no nudge
 *   r5 debt turn     meter jumps past anchor → absorb fires → growth 0 → NO nudge (core)
 *                    (without the fix THIS turn injects the nudge — the reported bug)
 *   r6 organic       below the gate again → no nudge
 *   r7 organic       a full fresh interval grown → nudge present (negative direction)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { ProxyOptions } from "../src/server.ts";

// XDG isolation BEFORE any server-module import (module-top code runs after import
// hoisting, so every bili import below is dynamic).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-e2e-abort-nudge-"));
process.env.XDG_STATE_HOME = path.join(tmpRoot, "state");
process.env.XDG_CACHE_HOME = path.join(tmpRoot, "cache");
process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "config");
delete process.env.ACP_DUMP_BODY;

const LIMIT = 200_000;
const MODEL = "claude-test";
// step = 4000 → ready gate = max(minGrowthFloor 100, minGrowthRatio 0.1 × 4000) = 400;
// tier-1 mass gate = tierGrowthTokens.t1 = 600 tokens; minCompressRange default 5000 chars.

const filler = (seed: number, chars: number): string => {
    const words = ["context", "compression", "session", "anchor", "baseline", "growth", "interval", "meter"];
    let out = "";
    let i = 0;
    while (out.length < chars) {
        out += `${words[(i + seed) % words.length]}-${seed}-${i} `;
        i += 1;
    }
    return out.slice(0, chars);
};

const SYSTEM = "You are a helpful coding assistant. Keep answers concise.\n" + filler(999, 800);
const COMPRESS_TOOL = {
    name: "compress",
    description: "Compress a range of conversation into a detailed summary.",
    input_schema: { type: "object", properties: { topic: { type: "string" }, content: { type: "string" } }, required: ["content"] },
};
// Real pi main turns carry the host's action tools alongside bili's ACP tools. A
// request whose ENTIRE tools array is bili's own set is demoted to the side lane
// (#1897 leak shape: "an agent turn needs a world to act in") — these keep the
// scenario on the main pipeline.
const HOST_TOOLS = [
    { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];
const TOOLS = [...HOST_TOOLS, COMPRESS_TOOL];

type Msg = { role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> };
const um = (n: number, len: number): Msg => ({ role: "user", content: [{ type: "text", text: `Task ${n}:\n${filler(n, len)}` }] });
const am = (n: number, len: number): Msg => ({ role: "assistant", content: [{ type: "text", text: `Step ${n} done.\n${filler(n + 20, len)}` }] });
// Sizes (chars): u1=800, a1=3598, small user=700 (175 tok), small assistant=260 (65 tok),
// abort partial=1200 (300 tok). Small-turn growth = 240 < 400 gate; two small turns = 480 ≥ 400.
const U_BIG = 792, A_BIG = 3585, U_SMALL = 692, A_SMALL = 247, PARTIAL = 1200;

const estTok = (s: string) => Math.ceil(s.length / 4);
const msgChars = (m: { content: unknown }): number => {
    const c = m.content;
    if (typeof c === "string") return c.length;
    if (Array.isArray(c)) return c.reduce((n: number, p) => n + (typeof (p as { text?: unknown })?.text === "string" ? ((p as { text: string }).text).length : 0), 0);
    return 0;
};

test("#5293 unit: noteAbortedTurn / absorbAbortedTurnGrowth edge cases", async () => {
    const { createSession, noteAbortedTurn, absorbAbortedTurnGrowth, ABORT_REANCHOR_MAX_AGE_MS } = await import("../src/session.ts");

    const s0 = createSession("u-skip");
    noteAbortedTurn(s0);
    assert.equal(s0.transient?.abortReanchor, undefined, "zero meter carries no information — no stamp");
    s0.stats.lastInputTokens = Number.NaN;
    noteAbortedTurn(s0);
    assert.equal(s0.transient?.abortReanchor, undefined, "non-finite meter — no stamp");

    const s1 = createSession("u-stamp");
    s1.stats.lastInputTokens = 42_000;
    noteAbortedTurn(s1);
    assert.equal(s1.transient?.abortReanchor?.anchor, 42_000, "stamp records the pre-abort anchor");

    const s2 = createSession("u-noop");
    s2.state.nudge.lastPerMessageNudgeTokens = 1000;
    absorbAbortedTurnGrowth(s2, 5000);
    assert.equal(s2.state.nudge.lastPerMessageNudgeTokens, 1000, "no flag — byte-identical decisions");

    const s3 = createSession("u-wait");
    s3.stats.lastInputTokens = 42_000;
    noteAbortedTurn(s3);
    s3.state.nudge.lastPerMessageNudgeTokens = 40_000;
    absorbAbortedTurnGrowth(s3, 42_000);
    assert.ok(s3.transient?.abortReanchor, "meter at the anchor — the partial is not measured yet, flag waits");
    assert.equal(s3.state.nudge.lastPerMessageNudgeTokens, 40_000);

    const s4 = createSession("u-absorb");
    s4.stats.lastInputTokens = 42_000;
    noteAbortedTurn(s4);
    s4.state.nudge.lastPerMessageNudgeTokens = 40_000;
    s4.state.nudge.lastNudgeShownTokens = 41_000;
    s4.state.nudge.lastShownByTier = { 1: 41_000 };
    absorbAbortedTurnGrowth(s4, 43_000);
    assert.equal(s4.transient?.abortReanchor, undefined, "consumed");
    assert.equal(s4.state.nudge.lastPerMessageNudgeTokens, 43_000, "reference re-anchored to the current reading");
    assert.equal(s4.state.nudge.lastNudgeShownTokens, 0, "pending nudge died with its turn");
    assert.deepEqual(s4.state.nudge.lastShownByTier, {}, "tier cadence stamps cleared");

    const s5 = createSession("u-max");
    s5.stats.lastInputTokens = 42_000;
    noteAbortedTurn(s5);
    s5.state.nudge.lastPerMessageNudgeTokens = 45_000;
    absorbAbortedTurnGrowth(s5, 43_000);
    assert.equal(s5.state.nudge.lastPerMessageNudgeTokens, 45_000, "never lowers an existing higher reference");

    const s6 = createSession("u-stale");
    s6.transient = { abortReanchor: { anchor: 42_000, at: Date.now() - ABORT_REANCHOR_MAX_AGE_MS - 60_000 } };
    s6.state.nudge.lastPerMessageNudgeTokens = 40_000;
    absorbAbortedTurnGrowth(s6, 50_000);
    assert.equal(s6.transient?.abortReanchor, undefined, "stale flag dropped");
    assert.equal(s6.state.nudge.lastPerMessageNudgeTokens, 40_000, "...without touching state");
});

test("#5293: esc-interrupted output is absorbed, not nudged, on the resume turn", { timeout: 120_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { setLogCapture } = await import("../src/logger.ts");
    const { rmrf } = await import("./tmp-rm.ts");

    const logLines: string[] = [];
    setLogCapture((_level: string, msg: string) => { logLines.push(msg); });
    const absorbCount = () => logLines.filter((l) => l.includes("aborted-turn growth absorbed")).length;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const bodies: string[] = [];
        const replies: Record<number, string> = { 0: am(1, A_BIG).content[0].text, 1: am(2, A_SMALL).content[0].text, 3: am(4, A_SMALL).content[0].text, 4: am(5, A_SMALL).content[0].text, 5: am(6, A_SMALL).content[0].text, 6: am(7, A_SMALL).content[0].text };
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const idx = bodies.length;
                const body = Buffer.concat(chunks).toString("utf8");
                bodies.push(body);
                const parsed = JSON.parse(body) as { messages?: Array<{ content: unknown }> };
                const inputTokens = estTok(SYSTEM) + estTok(JSON.stringify((parsed as { tools?: unknown }).tools ?? [])) + (parsed.messages ?? []).reduce((n, m) => n + Math.ceil(msgChars(m) / 4), 0);
                const sse = (ev: string, data: object) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                sse("message_start", { type: "message_start", message: { id: `msg-${idx}`, role: "assistant", model: MODEL, content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } });
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                if (idx === 2) {
                    // Abort turn: stream the partial in quick chunks, then stall forever.
                    const partial = filler(90, PARTIAL);
                    for (let i = 0; i < partial.length; i += 200) {
                        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partial.slice(i, i + 200) } });
                    }
                    return;
                }
                const reply = replies[idx] ?? "ok";
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
                sse("content_block_stop", { type: "content_block_stop", index: 0 });
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(reply.length / 4) } });
                sse("message_stop", { type: "message_stop" });
                res.end();
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: LIMIT } } } } as ProxyOptions["routes"],
            modelContextLimit: LIMIT,
            kernelConfig: defaultConfig(LIMIT),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
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
        };
        const baseKernel = defaultConfig(LIMIT, { preserveRecentMessages: 3, preserveRecentTokens: 800 });
        opts.kernelConfig = { ...baseKernel, nudge: { ...baseKernel.nudge, growthFloor: 4000, growthCap: 4000, minGrowthFloor: 100, minGrowthRatio: 0.1, tierGrowthTokens: { t1: 600 } } };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": "conv-5293" };
        const send = (msgs: Msg[]) => JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, system: SYSTEM, messages: msgs, tools: TOOLS });

        const post = async (msgs: Msg[]): Promise<void> => {
            const res = await fetch(url, { method: "POST", headers, body: send(msgs) });
            assert.ok(res.ok, `request failed: HTTP ${res.status}`);
            await res.text();
        };
        // Stream until silence (the mock stalls on the abort turn), then abort — pi's Esc.
        const postAborted = async (msgs: Msg[]): Promise<string> => {
            const ac = new AbortController();
            const res = await fetch(url, { method: "POST", headers, body: send(msgs), signal: ac.signal });
            assert.ok(res.ok && res.body, "aborted request must start streaming");
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let wire = "";
            for (;;) {
                const chunk = await Promise.race([
                    reader.read(),
                    new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 300)),
                ]);
                if (chunk.value) wire += dec.decode(chunk.value, { stream: true });
                if (chunk.done) break;
            }
            try { ac.abort(); } catch { /* already settled */ }
            let out = "";
            for (const line of wire.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try {
                    const d = JSON.parse(line.slice(6)) as { type?: string; delta?: { type?: string; text?: string } };
                    if (d.type === "content_block_delta" && d.delta?.type === "text_delta") out += d.delta.text ?? "";
                } catch { /* incomplete trailing line */ }
            }
            return out;
        };

        // pi persists the aborted partial message and resends history on every turn.
        const H: Msg[] = [];
        // r1: warmup — the low-water baseline gets stamped.
        await post([um(1, U_BIG)]);
        H.push(um(1, U_BIG), am(1, A_BIG));
        // r2: small organic growth — below the ready gate.
        await post([...H, um(2, U_SMALL)]);
        H.push(um(2, U_SMALL), am(2, A_SMALL));
        // r3: the user presses Esc mid-stream.
        const partial = await postAborted([...H, um(3, U_SMALL)]);
        assert.ok(partial.length > 500, `client received a meaningful partial before aborting (got ${partial.length} chars)`);
        H.push(um(3, U_SMALL), { role: "assistant", content: [{ type: "text", text: partial }] });
        // r4: redirect continuation — the meter still reads the pre-abort anchor, so the
        // flag survives this decision (nothing new is measurable yet).
        await post([...H, um(4, U_SMALL)]);
        H.push(um(4, U_SMALL), am(4, A_SMALL));
        assert.equal(absorbCount(), 0, "resume turn: meter at the pre-abort anchor — the flag must wait one more decision");
        // r5: the debt turn — the persisted partial shows up in the measurement.
        await post([...H, um(5, U_SMALL)]);
        H.push(um(5, U_SMALL), am(5, A_SMALL));
        // r6/r7: two more organic intervals.
        await post([...H, um(6, U_SMALL)]);
        H.push(um(6, U_SMALL), am(6, A_SMALL));
        await post([...H, um(7, U_SMALL)]);

        assert.equal(bodies.length, 7, "seven requests reached the upstream");
        const hasNudge = (i: number) => bodies[i]!.includes("efficiency nudge");
        for (const i of [0, 1, 2, 3]) assert.ok(!hasNudge(i), `request ${i + 1}: unexpected nudge`);
        assert.ok(!hasNudge(4), "debt turn must NOT nudge — the aborted output was absorbed into the reference (#5293)");
        assert.ok(!hasNudge(5), "one organic interval below the flat step — no nudge yet");
        assert.ok(hasNudge(6), "a full fresh interval of organic growth must still nudge (negative direction)");
        assert.equal(absorbCount(), 1, "absorb fires exactly once, on the debt turn");
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        try { rmrf(tmpRoot); } catch { /* ignore */ }
    }
});
