// #1592 regression: proxy-mode fold round-2 must render the post-fold history
// in EXACTLY the shape the next client turn renders it. The bug: the loop's
// refreshFolded unconditionally ran repairResponsesAssistantOrdering — a
// Responses-wire run-rule fix (#564) — on every wire, so chat round-2s carried
// acp_turn_sep_* user separators and split assistant runs that the steady chat
// path never emits. dsh (DeepSeek chat wire, reasoning_content + tool_calls,
// folds every few turns) saw every fold break the byte prefix mid-history —
// only the system-prompt head kept hitting (15-20% observed).
//
// Pinned here on the chat wire with the dsh turn shape:
//   1. at least TWO folds happen (multi-fold coverage);
//   2. NO request body ever carries the run separator text — the chat wire
//      has no run concept, steady or folded;
//   3. any consecutive-body divergence below the plain-growth floor must sit
//      INSIDE the fold-summary element (the covering-range text swap) — never
//      before it and never in a later message.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};
const SUMMARY_MARKER = "[Compressed conversation section]";
const SEPARATOR_TEXT = "exchange between these two assistant turns was compressed";
const captured: string[] = [];

let firstViewRefs: string[] | undefined;
let sinceDemand = 99;
let lastDemandBytes = Infinity;
let folds = 0;
const parseRefIds = (body: string): string[] => {
    const ids: string[] = []; const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g; let m;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
};
const triggerShould = (body: string): boolean => {
    const bytes = Buffer.byteLength(body); const refs = parseRefIds(body);
    if (firstViewRefs === undefined && refs.length >= 12) firstViewRefs = refs;
    const noShrinkAfterDemand = sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9;
    if (bytes > 40 * 1024 && refs.length >= 12 && !noShrinkAfterDemand) { lastDemandBytes = bytes; sinceDemand = 0; folds++; return true; }
    sinceDemand++;
    return false;
};
const triggerArgs = (): string => {
    const refs = parseRefIds(captured[captured.length - 1]!);
    const view = firstViewRefs ?? refs;
    const start = view[2]!; const end = refs[refs.length - 6]!;
    return JSON.stringify({ content: [{ startId: start, endId: end, topic: "hunt fold", summary: `Fold summary covering ${start}..${end}: turns exercised the pipeline, builds stayed green.` }] });
};

test("#1592 chat fold round-2 renders the next turn's shape (no run separators, divergence only at the summary anchor)", async () => {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            let label = "0"; const re = /Turn (\d+):/g; let m;
            while ((m = re.exec(body)) !== null) label = m[1]!;
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            const compressArgs = triggerShould(body) ? triggerArgs() : undefined;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const line = (o: unknown): void => res.write(`data: ${JSON.stringify(o)}\n\n`);
            if (compressArgs !== undefined) {
                line({ id: `c_${captured.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${folds}`, type: "function", function: { name: "compress", arguments: compressArgs } }] } }] });
                line({ id: `c_${captured.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
            } else {
                line({ id: `c_${captured.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                line({ id: `c_${captured.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({} as never);
    const ctx = 60 * 1024;
    const server = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upPort}`]: { models: { "deepseek-test": { context: ctx } } } },
        modelContextLimit: ctx, kernelConfig: defaultConfig(ctx),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as never as ProxyOptions);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;

    // dsh-shaped session: reasoning_content + tool_calls + BIG tool outputs
    type TurnMsg = Record<string, unknown>;
    const hist: TurnMsg[] = [{ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly. " + FILLER(1, 7) }];
    const sessionId = "fold-round2-shape";
    const extractReply = (raw: string): string => {
        let out = "";
        for (const line of raw.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6);
            if (d === "[DONE]") continue;
            try { const j = JSON.parse(d) as { choices?: Array<{ delta?: { content?: unknown } }> }; const c = j.choices?.[0]?.delta?.content; if (typeof c === "string") out += c; } catch { /* skip */ }
        }
        return out;
    };
    try {
        for (let t = 1; t <= 24; t++) {
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 5) });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model: "deepseek-test", stream: true, messages: [...hist] }) });
            if (!res.ok) throw new Error(`turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            const raw = await res.text();
            const reply = extractReply(raw);
            if (reply.length === 0) throw new Error(`turn ${t}: empty reply`);
            hist.push({ role: "assistant", content: reply, reasoning_content: `Thought for turn ${t}: inspect module, run checks, summarize findings. ` + FILLER(100 + t, 0.3) });
            hist.push({ role: "assistant", content: null, reasoning_content: `Plan for turn ${t}.`, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }) } }] });
            hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: `total 8\n` + FILLER(200 + t, 9) });
        }
    } finally {
        server.close(); upstream.close();
        await Promise.allSettled([once(server, "close"), once(upstream, "close")]);
    }

    // 1. coverage: enough bodies, at least two folds
    assert.ok(captured.length >= 20, `expected >=20 upstream bodies, got ${captured.length}`);
    assert.ok(folds >= 2, `expected >=2 folds, got ${folds}`);

    // 2. the chat wire never carries the Responses run separator
    for (let i = 0; i < captured.length; i++) {
        assert.ok(!captured[i]!.includes(SEPARATOR_TEXT), `body ${i} carries the Responses run separator on the chat wire — refreshFolded ran a Responses-only repair (#1592)`);
    }

    // 3. any divergence must land either inside the fold-summary element of
    //    the LATER body (the covering-range text swap) or in the trailing
    //    volatile slots of the shorter body (plain growth: nudge / chain
    //    stamp / new user turn). A mid-history landing is the #1592 bug.
    const lcp = (a: string, b: string): number => { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; };
    const elemCount = (s: string): number => (s.match(/"role"/g) ?? []).length;
    const elemIdxAt = (s: string, off: number): number => (s.slice(0, off).match(/"role"/g) ?? []).length;
    for (let i = 1; i < captured.length; i++) {
        const a = captured[i - 1]!, b = captured[i]!;
        if (a === b) continue;
        const p = lcp(a, b);
        const idxB = elemIdxAt(b, p);
        const tailSlots = elemCount(b) - 3;
        const inVolatileTail = idxB >= tailSlots;
        let inSummaryElem = false;
        const anchor = b.indexOf(SUMMARY_MARKER);
        if (anchor >= 0) {
            const elemStart = b.lastIndexOf('"role"', anchor);
            const elemEnd = b.indexOf('"role"', anchor + SUMMARY_MARKER.length);
            inSummaryElem = p >= elemStart && (elemEnd === -1 || p < elemEnd);
        }
        assert.ok(inVolatileTail || inSummaryElem, `pair ${i - 1}->${i} diverges at body-${i} element #${idxB}/${elemCount(b)} — mid-history rewrite (neither the fold-summary element nor the trailing volatile slots). #1592: refreshFolded must render the steady path's shape`);
    }
});
