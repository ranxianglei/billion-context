// Cache-seam probes: targeted differential checks for the divergence
// surfaces the general matrix does not pin. Follow-up to the #1548 family
// (#1551 summary carrier, #1554 google system segment, #1597 round-2 message
// shape). Each probe drives a REAL proxy against a scripted fake upstream and
// compares consecutive upstream-bound bodies element by element.
//
//   P1 tools array  — the tools list is hashed into the provider prefix; any
//                     per-request tool-list mutation breaks the cache at
//                     element 0. (Also pinned matrix-wide via normOf.)
//   P2 absorb view  — with absorb.contextThresholdPct > 0 the absorb-prompt
//                     gate is token-count-fed; round-2 must use the SAME
//                     source as the steady paths or prompts flicker
//                     mid-history across every fold while the session
//                     straddles the threshold (#1592 family).
//   P3 CCR armed    — with compress.ccr.enabled the oversized tool result
//                     rides the wire as a placeholder; the placeholder element
//                     must stay byte-identical across folds (round-2 and the
//                     next client turn).
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
type Msg = Record<string, unknown>;

const THRESHOLD = 60 * 1024;
const ABSORB_PROMPT_FRAGMENT = "[ACP absorb]";
const CCR_PLACEHOLDER_FRAGMENT = "[acp-stored";

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: pipeline clean, suite green, four regions stable, metrics recorded. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const toolsOf = (p: Item): unknown => p.tools ?? null;
const msgsOf = (p: Item): unknown[] => asArr(p.messages);

function listen(srv: http.Server): Promise<void> {
    return new Promise<void>((resolve) => {
        if (srv.listening) resolve();
        else srv.once("listening", () => resolve());
    });
}
async function closeServer(srv: http.Server): Promise<void> {
    srv.close();
    await Promise.race([once(srv, "close"), new Promise((r) => setTimeout(r, 2000))]);
}

/** Chat-wire fake upstream. Deliberately reports NO usage field so the session
 *  stays estimate-grade — the regime where token-count source disagreements
 *  surface. Demands a compress call once the body exceeds the threshold. */
function startUpstream(captured: string[], plan: number[]): http.Server {
    let calls = 0;
    let firstViewRefs: string[] | undefined;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            const parsed = JSON.parse(body) as Item;
            const turnLabel = (() => {
                const re = /Turn (\d+):/g;
                let m: RegExpExecArray | null = null;
                let last = "0";
                while ((m = re.exec(body)) !== null) last = m[1]!;
                return last;
            })();
            const reply = `Reply Turn ${turnLabel}: done. ` + FILLER(Number(turnLabel), 0.15);
            const refs: string[] = [];
            const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(body)) !== null) refs.push(m[1]!);
            if (firstViewRefs === undefined && refs.length >= 10) firstViewRefs = refs;
            const demand = Buffer.byteLength(body) > THRESHOLD && calls < plan.length;
            const compressArgs = (() => {
                if (!demand) return undefined;
                const idx = plan[calls]!;
                const view = firstViewRefs ?? refs;
                const start = view[idx] ?? refs[2]!;
                const end = refs[refs.length - 6] ?? refs[refs.length - 1]!;
                if (!start || !end) return undefined;
                calls++;
                return JSON.stringify({ content: [{ startId: start, endId: end, topic: "seam probe", summary: `Seam-probe fold covering ${start}..${end}: exercised the pipeline, verified shapes, recorded deltas.` }] });
            })();
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const sse = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            if (compressArgs !== undefined) {
                sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_cmp_${calls}`, type: "function", function: { name: "compress", arguments: "" } }] } }] });
                for (let i = 0; i < compressArgs.length; i += 64) sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: compressArgs.slice(i, i + 64) } }] } }] });
                sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            } else {
                sse({ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                sse({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
                // NOTE: no usage field, ever (estimate-grade session by design)
            }
            res.end();
        });
    });
}

interface RigOpts {
    absorbThresholdPct?: number;
    ccr?: boolean;
    turns?: number;
    bigToolFrom?: number;
}

async function driveChat(sessionId: string, opts: RigOpts): Promise<string[]> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seamprobe-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    const captured: string[] = [];
    const upstream = startUpstream(captured, [2, undefined, 2, undefined, undefined, 2]);
    let proxy: http.Server | undefined;
    try {
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const options: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-seam": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: {
                injectTool: true,
                injectNudge: true,
                absorb: { enabled: true, contextThresholdPct: opts.absorbThresholdPct ?? 0 },
                ...(opts.ccr === true ? { ccr: { enabled: true, minToolTokens: 50 } } : {}),
            },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(options);
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const hist: Msg[] = [{ role: "system", content: "You are a coding agent. Follow conventions. Run tests." }];
        const turns = opts.turns ?? 12;
        const bigFrom = opts.bigToolFrom ?? 2;
        for (let t = 1; t <= turns; t++) {
            hist.push({ role: "user", content: `Turn ${t}: analyze module ${t}. ` + FILLER(t, 4) });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model: "gpt-seam", stream: true, messages: [...hist] }) });
            if (!res.ok) throw new Error(`turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            let reply = "";
            let comp = "";
            for (const block of (await res.text()).split("\n\n")) {
                const line = block.split("\n").find((l) => l.startsWith("data:"));
                if (!line) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                const d = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) reply += delta.content;
                for (const tc of delta?.tool_calls ?? []) comp += tc.function?.arguments ?? "";
            }
            assert.ok(reply.length > 0 || comp.length > 0, `turn ${t}: empty SSE`);
            if (comp) {
                hist.push({ role: "assistant", tool_calls: [{ id: "call_cmp", type: "function", function: { name: "compress", arguments: comp } }] });
                hist.push({ role: "tool", tool_call_id: "call_cmp", content: "probe fold receipt" });
            } else {
                hist.push({ role: "assistant", content: reply });
            }
            if (t >= bigFrom && t % 2 === 0) {
                hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls mod-${t}` }) } }] });
                hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: `total 8\n${FILLER(t, 18)}` });
            }
        }
        if (process.env.SEAM_DUMP) {
            fs.mkdirSync(process.env.SEAM_DUMP, { recursive: true });
            captured.forEach((b, i) => fs.writeFileSync(path.join(process.env.SEAM_DUMP, `${String(i).padStart(3, "0")}.json`), b));
        }
        return captured;
    } finally {
        await closeServer(proxy!);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

const isRound2 = (p: Item): boolean => msgsOf(p).some((mm) => asArr((mm as Msg).tool_calls).some((tc) => (tc as Msg).function?.name === "compress"));

/** Consecutive-pair walker: every pair must share a byte-identical prefix of
 *  message elements except (a) elements carrying a fold summary that is new
 *  in `cur`, and (b) the trailing volatile slots (chain/nudge, last 3). */
function assertPairSeamStable(prev: string, cur: string, label: string): void {
    const a = JSON.parse(prev) as Item;
    const b = JSON.parse(cur) as Item;
    // P1: tools must be identical on EVERY consecutive pair — no tolerance.
    assert.deepEqual(toolsOf(b), toolsOf(a), `${label}: tools array mutated between consecutive requests (element-0 prefix break)`);
    const ma = msgsOf(a);
    const mb = msgsOf(b);
    const tail = 3;
    let k = 0;
    const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
    while (k < Math.min(ma.length, mb.length) && eq(ma[k], mb[k])) k++;
    const solidA = ma.length - tail;
    // Sanctioned mid-history mutations (not seams): a NEW fold summary at the
    // divergence point, and the kernel's emergency truncation band (estimator
    // overshoot on estimate-grade sessions reclaims old content — #728/#1492
    // territory, by design, not a cache seam).
    const summaryNew = JSON.stringify(mb[k] ?? "").includes("Seam-probe fold covering");
    const emergencyTrunc = JSON.stringify(mb[k] ?? "").includes("[truncated for context space]");
    assert.ok(
        k >= solidA || summaryNew || emergencyTrunc,
        `${label}: mid-history divergence at message[${k}] of ${ma.length} (round2=${isRound2(b)}) — absorb/CCR view flipped between adjacent requests`,
    );
}

test("probe P1+P2: tools stable and absorb prompts do not flicker across folds (estimate-grade session, threshold 5%)", { timeout: 180_000 }, async () => {
    const bodies = await driveChat("seam-p2", { absorbThresholdPct: 0.05 });
    assert.ok(bodies.length >= 10, `expected >= 10 requests, got ${bodies.length}`);
    let folds = 0;
    for (let i = 1; i < bodies.length; i++) {
        if (isRound2(JSON.parse(bodies[i]!) as Item)) folds++;
        assertPairSeamStable(bodies[i - 1]!, bodies[i]!, `pair ${i}->${i + 1}`);
    }
    assert.ok(folds >= 2, `expected >= 2 folds, got ${folds}`);
});

test("probe P3: CCR placeholder element byte-stable across folds", { timeout: 180_000 }, async () => {
    const bodies = await driveChat("seam-p3", { ccr: true });
    assert.ok(bodies.length >= 10, `expected >= 10 requests, got ${bodies.length}`);
    // The big tool result must have been parked as a placeholder on the wire.
    assert.ok(bodies.some((b) => b.includes(CCR_PLACEHOLDER_FRAGMENT)), "no CCR placeholder ever hit the wire — rig misconfiguration");
    for (let i = 1; i < bodies.length; i++) assertPairSeamStable(bodies[i - 1]!, bodies[i]!, `pair ${i}->${i + 1}`);
    // Placeholder element identity BY REF: each stored message's placeholder
    // (identified by its #mNNNNN) must render byte-identically in every body
    // that carries it — folds shift positions and multiple placeholders
    // coexist, so index-based comparison would compare different elements.
    const refRe = /\[acp-stored #(m\d+) /g;
    const firstSeen = new Map<string, { body: number; el: string }>();
    for (let i = 0; i < bodies.length; i++) {
        const msgs = msgsOf(JSON.parse(bodies[i]!) as Item);
        msgs.forEach((m, idx) => {
            const j = JSON.stringify(m);
            if (!j.includes(CCR_PLACEHOLDER_FRAGMENT)) return;
            let mm: RegExpExecArray | null; refRe.lastIndex = 0;
            while ((mm = refRe.exec(j)) !== null) {
                const ref = mm[1]!;
                const prev = firstSeen.get(ref);
                if (prev === undefined) firstSeen.set(ref, { body: i, el: j });
                else assert.equal(j, prev.el, `placeholder ${ref} mutated between body ${prev.body} and ${i}`);
            }
        });
    }
    assert.ok(firstSeen.size >= 2, `expected >= 2 distinct stored placeholders, got ${firstSeen.size}`);
    const appearing = [...firstSeen.values()].filter((v) => v.body >= 2).length;
    assert.ok(appearing >= 1, "no placeholder survived past the early turns — rig too short for a cross-fold comparison");
});
