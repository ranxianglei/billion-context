// #2733/#2741 regression: CONSUMPTION re-fold seam on the Responses wire (codex path).
//
// Production signature (v0.1.188-192, #2733 log): after a fold whose range nests over
// a prior fold's covered region (consuming its blocks), the post-fold requests matched
// only the immutable head (~11.1K tokens) instead of head+anchor. Root cause (confirmed,
// fixed in kernel/src/prune.ts): collectSummaryAnchors anchored the merged summary at
// the EARLIEST id of the merged effectiveMessageIds — which reaches back through the
// consumption chain to the range root (here: the pinned first user message) — splicing
// fresh summary bytes AHEAD of the pin and collapsing the provider prefix match to the
// head on every such re-fold; unresolved anchors fell back to index 0 (same collapse).
// The consumed blocks' stale rendered copies also survived the rebuild, leaking next to
// the successor summary in the loop path.
//
// Pinned here (all hard): (1) the pinned first user message stays the first history
// item across the consumption re-fold; (2) the rewrite starts exactly at item[2]
// (right after the pin); (3) exactly one summary survives — stale consumed copies are
// dropped; (4) the re-request and the next steady turn share the merged summary
// byte-for-byte at the same position (no one-build drift). Plus the fold-1 sanity
// invariants from the #1548 lane.
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
const FOLD1_AT = 6; // upstream request index whose response = first compress call (3 ranges)
const FOLD2_AT = 12; // upstream request index whose response = re-fold compress call (3 ranges over the same region)
const TOTAL_TURNS = 18;

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

const firstDivergence = (a: Item[], b: Item[]): number => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    return n;
};

const rmrf = (p: string): void => { fs.rmSync(p, { recursive: true, force: true }); };

test("#2733: consumption re-fold keeps the pin first, drops stale copies, stays byte-stable across builds", { timeout: 120_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refold-seam-"));
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
        const f1refs: string[] = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const idx = captured.length;
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push({ url: req.url ?? "", body });
                if (idx === FOLD1_AT) {
                    const prev = (JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? [];
                    const uniq = refsOf(prev);
                    f1refs.push(...uniq);
                    assert.ok(uniq.length >= 11, `fold1: expected >=11 tagged refs, saw ${uniq.length}`);
                    const args = JSON.stringify({ content: [
                        { startId: uniq[3]!, endId: uniq[5]!, topic: "F1A", summary: `F1A summary: ${FILLER(1, 1)}` },
                        { startId: uniq[6]!, endId: uniq[8]!, topic: "F1B", summary: `F1B summary: ${FILLER(2, 1)}` },
                    ] });
                    compressCallSse(res, `resp_${idx}`, args);
                    return;
                }
                if (idx === FOLD2_AT) {
                    const prev = (JSON.parse(captured[idx - 1]!.body) as { input?: Item[] }).input ?? [];
                    const uniq = refsOf(prev);
                    assert.ok(uniq.length >= 13, `fold2: expected >=13 tagged refs, saw ${uniq.length}`);
                    // re-fold: start INSIDE F1A's covered span (mid of f1refs[3..5]) and end past fold-1's
                    // end → the new block consumes b1/b2, merging their effective ids back to F1A's start.
                    const args = JSON.stringify({ content: [
                        { startId: "m00001", endId: uniq[9]!, topic: "F2A", summary: `F2A summary: ${FILLER(4, 1)}` },
                    ] });
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
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "refold-seam-test" }, body: JSON.stringify(body) });
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
        assert.ok(inputs.length >= FOLD2_AT + 3, `expected >= ${FOLD2_AT + 3} upstream requests, got ${inputs.length}`);

        // ---- fold 1 sanity (#1548 invariants must still hold) ----
        const f1r2 = inputs[FOLD1_AT + 1]!;
        const f1Pre = inputs[FOLD1_AT - 1]!;
        const f1SumIdx = summaryIndices(f1r2);
        assert.ok(f1SumIdx.length >= 1, "fold-1 round-2 must carry the in-place summary");
        const next1 = inputs[FOLD1_AT + 2]!;
        const s1 = summaryIndices(next1);
        assert.ok(s1.length >= 1 && s1[0] === f1SumIdx[0], "fold-1: summary anchor position drifts into next turn");
        for (let i = 0; i <= s1[0]!; i++) {
            assert.equal(JSON.stringify(next1[i]), JSON.stringify(inputs[FOLD1_AT + 1]![i]), `fold-1 growth: item[${i}] diverges`);
        }
        console.log(`fold-1: summary anchored at item[${f1SumIdx[0]}]; pre-fold body had ${summaryIndices(f1Pre).length} summaries`);

        // ---- fold 2: the consumption re-fold — post-fix invariants (hard) ----
        const f2Pre = inputs[FOLD2_AT - 1]!; // last body the provider cached before the re-fold
        const f2r2 = inputs[FOLD2_AT + 1]!; // post-fold re-request (refreshed view)
        const f2Next = inputs[FOLD2_AT + 2]!; // next steady client turn

        const preSums = summaryIndices(f2Pre);
        const r2Sums = summaryIndices(f2r2);
        const nextSums = summaryIndices(f2Next);
        console.log(`re-fold: pre summaries at [${preSums}], post-fold-r2 at [${r2Sums}], next steady at [${nextSums}]`);
        for (const [lbl, view] of [["f2Pre", f2Pre], ["f2r2", f2r2], ["f2Next", f2Next]] as const) {
            view.slice(0, 12).forEach((it, i) => {
                const js = JSON.stringify(it) ?? "";
                const short = it.type === "message" && typeof it.content === "string"
                    ? (it.content.startsWith(SUMMARY_MARKER) ? "SUMMARY:" + it.content.slice(30, 80) : (it.content.match(/(m\d+)/)?.[1] ?? "?") + " " + it.content.slice(0, 40))
                    : js.slice(0, 60);
                console.log(`  ${lbl}[${i}] ${it.type} ${short.replace(/\n/g, "|")}`);
            });
        }

        // (1) The pin survives the consumption re-fold: the first history item
        // stays the pinned first user message. The merged range roots at m00001,
        // so its anchor resolves to the pin's slot — pre-fix it was spliced
        // AHEAD of the pin and every subsequent request matched only the
        // immutable head (#2733/#2741 double penalty).
        const head = f2r2[1];
        assert.ok(!!head && !isSummaryItem(head), `re-fold r2: first history item must stay the pinned user message, saw: ${JSON.stringify(head)?.slice(0, 140)}`);
        assert.match(JSON.stringify(head), /m00001/, "re-fold r2: pinned first user message (m00001) missing from the head slot");

        // (2) The rewrite is confined to right after the pin: bytes up to and
        // including the pin are identical to the provider-cached body.
        const div = firstDivergence(f2Pre, f2r2);
        assert.equal(div, 2, `re-fold: rewrite must start at item[2] (right after the pin), diverged at item[${div}]: pre=${JSON.stringify(f2Pre[div])?.slice(0, 120)} post=${JSON.stringify(f2r2[div])?.slice(0, 120)}`);

        // (3) Consumed blocks' stale rendered copies are dropped: exactly ONE
        // summary (the merged successor) survives in both the re-request and
        // the next steady view — pre-fix the loop path kept the consumed
        // blocks' copies next to the successor forever.
        assert.equal(r2Sums.length, 1, `re-fold r2: expected exactly 1 summary (the merged successor), got ${r2Sums.length} at [${r2Sums}] — stale consumed-block copies leaked`);
        assert.equal(nextSums.length, 1, `next steady: expected exactly 1 summary, got ${nextSums.length} at [${nextSums}] — stale consumed-block copies leaked`);

        // (4) No one-build drift between re-request and steady turn: same
        // position, same bytes. Pre-fix the two builders resolved the merged
        // anchor differently and the steady request collapsed back to the head
        // (second strike of the double penalty).
        const newSumIdx = r2Sums[0]!;
        assert.equal(nextSums[0], newSumIdx, `steady re-anchored the merged summary at item[${nextSums[0]}], re-request carried it at item[${newSumIdx}] — one-build drift`);
        assert.equal(JSON.stringify(f2Next[nextSums[0]]), JSON.stringify(f2r2[newSumIdx]), "steady rendered the merged summary differently than the re-request");
        // The merged summary legitimately lands AHEAD of the consumed blocks'
        // old anchors: its range roots at the pin, so the invariant is
        // pin-first ordering, not old-anchor preservation.
        console.log(`re-fold: merged summary at item[${newSumIdx}], stable across the build seam (pre-fold summaries were at [${preSums}])`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        rmrf(tmp);
    }
});
