// Full-loop tag in/out experiment (#3198 round 2): does the tag pipeline
// (inject → model imitates → filter → client persists → resend → rebuild)
// keep the OUTBOUND request bodies append-stable when the model actively
// imitates the render tags it sees?
//
// The cache-friendly matrix (tests/cache-friendly-proxy.test.ts) proves this
// for a NON-imitating model. This experiment adds the documented imitation
// loop (#206/#673/#1731/#2190): the fake upstream parses each request, picks
// real refs out of the injected render tags, and echoes them back in the
// shapes the filter documents (clean pair, typo close, prose-wearing pair,
// bare citation, marker line), with intensity growing as history grows. The
// client is FAITHFUL: it persists exactly the bytes the filter released and
// resends them verbatim (isolates bili's contribution — no dsh re-render).
// Replies stream in small seeded deltas so the streaming state machine sees
// realistic chunk boundaries.
//
// Invariant under test (the owner's "0变化"): consecutive outbound bodies may
// differ ONLY in the trailing volatile slots — zero mid-history mutation —
// across growth AND folds, with imitation residue riding the history.
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
type Wire = "responses" | "chat";

const SUMMARY_MARKER = "[Compressed conversation section]";
const CHAIN_MARKER = "bili-chain";
const THRESHOLD = 40 * 1024;
const MAX_TURNS = 24;
const TAIL_VOLATILE_SLOTS = 3;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const asArr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);
const isChainEl = (el: unknown): boolean => JSON.stringify(el ?? "").includes(CHAIN_MARKER);
const eqEl = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : JSON.stringify(a) === JSON.stringify(b) || (isChainEl(a) && isChainEl(b)));

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

/** The imitation payload a model under context pressure emits, built from the
 *  REAL render tags present in the request body. Shapes per the filter docs. */
function imitationFor(body: string, turn: number): string {
    const refs = parseRefIds(body);
    if (refs.length === 0) return "";
    const rnd = mulberry32(1000 + turn);
    const intensity = Math.min(1 + Math.floor(turn / 4), 5);
    const parts: string[] = [];
    for (let i = 0; i < intensity; i++) {
        const ref = refs[Math.floor(rnd() * refs.length)]!;
        const shape = Math.floor(rnd() * 5);
        switch (shape) {
            case 0: parts.push(`context from \x3cacp tokens="2" type="text"\x3e${ref}\x3c/acp\x3e`); break;
            case 1: parts.push(`earlier \x3cacp tokens="2" type="text"\x3e${ref}\x3c/acip\x3e notes`); break;
            case 2: parts.push(`see \x3cacp tokens="2" type="text"\x3ethe recorded module notes ${i}\x3c/acp\x3e for details`); break;
            case 3: parts.push(`as noted in ${ref} previously`); break;
            case 4: parts.push(`folded range ${ref} and ${refs[(Math.floor(rnd() * refs.length))] ?? ref}`);
        }
    }
    return parts.join(" ");
}

function countTagArtifacts(text: string): { opens: number; closes: number; bareRefs: number; markers: number } {
    return {
        opens: (text.match(/\x3cacp[\s/>]/g) ?? []).length,
        closes: (text.match(/\x3c\/acp>/g) ?? []).length,
        bareRefs: (text.match(/(?:^|[^\w>])m\d{4,}/g) ?? []).length,
        markers: (text.match(/\[ACP\]/g) ?? []).length,
    };
}

function normOf(wire: Wire, p: Item): unknown[] {
    const tools = p.tools ?? null;
    switch (wire) {
        case "responses": return [tools, ...asArr(p.input)];
        case "chat": return [tools, ...asArr(p.messages)];
    }
}

function isRound2Body(wire: Wire, p: Item): boolean {
    switch (wire) {
        case "responses":
            return asArr(p.input).some((it) => it.type === "function_call" && it.name === "compress");
        case "chat":
            return asArr(p.messages).some((m) => asArr(m.tool_calls).some((tc) => (tc as { function?: { name?: string } })?.function?.name === "compress"));
    }
}

function countSummaries(list: unknown[]): number {
    let n = 0;
    for (const el of list) n += JSON.stringify(el ?? "").split(SUMMARY_MARKER).length - 1;
    return n;
}
function firstSummaryIdx(list: unknown[]): number {
    for (let i = 0; i < list.length; i++) if (JSON.stringify(list[i] ?? "").includes(SUMMARY_MARKER)) return i;
    return -1;
}
function lastSummaryIdx(list: unknown[]): number {
    for (let i = list.length - 1; i >= 0; i--) if (JSON.stringify(list[i] ?? "").includes(SUMMARY_MARKER)) return i;
    return -1;
}
function lcpTolerant(a: unknown[], b: unknown[]): number {
    let k = 0;
    const n = Math.min(a.length, b.length);
    while (k < n && eqEl(a[k], b[k])) k++;
    return k;
}

function checkGrowthStable(prev: unknown[], cur: unknown[], label: string): void {
    const prevSolid = prev.length - (isChainEl(prev[prev.length - 1]) ? 1 : 0);
    assert.ok(cur.length >= prevSolid - 2, `${label}: body shrank unexpectedly (${prev.length} -> ${cur.length}) without a fold`);
    const k = lcpTolerant(prev, cur);
    assert.ok(
        k >= prevSolid - TAIL_VOLATILE_SLOTS,
        `${label}: CACHE-HOSTILE mutation at element[${k}] of ${prev.length} — during plain growth only the trailing volatile slots (<=${TAIL_VOLATILE_SLOTS}) may differ`,
    );
}

function checkFoldTransition(pre: unknown[], r2: unknown[], next: unknown[], label: string): void {
    assert.equal(countSummaries(r2), countSummaries(pre) + 1, `${label}: round-2 summary count`);
    const firstIdx = firstSummaryIdx(r2);
    for (let i = 0; i < firstIdx; i++) {
        assert.ok(eqEl(pre[i], r2[i]), `${label}: fold mutated pre-summary head element[${i}]`);
    }
    const lastIdx = lastSummaryIdx(r2);
    for (let i = 0; i <= lastIdx; i++) {
        assert.ok(eqEl(r2[i], next[i]), `${label}: round-2 and next turn diverge at element[${i}] (last summary anchor [${lastIdx}])`);
    }
    assert.equal(countSummaries(next), countSummaries(r2), `${label}: next client turn lost/gained a summary`);
    assert.ok(next.length > lastSummaryIdx(next) + 1, `${label}: next turn must append after the anchor`);
}

function listen(server: http.Server): Promise<void> {
    return once(server, "listening").then(() => undefined);
}
function closeServer(s: http.Server | undefined): Promise<void> {
    return s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();
}

function makeCompressTrigger(threshold: number): { calls: () => number; should: (body: string) => boolean; args: (refs: string[]) => string } {
    let lastDemandBytes = Infinity;
    let sinceDemand = 99;
    let calls = 0;
    return {
        calls: () => calls,
        should(body: string): boolean {
            const bytes = Buffer.byteLength(body);
            const refs = parseRefIds(body);
            if (bytes > threshold && refs.length >= 12 && !(sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9)) {
                lastDemandBytes = bytes;
                sinceDemand = 0;
                calls++;
                return true;
            }
            sinceDemand++;
            return false;
        },
        args(refs: string[]): string {
            return JSON.stringify({
                content: [{
                    startId: refs[2]!,
                    endId: refs[refs.length - 6]!,
                    topic: "imitation fold",
                    summary: `Imitation-loop fold covering ${refs[2]}..${refs[refs.length - 6]}: pipeline observations with render-tag residue riding the history.`,
                }],
            });
        },
    };
}

function replyLabel(body: string): string {
    const re = /Turn (\d+):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { /* keep last */ }
    return m ? m[1]! : "0";
}

interface LedgerRow {
    turn: number;
    round2: boolean;
    bodyBytes: number;
    tagsInjected: number;
    replyBytes: number;
    replyResidue: { opens: number; closes: number; bareRefs: number; markers: number };
}

function startUpstream(wire: Wire, captured: string[], replies: string[], trigger: ReturnType<typeof makeCompressTrigger>): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const idx = captured.length;
            const label = replyLabel(body);
            const turn = Number(label);
            const imitation = imitationFor(body, turn);
            const reply = `Reply Turn ${label}: done. ${imitation} ` + FILLER(turn, 0.2);
            replies.push(reply);
            const compressArgs = trigger.should(body) ? trigger.args(parseRefIds(body)) : undefined;
            // Seeded small deltas: realistic tokenizer-fragment stream through
            // the filter's state machine (boundaries land inside tags/whitespace).
            const rnd = mulberry32(idx);
            const deltas: string[] = [];
            for (let pos = 0; pos < reply.length;) {
                const n = Math.min(reply.length - pos, 4 + Math.floor(rnd() * 14));
                deltas.push(reply.slice(pos, pos + n));
                pos += n;
            }
            switch (wire) {
                case "responses": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const blk = (type: string, data: Record<string, unknown>): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
                    if (compressArgs !== undefined) {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: "", status: "in_progress" } });
                        blk("response.function_call_arguments.delta", { item_id: `fc_${idx}`, output_index: 0, delta: compressArgs });
                        blk("response.function_call_arguments.done", { item_id: `fc_${idx}`, output_index: 0, arguments: compressArgs });
                        blk("response.output_item.done", { output_index: 0, item: { type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [{ type: "function_call", id: `fc_${idx}`, call_id: `call_cmp_${idx}`, name: "compress", arguments: compressArgs, status: "completed" }] } });
                    } else {
                        blk("response.created", { response: { id: `resp_${idx}`, status: "in_progress" } });
                        blk("response.output_item.added", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "in_progress", content: [] } });
                        for (const d of deltas) blk("response.output_text.delta", { item_id: `msg_${idx}`, output_index: 0, content_index: 0, delta: d });
                        blk("response.output_text.done", { item_id: `msg_${idx}`, output_index: 0, text: reply });
                        blk("response.output_item.done", { output_index: 0, item: { type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] } });
                        blk("response.completed", { response: { id: `resp_${idx}`, status: "completed", output: [{ type: "message", id: `msg_${idx}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply }] }] } });
                    }
                    res.end();
                    return;
                }
                case "chat": {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                    const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
                    if (compressArgs !== undefined) {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: compressArgs } }] } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } });
                    } else {
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
                        for (const d of deltas) line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: d } }] });
                        line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                    return;
                }
            }
        });
    });
}

function proxyOptions(upstreamPort: number, model: string, ctx: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: ctx } } } },
        modelContextLimit: ctx,
        kernelConfig: defaultConfig(ctx),
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
    };
}

function extractReply(wire: Wire, raw: string): string {
    let out = "";
    for (const block of raw.split("\n\n")) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
            if (wire === "responses") {
                const d = JSON.parse(dataLine.slice(5).trim()) as { type?: string; delta?: string };
                if (d.type === "response.output_text.delta" && d.delta) out += d.delta;
            } else {
                if (dataLine.includes("[DONE]")) continue;
                const d = JSON.parse(dataLine.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
                const c = d.choices?.[0]?.delta?.content;
                if (typeof c === "string") out += c;
            }
        } catch { /* ignore */ }
    }
    return out;
}

async function driveWire(wire: Wire, sessionId: string, model: string, ctx: number): Promise<{ bodies: string[]; ledger: LedgerRow[]; filtered: string[] }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `imit-${wire}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    const captured: string[] = [];
    const replies: string[] = [];
    const filtered: string[] = [];
    const ledger: LedgerRow[] = [];
    const trigger = makeCompressTrigger(THRESHOLD);
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        upstream = startUpstream(wire, captured, replies, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proxyOptions(upstreamPort, model, ctx));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
        const url = wire === "responses" ? `${base}/v1/responses` : `${base}/v1/chat/completions`;

        const hist: Item[] = [];
        const sendTurn = async (t: number): Promise<void> => {
            if (wire === "responses") {
                hist.push({ type: "message", role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
                const body: Item = {
                    model,
                    stream: true,
                    instructions: "You are a coding agent operating in a sandbox.\nFollow repo conventions strictly.",
                    tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
                    input: [...hist],
                };
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify(body) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                filtered.push(reply);
                hist.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
                if (t % 2 === 0) {
                    hist.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
                    hist.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` });
                }
            } else {
                if (hist.length === 0) hist.push({ role: "system", content: "You are a coding agent operating in a sandbox. Follow repo conventions strictly." });
                hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
                const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model, stream: true, messages: [...hist] }) });
                if (!res.ok) throw new Error(`${wire} turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
                const reply = extractReply(wire, await res.text());
                assert.ok(reply.length > 0, `${wire} turn ${t}: empty reply`);
                filtered.push(reply);
                hist.push({ role: "assistant", content: reply });
                if (t % 2 === 0) {
                    hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }) } }] });
                    hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` });
                }
            }
        };
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = trigger.calls();
            await sendTurn(t);
            if (trigger.calls() > before) sinceFold = 0;
            else sinceFold++;
            if (trigger.calls() >= 2 && sinceFold >= 3) break;
        }
        let guard = 0;
        while (captured.length > 0 && isRound2Body(wire, JSON.parse(captured[captured.length - 1]!) as Item) && guard < 3) {
            await sendTurn(MAX_TURNS + guard);
            guard++;
        }
        for (let i = 0; i < captured.length; i++) {
            const b = JSON.parse(captured[i]!) as Item;
            ledger.push({
                turn: i,
                round2: isRound2Body(wire, b),
                bodyBytes: Buffer.byteLength(captured[i]!),
                tagsInjected: parseRefIds(captured[i]!).length,
                replyBytes: filtered[i]?.length ?? 0,
                replyResidue: countTagArtifacts(filtered[i] ?? ""),
            });
        }
        return { bodies: captured, ledger, filtered };
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

function runChecks(wire: Wire, bodies: string[]): void {
    const lists = bodies.map((b) => normOf(wire, JSON.parse(b) as Item));
    const r2All = lists.map((_, i) => i).filter((i) => isRound2Body(wire, JSON.parse(bodies[i]!) as Item));
    const r2Idxs = r2All.filter((i) => i > 0 && !r2All.includes(i - 1));
    assert.ok(r2Idxs.length >= 2, `${wire}: expected >= 2 compress cycles, got ${r2All.length}`);
    const r2set = new Set(r2Idxs);
    for (let i = 1; i < lists.length; i++) {
        if (r2set.has(i) || r2set.has(i - 1)) continue;
        checkGrowthStable(lists[i - 1]!, lists[i]!, `${wire} req#${i - 1}->req#${i}`);
    }
    for (const i of r2Idxs) {
        checkFoldTransition(lists[i - 1]!, lists[i]!, lists[i + 1]!, `${wire} fold@req#${i}`);
    }
}

test("tag in/out full loop (responses wire, imitating model): outbound bodies stay append-stable, folds anchored", { timeout: 180_000 }, async () => {
    const { bodies, ledger } = await driveWire("responses", "imit-responses", "gpt-test", 200_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("responses", bodies);
    console.log("responses ledger: turn r2 bodyBytes tagsInjected replyBytes replyResidue(opens/closes/bareRefs/markers)");
    for (const r of ledger) console.log(`  #${String(r.turn).padStart(3)} ${r.round2 ? "R2" : "  "} ${String(r.bodyBytes).padStart(7)} ${String(r.tagsInjected).padStart(4)} ${String(r.replyBytes).padStart(5)}   ${r.replyResidue.opens}/${r.replyResidue.closes}/${r.replyResidue.bareRefs}/${r.replyResidue.markers}`);
});

test("tag in/out full loop (chat wire, imitating model): outbound bodies stay append-stable, folds anchored", { timeout: 180_000 }, async () => {
    const { bodies, ledger } = await driveWire("chat", "imit-chat", "gpt-test", 200_000);
    assert.ok(bodies.length >= 10, `expected a substantial request stream, got ${bodies.length}`);
    runChecks("chat", bodies);
    console.log("chat ledger: turn r2 bodyBytes tagsInjected replyBytes replyResidue(opens/closes/bareRefs/markers)");
    for (const r of ledger) console.log(`  #${String(r.turn).padStart(3)} ${r.round2 ? "R2" : "  "} ${String(r.bodyBytes).padStart(7)} ${String(r.tagsInjected).padStart(4)} ${String(r.replyBytes).padStart(5)}   ${r.replyResidue.opens}/${r.replyResidue.closes}/${r.replyResidue.bareRefs}/${r.replyResidue.markers}`);
});
