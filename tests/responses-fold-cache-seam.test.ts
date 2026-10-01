// #1548 regression: post-fold byte-prefix seam on the Responses wire (codex path).
// When the proxy executes a compress call, the round-2 re-request view is rebuilt by
// refreshFolded: the kernel injects the in-place acp_summary at the fold anchor, the
// ephemeral acp_loop_* tool pair rides on top, and stripKernelSummaries used to judge
// carrier presence against the COMBINED list — so the ephemeral pair made it drop the
// in-place summary for exactly one request. Proxy-mode clients never echo the pair
// (adapters buffer-to-finish; the client only ever sees the final round), so the NEXT
// client turn re-inserts the summary at the anchor and the upstream longest-prefix
// match collapses to the stable head (observed production floor: constant ~16.5K cached
// tokens after every fold instead of ~95%). The assertions below pin:
//   1. the round-2 re-request body CONTAINS the in-place summary (carrier survives);
//   2. the next client turn's input is byte-identical to the round-2 input through the
//      summary anchor (the cacheable region extends past the fold, not just the head);
//   3. ordinary growth stays append-stable (modulo the volatile trailing chain tag) —
//      guarding the fix against reintroducing mid-history churn.
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
const COMPRESS_AT = 6;
const TOTAL_TURNS = 9;

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
    res.write(sseBlock("response.output_text.done", { item_id: `msg_${id}`, output_index: 0, text }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } }));
    res.end();
}

function compressCallSse(res: http.ServerResponse, id: string, args: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id, status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: "", status: "in_progress" } }));
    res.write(sseBlock("response.function_call_arguments.delta", { item_id: `fc_${id}`, output_index: 0, delta: args }));
    res.write(sseBlock("response.function_call_arguments.done", { item_id: `fc_${id}`, output_index: 0, arguments: args }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: args, status: "completed" } }));
    res.write(sseBlock("response.completed", { response: { id, status: "completed", output: [{ type: "function_call", id: `fc_${id}`, call_id: `call_cmp_${id}`, name: "compress", arguments: args, status: "completed" }] } }));
    res.end();
}

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions strictly.", "Run tests before finishing.", "Environment notes: linux, node 22, repo at /workspace."].join("\n") + "\n\n" + FILLER(999, 1);

const isChain = (it: Item | undefined): boolean =>
    !!it && it.type === "message" && typeof (it.content as string) === "string" && (it.content as string).includes("bili-chain");

const findSummaryIndex = (items: Item[]): number =>
    items.findIndex((it) => it.type === "message" && typeof it.content === "string" && (it.content as string).includes(SUMMARY_MARKER));

const sameItem = (a: Item | undefined, b: Item | undefined): boolean =>
    JSON.stringify(a) === JSON.stringify(b) || (isChain(a) && isChain(b));

test("#1548: post-fold re-request keeps the in-place summary; next-turn prefix survives past the anchor", { timeout: 90_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fold-seam-"));
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
                if (idx === COMPRESS_AT) {
                    const prev = JSON.parse(captured[idx - 1]!.body) as { input?: Item[] };
                    const refs: string[] = [];
                    for (const it of prev.input ?? []) {
                        const s = JSON.stringify(it);
                        for (const m of s.matchAll(/\x3cacp [^>]*>(m\d+)\x3c\/acp>/g)) refs.push(m[1]!);
                    }
                    const uniq = [...new Set(refs)];
                    assert.ok(uniq.length >= 8, `expected tagged refs in outbound history, saw: ${uniq.join(",")}`);
                    const start = uniq[2]!;
                    const end = uniq[uniq.length - 6]!;
                    const args = JSON.stringify({ content: [{ startId: start, endId: end, topic: "seam fold", summary: "Seam fold summary: early turns built the pipeline and ran the test suite; all green." }] });
                    compressCallSse(res, `resp_${idx}`, args);
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

        const input: Item[] = [];
        for (let t = 0; t < TOTAL_TURNS; t++) {
            const userText = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6);
            const userMsg: Item = { type: "message", role: "user", content: userText };
            const body = {
                model: "gpt-test",
                stream: true,
                instructions: INSTRUCTIONS,
                tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                input: [...input, userMsg],
            };
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "fold-seam-test" }, body: JSON.stringify(body) });
            if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                throw new Error(`turn ${t} failed HTTP ${res.status}: ${errBody.slice(0, 300)}`);
            }
            await res.text();
            input.push(userMsg);
            input.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: `enc_${t}_` + "x".repeat(200) });
            const replyText = `Reply Turn ${t}: done. ` + FILLER(t, 0.2);
            input.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: replyText });
            if (t % 2 === 0) {
                input.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                input.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\ndrwxr-xr-x 2 u g 4096 Sep 27 10:00 .\n-rw-r--r-- 1 u g   42 Sep 27 10:00 file-${t}.ts` });
            }
        }

        const inputs = captured.map((c) => (JSON.parse(c.body) as { input?: Item[] }).input ?? []);
        assert.ok(inputs.length >= COMPRESS_AT + 3, `expected >= ${COMPRESS_AT + 3} upstream requests, got ${inputs.length}`);

        const r2Idx = inputs.findIndex((items) => items.some((it) => it.type === "function_call" && it.name === "compress"));
        assert.ok(r2Idx > 0, "round-2 re-request (carrying the compress function_call) never reached upstream");
        const r2 = inputs[r2Idx]!;
        const next = inputs[r2Idx + 1]!;
        const preFold = inputs[r2Idx - 1]!;

        const fc = r2.find((it) => it.type === "function_call" && it.name === "compress")!;
        const callId = fc.call_id as string;
        assert.ok(r2.some((it) => it.type === "function_call_output" && it.call_id === callId), "round-2 body must carry the compress receipt");

        // 1. The in-place summary survives in the round-2 re-request.
        const sR2 = findSummaryIndex(r2);
        assert.ok(sR2 >= 0, "REGRESSION(#1548): round-2 re-request lost the in-place acp_summary — the ephemeral tool pair made stripKernelSummaries drop the only cross-turn carrier");
        assert.ok(!preFold.some((it) => typeof it.content === "string" && (it.content as string).includes(SUMMARY_MARKER)), "pre-fold body unexpectedly already carried a summary");

        // 2. Next client turn: byte-identical through the summary anchor.
        const sNext = findSummaryIndex(next);
        assert.ok(sNext >= 0, "next client turn lost the in-place summary entirely");
        assert.equal(JSON.stringify(r2[sR2]), JSON.stringify(next[sNext]), "summary bytes must be identical in round-2 and next turn");
        assert.equal(sR2, sNext, "summary anchor position must be identical in round-2 and next turn");
        for (let i = 0; i <= sNext; i++) {
            assert.equal(JSON.stringify(r2[i]), JSON.stringify(next[i]), `item[${i}] diverges between round-2 and next turn — upstream cache match collapses at item[${i}]`);
        }
        assert.ok(next.length > sNext + 1, "next turn must append new content after the anchor");

        // 3. Ordinary growth stays append-stable (chain tag is the only volatile slot).
        const checkAppendStable = (a: Item[], b: Item[], label: string): void => {
            const aLen = a.length - (isChain(a[a.length - 1]) ? 1 : 0);
            assert.ok(b.length >= aLen, `${label}: shrank unexpectedly (${a.length} -> ${b.length})`);
            for (let i = 0; i < aLen; i++) {
                assert.ok(sameItem(a[i], b[i]), `${label}: item[${i}] mutated during plain growth`);
            }
        };
        for (let i = 1; i < r2Idx; i++) {
            checkAppendStable(inputs[i - 1]!, inputs[i]!, `growth req#${i - 1}->req#${i}`);
        }
        checkAppendStable(next, inputs[r2Idx + 2]!, `post-fold req#${r2Idx + 1}->req#${r2Idx + 2}`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        rmrf(tmp);
    }
});
