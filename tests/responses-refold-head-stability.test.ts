// #2733 regression: fold-anchor stability across re-fold chains (codex path).
//
// Production signature (v0.1.188-192, issue #2733): after EVERY fold the next
// request matched only the immutable head (~11.1K tokens) — the fold rewrote
// bytes at the very first history slot. Root cause: when a fold consumes a
// prior block, collectSummaryAnchors (kernel/src/prune.ts) anchored the new
// merged summary at the EARLIEST id of the merged effectiveMessageIds — which
// reaches back through the consumption chain to its root (typically the
// pinned first user message's slot) — so every re-fold rewrote the same
// head-adjacent slot with fresh summary text, collapsing the provider prefix
// match to the head on every fold (the per-fold double penalty in #2741).
//
// Fix under test: anchor on the block's DIRECT range (directMessageIds) — the
// ids this fold itself covered — so the summary lands where the new content
// begins and the head stays byte-stable across re-fold chains.
//
// Discriminator: fold-1 covers the head ([m00001..u4]); fold-2 and fold-3
// each re-fold from the pinned m00001, consuming the previous block
// (chain-rooted at m00001). After the fix, the first history item of the
// post-fold views is the pinned first-user raw, identical across folds;
// pre-fix it churned (new summary text every fold, divergence at item 0).
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

type Item = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const FOLD1_AT = 6;  // head fold: [m00001 .. uniq[4]] — covers the pinned first user
const FOLD2_AT = 11; // chain re-fold from the pin: consumes fold-1's block
const FOLD3_AT = 16; // second chain re-fold: consumes fold-2's block
const TOTAL_TURNS = 20;

const FILLER = (seed: number, kb: number): string => {
    let x = (seed + 1) * 2654435761;
    const chunk = (): string => {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        return x.toString(36).padStart(6, "0");
    };
    return Array.from({ length: Math.max(1, Math.round(kb * 64)) }, chunk).join(" ");
};

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions strictly.", "Run tests before finishing.", "Environment notes: linux, node 22, repo at /workspace."].join("\n") + "\n\n" + FILLER(999, 1);

const refsOf = (items: Item[]): string[] => {
    const refs: string[] = [];
    for (const it of items) {
        // History items only: the injected developer message documents the
        // tag format with example refs (m00175) that must not be picked up.
        if (it.type === "message" && it.role === "developer") continue;
        const s = JSON.stringify(it);
        for (const m of s.matchAll(/\x3cacp [^>]*>(m\d+)\x3c\/acp>/g)) refs.push(m[1]!);
    }
    return [...new Set(refs)];
};

const firstDivergence = (a: Item[], b: Item[]): number => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    return n;
};

function textSse(res: http.ServerResponse, id: string, text: string): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: `msg_${id}` } })}\n\n`);
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: `msg_${id}`, content: [{ type: "output_text", text }] } })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 900 } } } })}\n\n`);
    res.end();
}

function compressCallSse(res: http.ServerResponse, id: string, args: string): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`);
    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "compress", call_id: `call_${id}`, id: `fc_${id}` } })}\n\n`);
    res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: `fc_${id}`, output_index: 0, delta: args })}\n\n`);
    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "compress", call_id: `call_${id}`, id: `fc_${id}`, arguments: args, status: "completed" } })}\n\n`);
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 900 } } } })}\n\n`);
    res.end();
}

test("#2733: chain re-folds keep the first history item byte-stable (direct-range anchoring)", { timeout: 180_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refold-head-"));
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
                const foldAt = (n: number, topic: string): void => {
                    const uniq = refsOf((JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? []);
                    assert.ok(uniq.length >= 5, `${topic}: expected >=5 tagged refs, saw ${uniq.length}`);
                    // Range rooted at the FIRST tagged message (uniq[0] = the
                    // pinned m00001) — the production geometry from the #2733
                    // log (session 01a1210e: foldPoint=m00001 folds, then chain
                    // re-folds rooted at the same pin). Pre-fix, anchoring such
                    // a block at index 0 splices its summary ahead of the pin.
                    const args = JSON.stringify({ content: [
                        { startId: uniq[0]!, endId: uniq[4]!, topic, summary: `${topic} summary: ${FILLER(idx, 1)}` },
                    ] });
                    compressCallSse(res, `resp_${idx}`, args);
                };
                if (idx === FOLD1_AT) return foldAt(idx, "HEAD1");
                if (idx === FOLD2_AT) return foldAt(idx, "CHAIN2");
                if (idx === FOLD3_AT) return foldAt(idx, "CHAIN3");
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
            const userText = `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6);
            const userMsg: Item = { type: "message", role: "user", content: userText };
            const body = {
                model: "gpt-test",
                stream: true,
                instructions: INSTRUCTIONS,
                tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                input: [...input, userMsg],
            };
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "refold-head-test" }, body: JSON.stringify(body) });
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
                input.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\ndrwxr-xr-x 2 u g 4096 Sep 27 10:00 .\n-rw-r--r-- 1 u g  42 Sep 27 10:00 file-${t}.ts` });
            }
        }

        const inputs = captured.map((c) => (JSON.parse(c.body) as { input?: Item[] }).input ?? []);
        assert.ok(inputs.length >= FOLD3_AT + 3, `expected >= ${FOLD3_AT + 3} upstream requests, got ${inputs.length}`);

        const isSummary = (it: Item | undefined): boolean => !!it && it.type === "message" && ((typeof it.content === "string" ? it.content : JSON.stringify(it.content))).includes(SUMMARY_MARKER);

        // Content-based selection: fold turns produce an extra loop re-request
        // (acp-loop round-2), so absolute indexes shift by one per fold. Find
        // every view that carries a rendered summary and assert the invariant
        // on each of them.
        const summaryViews = inputs
            .map((input, i) => ({ input, i }))
            .filter(({ input }) => input.some(isSummary));
        assert.ok(summaryViews.length >= 3, `expected >=3 summary-carrying views (fold-1/2/3), got ${summaryViews.length}`);

        // #2733 core invariant: in EVERY folded view the first history item
        // (input[1], right after the injected developer message) is the pinned
        // first user message — raw bytes, never a (re-anchored) summary. The
        // pin is the provider prefix-cache head; any fold or chain re-fold
        // that splices a summary ahead of it collapses the cached prefix.
        let pinBytes: string | undefined;
        for (const { input, i } of summaryViews) {
            const head = input[1];
            const serialized = JSON.stringify(head);
            assert.ok(!!head && !isSummary(head), `view ${i}: first history item must not be a fold summary (head churn = #2733 prefix collapse), saw: ${serialized.slice(0, 140)}`);
            assert.match(serialized, /m00001/, `view ${i}: first history item should be the pinned first user message carrying the m00001 tag, saw: ${serialized.slice(0, 140)}`);
            if (pinBytes === undefined) pinBytes = serialized;
            assert.equal(serialized, pinBytes, `view ${i}: pinned first user message changed bytes across folds (head churn = #2733 prefix collapse)`);
        }
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
