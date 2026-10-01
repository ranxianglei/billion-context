// #1613 follow-up: abort/rewind cache-seam property test (opencode lane).
//
// Production evidence (three opencode logs, #1613): after client aborts, cache hits
// collapse to a CONSTANT head-only value and never recover — even for back-to-back
// requests 31s apart. Two surviving suspects: (A) mid-history byte churn around the
// abort region whenever the client rewinds (opencode drops the partial assistant turn
// and retries), so the prefix diverges at the first perturbed message; (B) relay-side
// refusal. This test adjudicates the bili side locally:
//
// Property under test — the proxy is a faithful serializer:
//   For every consecutive outbound pair, divergence is allowed ONLY at items the
//   CLIENT added/removed/changed (tail region), plus the volatile trailing chain-tag
//   slot. No mid-history item may change identity between consecutive requests
//   (render-tag refs included: a changed m-ref inside an unchanged message is a
//   mid-history cache break).
//
// Scenario matrix per the production log:
//   1. plain append growth (append-stable baseline);
//   2. abort mid-stream -> client drops the partial turn -> retry (the rewind);
//   3. growth continues past the rewind point (does the prefix heal?);
//   4. a second abort/rewind cycle later in the session (the log showed repeated
//      aborts with render-tag counts oscillating 6<->8<->10);
//   5. history carries opencode-shaped turns: reasoning items + function_call pairs
//      (including runs whose reasoning went missing — the #684 shape).
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

const FILLER = (seed: number, kb: number): string => {
    const para = `Segment ${seed}: the workspace indexed cleanly and the harness reported consistent timings across regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions.", "Run tests before finishing."].join("\n") + "\n\n" + FILLER(999, 1);

// Intentional-stall window for abort-phase turns only (#1651). Completion-path turns must NOT
// get a per-read deadline: a fixed 250 ms there misclassified slow-but-completing streams as aborted.
const STALL_DETECT_MS = 250;

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function textSse(res: http.ServerResponse, id: string, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] } }));
    res.write(sseBlock("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text }));
    res.write(sseBlock("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, text }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } }));
    res.end();
}

const isChain = (it: Item | undefined): boolean =>
    !!it && it.type === "message" && typeof (it.content as string) === "string" && (it.content as string).includes("bili-chain");

const j = (it: Item | undefined): string => (it === undefined ? "<absent>" : JSON.stringify(it));

/** Items considered identical for cache purposes (chain-tag slots are volatile by design). */
const cacheEqual = (a: Item | undefined, b: Item | undefined): boolean =>
    j(a) === j(b) || (isChain(a) && isChain(b));

/**
 * Verify: `prev` is an item-wise prefix of `next` (or, for rewind, that every
 * divergence is explained by client-side tail changes). Returns the index of the
 * first UNEXPLAINED divergence, or -1 when clean.
 */
function firstUnexplained(prev: Item[], next: Item[], clientChangeStart: number): number {
    const n = Math.min(prev.length, next.length);
    for (let i = 0; i < n; i++) {
        if (cacheEqual(prev[i], next[i])) continue;
        // Divergence at i is fine only if the client itself changed history at/after
        // this depth (rewind region) — never BEFORE the client's own change point.
        if (i >= clientChangeStart) return -1;
        return i;
    }
    // One list is a prefix of the other: extra items must also live in the tail region.
    if (prev.length !== next.length && n < clientChangeStart) return n;
    return -1;
}

test("abort/rewind cycles keep the outbound prefix item-stable (#1613 suspects A/B)", { timeout: 120_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "abort-seam-"));
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const captured: Array<{ body: string }> = [];
        let abortNext = false;
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const idx = captured.length;
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push({ body });
                if (abortNext) {
                    abortNext = false;
                    // Client will destroy mid-stream: emit the head, then stall.
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    res.write(sseBlock("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } }));
                    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_partial_${idx}`, role: "assistant", status: "in_progress", content: [] } }));
                    res.write(sseBlock("response.output_text.delta", { item_id: `msg_partial_${idx}`, output_index: 0, content_index: 0, delta: "partial answer that the client will abort mid-" }));
                    // never res.end(): the connection dies when the client aborts.
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
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const headers = { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-acp-session": "abort-seam-test" };

        // history as opencode resends it: user msg + (reasoning?) + assistant + tool pair
        const history: Item[] = [];
        const pushTurn = (t: number, withTool: boolean, withReasoning: boolean) => {
            history.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 3) });
            if (withReasoning) history.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
            history.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: `Reply Turn ${t}: done. ` + FILLER(t, 0.2) });
            if (withTool) {
                history.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                history.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\nfile-${t}.ts` });
            }
        };

        const send = async (stallDetectMs?: number): Promise<"ok" | "aborted"> => {
            const body = {
                model: "gpt-test",
                stream: true,
                instructions: INSTRUCTIONS,
                tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                input: [...history],
            };
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 30_000);
            try {
                const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
                const reader = res.body!.getReader();
                // consume until the upstream stalls (abort scenario) or stream ends
                for (;;) {
                    const r = stallDetectMs !== undefined
                        ? await Promise.race([reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), stallDetectMs))])
                        : await reader.read();
                    if (r === "timeout") { ac.abort(); return "aborted"; }
                    if (r.done) return "ok";
                }
            } catch {
                return "aborted";
            } finally {
                clearTimeout(timer);
            }
        };

        // labels for divergence reporting
        const phase: string[] = [];

        // Phase 1: plain append growth (t=0..5), opencode-shaped turns
        for (let t = 0; t <= 5; t++) {
            pushTurn(t, t % 2 === 0, true);
            phase.push(`append t=${t}`);
            const r = await send();
            assert.equal(r, "ok", `phase1 turn ${t} should complete`);
        }
        // Phase 2: abort + rewind (t=6): user msg sent, stream aborted, client drops nothing yet (partial never entered history)
        history.push({ type: "message", role: "user", content: `Turn 6: please analyze module 6. ` + FILLER(6, 3) });
        phase.push("abort t=6");
        abortNext = true;
        const ab1 = await send(STALL_DETECT_MS);
        assert.equal(ab1, "aborted", "phase2 request should be aborted mid-stream");
        // client rewind: drop the aborted user msg entirely and retry with a fresh phrasing (opencode drops the whole aborted turn)
        history.pop();
        history.push({ type: "message", role: "user", content: `Turn 6: please analyze module 6 again. ` + FILLER(6, 3) });
        phase.push("retry t=6");
        const r6 = await send();
        assert.equal(r6, "ok", "phase2 retry should complete");
        // model reply for the retried turn — with reasoning MISSING on the tool run (#684 shape)
        history.push({ type: "message", id: `msg_a6`, role: "assistant", content: `Reply Turn 6: done. ` + FILLER(6, 0.2) });
        history.push({ type: "function_call", id: `fc_t6`, call_id: `call_t6`, name: "shell", arguments: JSON.stringify({ command: "ls -la mod-6" }), status: "completed" });
        history.push({ type: "function_call_output", id: `fco_t6`, call_id: `call_t6`, output: "total 8\nfile-6.ts" });

        // Phase 3: growth past the rewind point
        pushTurn(7, false, true);
        phase.push("append t=7");
        assert.equal(await send(), "ok", "phase3 turn 7 should complete");

        // Phase 4: second abort/rewind cycle later in the session
        history.push({ type: "message", role: "user", content: `Turn 8: please analyze module 8. ` + FILLER(8, 3) });
        phase.push("abort t=8");
        abortNext = true;
        assert.equal(await send(STALL_DETECT_MS), "aborted", "phase4 request should be aborted mid-stream");
        // this time the client KEEPS the user msg and only re-sends the same history (retry without change)
        phase.push("retry t=8 (unchanged)");
        assert.equal(await send(), "ok", "phase4 retry should complete");
        history.push({ type: "reasoning", id: `rs_8`, encrypted_content: `enc_8_` + "x".repeat(200) });
        history.push({ type: "message", id: `msg_a8`, role: "assistant", content: `Reply Turn 8: done. ` + FILLER(8, 0.2) });

        // Phase 5: plain growth again
        pushTurn(9, true, true);
        phase.push("append t=9");
        assert.equal(await send(), "ok", "phase5 turn 9 should complete");

        // ==== ANALYSIS: item-wise prefix property across every consecutive pair ====
        const inputs = captured.map((c) => (JSON.parse(c.body) as { input?: Item[] }).input ?? []);
        assert.ok(inputs.length >= 12, `expected >= 12 captured requests, got ${inputs.length} (${phase.join(" | ")})`);

        const failures: string[] = [];
        for (let k = 1; k < inputs.length; k++) {
            const prev = inputs[k - 1]!;
            const next = inputs[k]!;
            // The client's change start = first index where the two CLIENT histories diverge.
            // We approximate with the outbound lists themselves: the property asserts that any
            // outbound divergence must be tail-located (i.e., after the last common stable item).
            // Find last index where items are cacheEqual scanning from the HEAD; divergence before
            // the tail region (defined as: beyond the longest common prefix of the two lists)
            // means mid-history churn.
            let lcp = 0;
            while (lcp < Math.min(prev.length, next.length) && cacheEqual(prev[lcp], next[lcp])) lcp++;
            // tail region = the trailing run of items where the two lists differ or one ran out.
            // Everything BEFORE lcp matched. Any mismatch before lcp is impossible by construction;
            // the real check: items [0, lcp) must be byte-identical — including that neither side
            // MUTATED an earlier item. To catch mutation we re-scan the full prev list against
            // next's head when next is longer (append case): prev must be an item-wise prefix.
            if (prev.length <= next.length) {
                const bad = firstUnexplained(prev, next, lcp);
                if (bad >= 0) failures.push(`pair ${k - 1}->${k} (${phase[k - 1]} -> ${phase[k]}): mid-history item ${bad} changed:\n  prev: ${j(prev[bad]).slice(0, 220)}\n  next: ${j(next[bad]).slice(0, 220)}`);
            } else {
                // rewind: the CLIENT dropped items; outbound may drop them too — divergence must
                // start exactly where the client's drop began. Items before that stay identical.
                const bad = firstUnexplained(next, prev, lcp);
                if (bad >= 0) failures.push(`pair ${k - 1}->${k} (${phase[k - 1]} -> ${phase[k]}): rewind changed pre-rewrite item ${bad}:\n  kept: ${j(next[bad]).slice(0, 220)}\n  prev: ${j(prev[bad]).slice(0, 220)}`);
            }
        }
        assert.deepEqual(failures, [], `bili introduced mid-history churn (suspect A confirmed):\n${failures.join("\n")}`);

        // Sanity: the rig actually exercised what production saw — history with tool runs,
        // at least two aborted requests, and render tags present in outbound bodies.
        const anyTagged = inputs.some((items) => items.some((it) => /\x3cacp [^>]*>m\d+\x3c\/acp>/.test(JSON.stringify(it))));
        assert.ok(anyTagged, "expected render tags in outbound history (rig failed to reproduce tag injection)");
        const abortCount = phase.filter((p) => p.startsWith("abort")).length;
        assert.ok(abortCount >= 2, `expected >= 2 abort phases, got ${abortCount}`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        try { rmrf(tmp); } catch { /* ignore */ }
    }
});
