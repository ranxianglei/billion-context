// Targeted probe for #1555: can the anthropic wire lose the newest in-place
// summary on the SECOND fold's round-2 re-request?
//
// Background: while building the #1554 matrix, a real-proxy run observed the
// second fold's round-2 carrying NO new in-place summary while the first
// fold's stayed pinned (#1548 floor 24) and was left uncharacterized. The
// final matrix (throttled cadence, one fold per client turn) passes F1 on
// anthropic, so this probe drives the two cadences the matrix cannot express:
//
//   A. STACKED FOLDS — the model demands a second compress IMMEDIATELY on the
//      first fold's round-2 re-request (two applyCompression + two
//      refreshFolded passes inside ONE client turn; the second refresh sees
//      BOTH rounds' ephemeral acp_loop_* pairs in its records). Ranges are
//      adjacent, non-overlapping. Expectation: BOTH summaries survive in the
//      second round-2 and in the following client turn. Pre-#1551 code drops
//      them here — the #1551 root cause (records mixed into the
//      stripKernelSummaries input makes the carried-set match the just-created
//      block's compressCallId) fires for EVERY block whose ephemeral pair is
//      still in records, i.e. both folds under this cadence.
//
//   B. OVERLAPPING RANGE — the second fold's range deliberately covers the
//      first block's anchor region. Documents the kernel's designed nesting
//      semantics (acp-kernel applySingleRange: a plain range covering a
//      visible older block consumes it into directBlockIds — T2 distillation):
//      the OLDER summary disappears, the newer one renders alone. Note the
//      direction: the #1555-reported symptom was the OPPOSITE (older kept,
//      newest lost), which kernel nesting cannot produce. Pinning both
//      directions prevents either misattribution.
//
// CF_DUMP=<dir> dumps every captured upstream body as <NNN>.json for manual
// inspection (same convention as tests/cache-friendly-proxy.test.ts).
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
const THRESHOLD = 40 * 1024;
const MAX_TURNS = 20;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const asArr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

/** Normalized comparable element list for an anthropic outbound body. */
function normOf(p: Item): unknown[] {
    return [p.system ?? null, ...asArr(p.messages)];
}

/** True when the body carries a compress CALL (the round-2 re-request marker). */
function isRound2Body(p: Item): boolean {
    return asArr(p.messages).flatMap((m) => (typeof m.content === "string" ? [] : asArr(m.content))).some((b) => b.type === "tool_use" && b.name === "compress");
}

/** Summary OCCURRENCES in the normalized body (coreToAnthropic merges same-role
 *  runs, so one element may legally carry several summaries). */
function countSummaries(list: unknown[]): number {
    let n = 0;
    for (const el of list) n += JSON.stringify(el ?? "").split(SUMMARY_MARKER).length - 1;
    return n;
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

interface ProbeTrigger {
    should(body: string, refs: string[]): boolean;
    args(refs: string[]): string;
    done(): boolean;
}

function replyLabel(body: string): string {
    const re = /Turn (\d+):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { /* keep last */ }
    return m ? m[1]! : "0";
}

function startUpstreamAnthropic(captured: string[], trigger: ProbeTrigger): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const idx = captured.length;
            const label = replyLabel(body);
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            // Refs come from MESSAGES ONLY — the injected system prompt's ACP-TAGS
            // doc section carries a literal example tag that must not be counted.
            const parsedBody = JSON.parse(body) as Item;
            const msgRefs = parseRefIds(JSON.stringify(asArr(parsedBody.messages)));
            const compressArgs = trigger.should(body, msgRefs) ? trigger.args(msgRefs) : undefined;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const ev = (event: string, data: unknown): void => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: 100 } } });
            if (compressArgs !== undefined) {
                ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_cmp_${idx}`, name: "compress", input: {} } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(0, 20) } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: compressArgs.slice(20) } });
                ev("content_block_stop", { type: "content_block_stop", index: 0 });
                ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
            } else {
                ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
                ev("content_block_stop", { type: "content_block_stop", index: 0 });
                ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
            }
            ev("message_stop", { type: "message_stop" });
            res.end();
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
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

function extractReply(raw: string): string {
    let out = "";
    for (const block of raw.split("\n\n")) {
        let event = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (event !== "content_block_delta" || dataLines.length === 0) continue;
        try {
            const d = JSON.parse(dataLines.join("\n")) as { delta?: { type?: string; text?: string } };
            if (d.delta?.type === "text_delta" && d.delta.text) out += d.delta.text;
        } catch { /* ignore */ }
    }
    return out;
}

/** Drives a growing anthropic-wire conversation under a scripted fold trigger
 *  until the trigger is spent plus two plain turns follow. Returns the
 *  captured upstream bodies in arrival order. */
async function driveAnthropic(sessionId: string, trigger: ProbeTrigger, label: string): Promise<string[]> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `probe1555-${sessionId}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const captured: string[] = [];
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        const model = "claude-test";
        const ctx = 400_000;
        upstream = startUpstreamAnthropic(captured, trigger);
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        proxy = await startServer(proxyOptions(upstreamPort, model, ctx));
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
        const url = `${base}/v1/messages`;

        const hist: Item[] = [];
        const sendTurn = async (t: number): Promise<void> => {
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }) });
            if (!res.ok) throw new Error(`turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            const reply = extractReply(await res.text());
            assert.ok(reply.length > 0, `turn ${t}: empty reply`);
            hist.push({ role: "assistant", content: reply });
            if (t % 2 === 0) {
                hist.push({ role: "assistant", content: [{ type: "text", text: "running a check" }, { type: "tool_use", id: `tu_${t}`, name: "shell", input: { command: `ls -la mod-${t}` } }] });
                hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${t}`, content: `total 8\n-rw-r--r-- 1 u g 42 Sep 27 10:00 file-${t}.ts` }] });
            }
        };
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = captured.length;
            await sendTurn(t);
            sinceFold = captured.slice(before).some((b) => isRound2Body(JSON.parse(b) as Item)) ? 0 : sinceFold + 1;
            if (trigger.done() && sinceFold >= 2) break;
        }
        // Pinning needs a NORMAL body after the last fold.
        let guard = 0;
        while (captured.length > 0 && isRound2Body(JSON.parse(captured[captured.length - 1]!) as Item) && guard < 3) {
            await sendTurn(MAX_TURNS + guard);
            guard++;
        }
        if (process.env.CF_DUMP) {
            const dumpDir = path.join(process.env.CF_DUMP, label);
            fs.mkdirSync(dumpDir, { recursive: true });
            for (let i = 0; i < captured.length; i++) {
                fs.writeFileSync(path.join(dumpDir, `${String(i).padStart(3, "0")}.json`), captured[i]!);
            }
        }
        return captured;
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

function round2Indices(bodies: string[]): number[] {
    return bodies.map((_, i) => i).filter((i) => isRound2Body(JSON.parse(bodies[i]!) as Item));
}

test("#1555 probe A: stacked folds in one loop keep BOTH in-place summaries (anthropic wire)", { timeout: 120_000 }, async () => {
    // Fold 1 on the first big plain turn: covers refs[0..len-16] (front half
    // of a grown ~30-ref session). The kernel protects the first user message,
    // the recent/last-user zone, and "the last 5 messages" from folding — on a
    // short session that swallows the whole tail, so fold B must sit far from
    // the end. Fold 2 IMMEDIATELY on fold 1's round-2 re-request targets ONLY
    // refs beyond fold A's endId (adjacent, non-overlapping with block A;
    // re-requesting an already-covered span is rejected as "no new
    // compressible messages").
    let demands = 0;
    let foldAEnd = 0;
    const trigger: ProbeTrigger = {
        should(_body: string, refs: string[]): boolean {
            if (demands >= 2) return false;
            if (demands === 0) {
                if (_body.length > THRESHOLD && refs.length >= 28) { demands++; return true; }
                return false;
            }
            if (isRound2Body(JSON.parse(_body) as Item) && refs.length >= 6) { demands++; return true; }
            return false;
        },
        args(refs: string[]): string {
            if (demands === 1) {
                const end = refs[refs.length - 16]!;
                foldAEnd = parseInt(end.slice(1), 10);
                return JSON.stringify({ content: [{ startId: refs[0]!, endId: end, topic: "probe-fold-A", summary: "Fold A summary: stacked-fold probe, first fold of the back-to-back pair on the anthropic wire." }] });
            }
            const fresh = refs.filter((r) => parseInt(r.slice(1), 10) > foldAEnd);
            return JSON.stringify({ content: [{ startId: fresh[0]!, endId: fresh[fresh.length - 10]!, topic: "probe-fold-B", summary: "Fold B summary: stacked-fold probe, second fold demanded immediately on fold A's round-2 re-request." }] });
        },
        done: () => demands >= 2,
    };
    const bodies = await driveAnthropic("p1555-a", trigger, "testA");
    assert.ok(bodies.length >= 8, `expected a substantial request stream, got ${bodies.length}`);
    const r2All = round2Indices(bodies);
    assert.ok(r2All.length >= 2 && r2All[1] === r2All[0] + 1, `expected two CONSECUTIVE round-2 re-requests (stacked folds in one loop), got indices ${JSON.stringify(r2All)} of ${bodies.length}`);
    const lists = bodies.map((b) => normOf(JSON.parse(b) as Item));
    const r2a = lists[r2All[0]]!;
    const r2b = lists[r2All[1]]!;
    const s2a = JSON.stringify(r2a);
    const s2b = JSON.stringify(r2b);
    // Fold A materialized in its own round-2 (the plain #1551 regression guard).
    assert.equal(countSummaries(r2a), 1, `fold A must materialize in its round-2 (got ${countSummaries(r2a)})`);
    assert.ok(s2a.includes("probe-fold-A"), "fold A topic missing from its round-2");
    // THE #1555 assertion: the second fold's round-2 carries BOTH summaries —
    // the older one still pinned at its anchor AND the new one added. Pre-#1551
    // code strips every block whose ephemeral pair is still in records (both
    // here), reproducing the reported "newest summary lost" symptom.
    assert.equal(countSummaries(r2b), 2, `#1555: second fold's round-2 must carry BOTH in-place summaries (got ${countSummaries(r2b)})`);
    assert.ok(s2b.includes("probe-fold-A"), "#1555: OLDER summary lost from second fold's round-2");
    assert.ok(s2b.includes("probe-fold-B"), "#1555: NEWEST summary missing from second fold's round-2 (reported symptom)");
    // And the following client turn keeps both (no resurrection, no loss).
    const next = lists[r2All[1]! + 1];
    assert.ok(next, "expected a normal client turn after the stacked folds");
    assert.equal(countSummaries(next!), 2, `next client turn must keep both summaries (got ${countSummaries(next!)})`);
    assert.ok(JSON.stringify(next!).includes("probe-fold-A") && JSON.stringify(next!).includes("probe-fold-B"), "next client turn lost a summary topic");
});

test("#1555 probe B: overlapping fold range nests the older block by design (anthropic wire)", { timeout: 120_000 }, async () => {
    // Fold 1 leaves a 4-ref head visible (starts at refs[4]). Fold 2 then starts
    // at refs[0] — covering fold A's anchor region. Kernel nesting semantics
    // (applySingleRange -> blockVisibleInRange -> consumed into directBlockIds)
    // consume block A: only the NEWER summary renders. This pins the DESIGNED
    // direction of range-swallowing — the opposite of the #1555-reported
    // symptom (older kept, newest lost), which nesting cannot produce.
    let demands = 0;
    const trigger: ProbeTrigger = {
        should(_body: string, refs: string[]): boolean {
            if (demands >= 2) return false;
            if (demands === 0) {
                if (_body.length > THRESHOLD && refs.length >= 14) { demands++; return true; }
                return false;
            }
            if (isRound2Body(JSON.parse(_body) as Item) && refs.length >= 8) { demands++; return true; }
            return false;
        },
        args(refs: string[]): string {
            const entry = demands === 1
                ? { startId: refs[4]!, endId: refs[refs.length - 8]!, topic: "probe-fold-A", summary: "Fold A summary: overlap probe, first fold with a visible head left in front of its anchor." }
                : { startId: refs[0]!, endId: refs[refs.length - 2]!, topic: "probe-fold-B", summary: "Fold B summary: overlap probe, second fold whose range deliberately covers fold A's anchor region." };
            return JSON.stringify({ content: [entry] });
        },
        done: () => demands >= 2,
    };
    const bodies = await driveAnthropic("p1555-b", trigger, "testB");
    assert.ok(bodies.length >= 8, `expected a substantial request stream, got ${bodies.length}`);
    const r2All = round2Indices(bodies);
    assert.ok(r2All.length >= 2 && r2All[1] === r2All[0] + 1, `expected two CONSECUTIVE round-2 re-requests, got indices ${JSON.stringify(r2All)} of ${bodies.length}`);
    const lists = bodies.map((b) => normOf(JSON.parse(b) as Item));
    const r2a = lists[r2All[0]]!;
    const r2b = lists[r2All[1]]!;
    const s2a = JSON.stringify(r2a);
    const s2b = JSON.stringify(r2b);
    assert.equal(countSummaries(r2a), 1, `fold A must materialize in its round-2 (got ${countSummaries(r2a)})`);
    assert.ok(s2a.includes("probe-fold-A"), "fold A topic missing from its round-2");
    // Designed nesting: the older block is consumed by the newer fold.
    assert.equal(countSummaries(r2b), 1, `overlap fold must render exactly ONE summary (kernel T2 nesting consumed block A; got ${countSummaries(r2b)})`);
    assert.ok(s2b.includes("probe-fold-B"), "newer summary missing after overlap fold");
    assert.ok(!s2b.includes("probe-fold-A"), "older summary must be consumed by the overlapping fold (kernel nesting)");
    // Stable afterwards: no resurrection, no further loss.
    const next = lists[r2All[1]! + 1];
    assert.ok(next, "expected a normal client turn after the overlap fold");
    const snext = JSON.stringify(next!);
    assert.equal(countSummaries(next!), 1, `next client turn must keep exactly one summary (got ${countSummaries(next!)})`);
    assert.ok(snext.includes("probe-fold-B") && !snext.includes("probe-fold-A"), "next client turn summary set drifted");
});
