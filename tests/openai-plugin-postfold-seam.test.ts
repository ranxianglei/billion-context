// #2997 backstop: post-fold PREFIX STABILITY on the DSH-native lane — the ONE compression
// lane #2755/#2741 never covered. Those fixes + their regression tests are Responses-wire /
// PROXY-mode (carrier = injected acp_summary). DSH-native is PLUGIN mode over
// /v1/chat/completions: the client owns history, folds arrive via POST /__bili/plugin/tool
// (forwardTool), and the rebuild path is prepare-openai (openaiToCore -> processTurn/prune ->
// stripKernelSummaries -> coreToOpenai/systemToUser/injectOpenaiSystem). The fold is exercised
// through that side channel with no client compress tool pair echoed into the resent history, so
// the on-wire carrier here is the kernel's acp_summary. The invariant asserted below — pinned-head
// byte-stability across consecutive builds — is CARRIER-AGNOSTIC (it holds whether the seam carries
// the acp_summary or the client's tool pair), guarding the lane under either.
//
// Production signature (#2997, v0.1.196): after BIG folds the follow-up request matched only
// ~12-17% of the prior input (should be ~head+anchor) and recovered next turn — i.e. the
// rebuilt body diverged from the provider-cached prefix EARLY, not just at the seam. A hermetic
// sweep (single / big-contiguous / multi-disjoint-range folds, up to 9 stacked blocks) shows the
// bili rebuild stays byte-stable in its head+summary region; this pins that invariant so any
// future bili-side regression that reintroduces early-prefix drift fails here. It does NOT model
// dsh-client re-serialization or provider cache keying/TTL (out of scope for a hermetic proxy
// test); see the #2997 thread for that boundary.
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

type Msg = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const CONV = "i2997-seam-conv";
const GROW_TURNS = 14;
const FOLLOW_TURNS = 3;
const DISJOINT_RANGES = 3;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const cstr = (c: unknown): string => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
const isSummaryMsg = (m: Msg | undefined): boolean =>
    !!m && m.role === "user" && cstr(m.content).includes(SUMMARY_MARKER);
const firstUserIdx = (msgs: Msg[]): number => msgs.findIndex((m) => m.role === "user" && !isSummaryMsg(m));
const summaryIdxs = (msgs: Msg[]): number[] => msgs.map((m, i) => (isSummaryMsg(m) ? i : -1)).filter((i) => i >= 0);
const topicOf = (m: Msg): string => (cstr(m.content).match(/folded ([A-Za-z0-9\-]+):/) ?? [])[1] ?? "?";
const summaryTopics = (msgs: Msg[]): string[] => summaryIdxs(msgs).map((i) => topicOf(msgs[i]!));
const firstDivergence = (a: Msg[], b: Msg[]): number => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    return n;
};
const rmrf = (p: string): void => { fs.rmSync(p, { recursive: true, force: true }); };

test("#2997: dsh-lane (openai-chat plugin mode) post-fold rebuild keeps the pinned head byte-stable", { timeout: 120_000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "i2997-seam-"));
    process.env.XDG_STATE_HOME = tmp;
    process.env.XDG_CACHE_HOME = tmp;
    process.env.XDG_DATA_HOME = tmp;
    process.env.XDG_CONFIG_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const captured: string[] = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push(body);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: `resp_${captured.length}`, object: "chat.completion", created: 1, model: "gpt-test",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 200_000 } } } },
            modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true, preserveRecentTokens: 0 },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: false, passthrough: false,
            autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest", streamErrorShape: "protocol", passthroughSource: null,
            advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} }, mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const chatUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-bili-plugin": "dsh",
            "x-bili-plugin-conversation": CONV,
        };

        const snapshotRefs = async (): Promise<string[]> => {
            const s = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/snapshot?conversationId=${CONV}`);
            const sj = (await s.json()) as { orderedMessages?: { ref?: string }[] };
            return (sj.orderedMessages ?? []).map((m) => m.ref ?? "").filter((r) => /^m\d+$/.test(r));
        };

        const hist: Msg[] = [{ role: "system", content: "You are a helpful assistant. i2997 system. " + FILLER(900, 0.5) }];
        const sendTurn = async (t: number): Promise<void> => {
            const userMsg: Msg = { role: "user", content: `Turn ${t}: analyze module ${t}. ` + FILLER(t, 6) };
            hist.push(userMsg);
            const r = await fetch(chatUrl, { method: "POST", headers, body: JSON.stringify({ model: "gpt-test", stream: false, messages: [...hist] }) });
            if (!r.ok) throw new Error(`turn ${t} failed HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
            const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
            hist.push({ role: "assistant", content: d.choices?.[0]?.message?.content ?? "ok" });
        };

        for (let t = 0; t < GROW_TURNS; t++) await sendTurn(t);

        const refs = await snapshotRefs();
        assert.ok(refs.length >= GROW_TURNS, `expected >= ${GROW_TURNS} live refs before fold, saw ${refs.length}`);
        const L = refs.length;
        const ranges = Array.from({ length: DISJOINT_RANGES }, (_, j) => {
            const a = Math.max(1, Math.floor(L * (0.15 + 0.22 * j)));
            const b = Math.min(L - 3, a + 1);
            return { startId: refs[a]!, endId: refs[b]!, topic: `F${j}`, summary: `folded F${j}: numbered questions with filler answers; no decisions made.` };
        });
        const tr = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: CONV, tool: "compress", args: { content: ranges } }),
        });
        const tj = (await tr.json()) as { ok?: boolean; outcome?: string; blocksCreated?: number };
        assert.ok(tr.ok && tj.ok === true, `fold via /__bili/plugin/tool failed: status=${tr.status} body=${JSON.stringify(tj)?.slice(0, 300)}`);
        assert.equal(tj.outcome, "applied", `multi-range fold should apply fully, got outcome=${tj.outcome}`);
        assert.equal(tj.blocksCreated, DISJOINT_RANGES, `expected ${DISJOINT_RANGES} blocks, got ${tj.blocksCreated}`);

        for (let t = GROW_TURNS; t < GROW_TURNS + FOLLOW_TURNS; t++) await sendTurn(t);

        const bodies = captured.map((b) => (JSON.parse(b) as { messages?: Msg[] }).messages ?? []);
        assert.ok(bodies.length >= GROW_TURNS + FOLLOW_TURNS, `expected >= ${GROW_TURNS + FOLLOW_TURNS} upstream requests, got ${bodies.length}`);

        // (1) The pinned first user message NEVER moves, and NO summary ever precedes it — in every single request.
        const pinIdx = bodies[0]!.map((m, i) => (m.role === "user" && !isSummaryMsg(m) ? i : -1)).filter((i) => i >= 0)[0];
        assert.ok(typeof pinIdx === "number" && pinIdx >= 0, "no pinned first user message found in the initial body");
        for (let k = 0; k < bodies.length; k++) {
            const fu = firstUserIdx(bodies[k]!);
            assert.equal(fu, pinIdx, `request[${k}]: pinned first user message moved to index ${fu} (was ${pinIdx})`);
            for (const si of summaryIdxs(bodies[k]!)) {
                assert.ok(si > fu, `request[${k}]: summary at index ${si} precedes the pinned first user message at ${fu}`);
            }
        }

        // (2) Consecutive STEADY-state post-fold builds are byte-identical except at the tail.
        // The first post-fold request legitimately introduces the new summaries; every later
        // request appends only the new turn. So for each consecutive pair after the fold, all
        // indices before the shorter body's length must match — a divergence there is head/summary
        // drift and would bust the provider prefix cache early (the #2997 signature).
        const foldReqIdx = GROW_TURNS; // request index of the first post-fold forward
        for (let k = foldReqIdx + 1; k < bodies.length; k++) {
            const prev = bodies[k - 1]!;
            const cur = bodies[k]!;
            const div = firstDivergence(prev, cur);
            assert.ok(div >= Math.min(prev.length, cur.length),
                `steady post-fold request[${k}] diverges from request[${k - 1}] at item[${div}] (< ${Math.min(prev.length, cur.length)}) — head/summary drift busts the prefix cache`);
        }

        // (3) Summary set + ordering is stable across the steady post-fold builds (no reorder that
        // would move bytes between builds even where per-item equality above already holds).
        const steady = bodies.slice(foldReqIdx + 1);
        const refTopics = summaryTopics(steady[0]!);
        assert.ok(refTopics.length >= DISJOINT_RANGES, `expected >= ${DISJOINT_RANGES} summaries in steady state, saw [${refTopics}]`);
        for (let k = 1; k < steady.length; k++) {
            assert.deepEqual(summaryTopics(steady[k]!), refTopics, `steady request[${k}] reordered summaries vs the first steady build`);
        }

        console.log(`#2997 backstop: pin@${pinIdx}, steady summaries=[${refTopics}], ${bodies.length} requests all head-stable`);
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        rmrf(tmp);
    }
});
