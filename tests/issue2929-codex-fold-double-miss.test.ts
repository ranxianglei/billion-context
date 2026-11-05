// #2929 repro probe: Type-A fold double-miss on the Responses wire (codex lane).
//
// Production signature (v0.1.195, session 01a12fbc…): when a fold happens INSIDE
// an acp-loop intra-turn re-request (model calls a proxy tool, then compress, in
// the same client turn — usage lines "round 2/3" + fold=new), the NEXT client
// turn matched only the system baseline (~instructions) instead of the folded
// prefix: the whole new post-fold prefix (25–45K tok) paid full price once.
// When the folded view rides the next client turn's normal forward (round 1 +
// fold=new), the next turn hits immediately and fully.
//
// This probe builds the production shape the #2733 harness does not cover:
// (a) the ephemeral nudge IS injected into the pre-fold request (nudge floor
// crossed before the fold), and (b) the fold round is preceded by a proxy-tool
// round (acp_status) within the same client turn. It then asserts the same
// byte-prefix invariant the #2733 fold-1 sanity pins: the post-fold re-request
// and the next steady client turn must share identical bytes up to and
// including the summary anchor. A divergence here IS the double-miss: the
// relay's radix cache cannot chain the fold-new prefix into the next turn.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

type Item = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const NUDGE_MARKER = "Compressible ranges (";
// Indices verified against the kernel's nudge gate with nudgeGrowthTokens=2000
// and ~9KiB filler turns. Pre-#4521 (master) the injections landed on
// requests {7,8,9}; since #4521 the armed-but-silent status line rides an
// ephemeral carrier on the gated turns and its shown-marker feeds the nudge
// gate back, so the schedule shifts to {4,6,8,9} — the fold/proxy-tool-round
// mechanics under test are unchanged, only this probe's anchor re-calibrates
// to the next nudge-carrying request pair (6 → tool round, 7 → fold round).
const PROXY_TOOL_AT = 6; // upstream request index whose response = acp_status call (round 1)
const FOLD_AT = 7;       // upstream request index whose response = compress call (round 2)
// FOLD_AT+1 = post-fold refreshed re-request (round 3); FOLD_AT+2 = next steady client turn.
const TOTAL_TURNS = 13;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function textSse(res: http.ServerResponse, id: string, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } }));
    res.write(sseBlock("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text }));
    res.write(sseBlock("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, content_index: 0, text }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } }));
    res.end();
}

function functionCallSse(res: http.ServerResponse, id: string, name: string, args: string, callId: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: callId, name, arguments: "", status: "in_progress" } }));
    res.write(sseBlock("response.function_call_arguments.delta", { item_id: `fc_${id}`, output_index: 0, delta: args }));
    res.write(sseBlock("response.function_call_arguments.done", { item_id: `fc_${id}`, output_index: 0, arguments: args }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: callId, name, arguments: args, status: "completed" } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "function_call", id: `fc_${id}`, call_id: callId, name, arguments: args, status: "completed" }] } }));
    res.end();
}

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions strictly.", "Run tests before finishing.", "Environment notes: linux, node 22, repo at /workspace."].join("\n") + "\n\n" + FILLER(999, 1);

const refsOf = (items: Item[]): string[] => {
    const refs: string[] = [];
    for (const it of items) {
        const s = JSON.stringify(it);
        for (const m of s.matchAll(/\x3cacp [^>]*>(m\d+)\x3c\/acp>/g)) refs.push(m[1]!);
    }
    return [...new Set(refs)];
};

const summaryIndices = (items: Item[]): number[] =>
    items.map((it, i) => (isSummaryItem(it) ? i : -1)).filter((i) => i >= 0);

const isSummaryItem = (it: Item | undefined): boolean =>
    !!it && it.type === "message"
    && ((typeof it.content === "string" ? it.content : JSON.stringify(it.content)) ?? "").includes(SUMMARY_MARKER);

const hasNudge = (items: Item[]): boolean =>
    items.some((it) => typeof it.content === "string" && it.content.includes(NUDGE_MARKER));

const firstDivergence = (a: Item[], b: Item[]): number => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    return n;
};

test("#2929: nudge + proxy-tool-round fold keeps re-request/next-turn byte-stable", { timeout: 180_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue2929-seam-"));
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;

    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const captured: Array<{ url: string; body: string }> = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const idx = captured.length;
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push({ url: req.url ?? "", body });
                if (idx === PROXY_TOOL_AT) {
                    // Round 1 of the fold turn: model asks for proxy status — the
                    // loop executes it locally and re-requests (round 2).
                    functionCallSse(res, `resp_${idx}`, "acp_status", "{}", `call_st_${idx}`);
                    return;
                }
                if (idx === FOLD_AT) {
                    const prev = (JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? [];
                    const uniq = refsOf(prev);
                    assert.ok(uniq.length >= 11, `fold round: expected >=11 tagged refs, saw ${uniq.length}`);
                    const args = JSON.stringify({ content: [
                        { startId: uniq[3]!, endId: uniq[5]!, topic: "F1A", summary: `F1A summary: ${FILLER(1, 1)}` },
                        { startId: uniq[6]!, endId: uniq[8]!, topic: "F1B", summary: `F1B summary: ${FILLER(2, 1)}` },
                    ] });
                    functionCallSse(res, `resp_${idx}`, "compress", args, `call_cmp_${idx}`);
                    return;
                }
                const parsed = JSON.parse(body) as { input?: Item[] };
                let label = "0";
                for (let i = (parsed.input ?? []).length - 1; i >= 0; i--) {
                    const it = parsed.input![i]!;
                    if (it.type === "message" && it.role === "user" && typeof it.content === "string") {
                        const m = (it.content as string).match(/Turn (\d+):/);
                        if (m) { label = m[1]!; break; }
                    }
                }
                textSse(res, `resp_${idx}`, `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 2000 },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
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
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

        const input: Item[] = [];
        for (let t = 0; t < TOTAL_TURNS; t++) {
            const userText = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 9);
            // Production shape: codex stamps native ids on EVERY input item
            // (log "first msg ids: x_82170752e0(211c), ..." — user items too).
            const userMsg: Item = { type: "message", id: `msg_u${t}`, role: "user", content: userText };
            const body = {
                model: "gpt-test",
                stream: true,
                instructions: INSTRUCTIONS,
                tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                input: [...input, userMsg],
            };
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "issue2929-seam" }, body: JSON.stringify(body) });
            if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                throw new Error(`turn ${t} failed HTTP ${res.status}: ${errBody.slice(0, 300)}`);
            }
            await res.text();
            input.push(userMsg);
            // Production shape: the thinking model's reasoning item rides the
            // client's persisted history back into every later turn (codex
            // persists encrypted_content verbatim).
            input.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
            const replyText = `Reply Turn ${t}: done. ` + FILLER(t, 0.2);
            input.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: replyText });
            if (t % 2 === 0) {
                input.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                input.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\ndrwxr-xr-x 2 u g 4096 Sep 27 10:00 .\n-rw-r--r-- 1 u g 4096 Sep 27 10:00 file-${t}.ts` });
            }
        }

        const inputs = captured.map((c) => (JSON.parse(c.body) as { input?: Item[] }).input ?? []);
        assert.ok(inputs.length >= FOLD_AT + 3, `expected >= ${FOLD_AT + 3} upstream requests, got ${inputs.length}`);

        // (0) Scenario materialization: the nudge must have been injected into
        // the PRE-FOLD original request (production shape: nudge armed -> model
        // calls proxy tool -> compress). Without it this probe does not cover
        // the #2929 trigger.
        assert.ok(hasNudge(inputs[PROXY_TOOL_AT]!), `scenario miss: no ephemeral nudge in the pre-fold request (inputs[${PROXY_TOOL_AT}]) — probe does not cover the production trigger; adjust nudgeGrowthTokens/filler`);
        console.log(`probe: nudge confirmed in pre-fold request; total upstream requests=${inputs.length}`);

        // (1) The post-fold re-request carries the in-place summary(s).
        const rPost = inputs[FOLD_AT + 1]!;
        const postSums = summaryIndices(rPost);
        assert.ok(postSums.length >= 1, "post-fold re-request must carry the in-place summary");

        // (2) THE invariant: next steady client turn shares identical bytes with
        // the post-fold re-request up to and including the summary anchor. In
        // production this is where the chain breaks (next turn hits only the
        // instructions baseline).
        const next = inputs[FOLD_AT + 2]!;
        const nextSums = summaryIndices(next);
        assert.ok(nextSums.length >= 1, `next steady turn lost the summary entirely (summaries: ${nextSums.length}) — fold did not survive to the client turn`);
        assert.equal(nextSums[0], postSums[0], `summary anchor drifted: re-request item[${postSums[0]}] vs next turn item[${nextSums[0]}]`);
        for (let i = 0; i <= nextSums[0]!; i++) {
            const a = rPost[i]; const b = next[i];
            assert.equal(JSON.stringify(b), JSON.stringify(a),
                `#2929 DOUBLE-MISS: next-turn item[${i}] diverges from post-fold re-request item[${i}] — re=${JSON.stringify(a)?.slice(0, 200)} next=${JSON.stringify(b)?.slice(0, 200)} (firstDivergence=${firstDivergence(rPost, next)})`);
        }
        console.log(`probe OK: summary anchored at item[${postSums[0]}]; re-request(${rPost.length} items) and next turn(${next.length} items) byte-identical through the anchor`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        rmrf(tmp);
    }
});
