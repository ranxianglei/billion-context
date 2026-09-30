// Property-based differential fuzz for cache seams (#1548 family follow-up:
// #1551/#1554/#1597 were all found by hand-driven shapes the matrix never
// produced — this harness GENERATES shapes instead of enumerating them).
//
// One global invariant, checked over every consecutive pair of upstream-bound
// bodies of a session: divergence is allowed ONLY at
//   (a) a NEW fold summary element (the sanctioned anchor swap), or
//   (b) the kernel's emergency-truncation marker (#728/#1492 estimate band), or
//   (c) the trailing volatile slots (chain checkpoint / nudge, last 3).
// Plus: the tools array must be byte-identical on EVERY pair (element-0
// prefix), and CCR placeholders must be stable per ref when CCR is armed.
//
// Deterministic: default seed 1592, three scenarios, always runs in CI;
// ACP_TEST_FUZZ=1 widens to 12 scenarios, ACP_TEST_FUZZ_SEED overrides the
// base seed for replaying a failure. Failures print the scenario descriptor —
// rerun with ACP_TEST_FUZZ_SEED=<seed> to reproduce.
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

interface Scenario {
    seed: number;
    turns: number;
    fillerKb: number;
    bigFrom: number;
    bigEvery: number;
    toolKb: number;
    thresholdBytes: number;
    plan: Array<number | undefined>;
    gapless: boolean;
    absorbPct: number;
    ccr: boolean;
    toolsOnClient: boolean;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function genScenario(rnd: () => number, seed: number): Scenario {
    const turns = 10 + Math.floor(rnd() * 6); // 10..15
    const nFolds = 2 + Math.floor(rnd() * 3); // 2..4
    const plan: Array<number | undefined> = Array.from({ length: nFolds }, () => (rnd() < 0.45 ? Math.floor(rnd() * 5) : undefined));
    return {
        seed,
        turns,
        fillerKb: 3 + Math.floor(rnd() * 5),
        bigFrom: 2 + Math.floor(rnd() * 3),
        bigEvery: rnd() < 0.5 ? 2 : 1,
        toolKb: 14 + Math.floor(rnd() * 12),
        thresholdBytes: (34 + Math.floor(rnd() * 40)) * 1024,
        plan,
        gapless: rnd() < 0.5,
        absorbPct: rnd() < 0.5 ? 0.05 : 0,
        ccr: rnd() < 0.5,
        toolsOnClient: rnd() < 0.6,
    };
}

const FILLER = (seed: number, kb: number): string => {
    const para = `Fuzz ${seed}: pipeline clean, suite green, regions stable, deltas recorded. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
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

function startUpstream(captured: string[], sc: Scenario): http.Server {
    let calls = 0;
    let sinceDemand = 99;
    let lastDemandBytes = Infinity;
    let firstViewRefs: string[] | undefined;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            // Contamination guard: a previous timed-out run may leave an
            // orphaned driver whose upstream port got recycled to THIS server.
            // Foreign requests carry a different x-acp-session value — refuse
            // and skip capture so the invariant checker never compares two
            // interleaved sessions.
            if (req.headers["x-acp-session"] !== `fuzz-${sc.seed}`) {
                res.writeHead(410, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "foreign session — stale rig" }));
                return;
            }
            captured.push(body);
            let label = "0";
            const reL = /Turn (\d+):/g;
            let mm: RegExpExecArray | null;
            while ((mm = reL.exec(body)) !== null) label = mm[1]!;
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.15);
            const refs: string[] = [];
            const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(body)) !== null) refs.push(m[1]!);
            if (firstViewRefs === undefined && refs.length >= 10) firstViewRefs = refs;
            const bytes = Buffer.byteLength(body);
            const noShrink = !sc.gapless && sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9;
            const demand = bytes > sc.thresholdBytes && calls < sc.plan.length && !noShrink && refs.length >= 10;
            const compressArgs = (() => {
                if (!demand) return undefined;
                const planned = sc.plan[calls];
                const view = firstViewRefs ?? refs;
                const start = typeof planned === "number" ? (view[planned] ?? refs[2]!) : refs[2]!;
                const end = refs[refs.length - 6] ?? refs[refs.length - 1]!;
                calls++;
                sinceDemand = 0;
                lastDemandBytes = bytes;
                return JSON.stringify({ content: [{ startId: start, endId: end, topic: "fuzz fold", summary: `Fuzz-fold summary covering ${start}..${end}: shapes verified, deltas recorded, seams absent.` }] });
            })();
            sinceDemand++;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const sse = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`);
            if (compressArgs !== undefined) {
                sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_cmp_${calls}`, type: "function", function: { name: "compress", arguments: "" } }] } }] });
                for (let i = 0; i < compressArgs.length; i += 64) sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: compressArgs.slice(i, i + 64) } }] } }] });
                sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
            } else {
                sse({ choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            }
            res.end();
        });
    });
}

async function drive(sc: Scenario, sessionId: string): Promise<string[]> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seamfuzz-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    const captured: string[] = [];
    const upstream = startUpstream(captured, sc);
    let proxy: http.Server | undefined;
    try {
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const proxyOptions: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-fuzz": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: {
                injectTool: true,
                injectNudge: true,
                absorb: { enabled: true, contextThresholdPct: sc.absorbPct },
                ...(sc.ccr ? { ccr: { enabled: true, minToolTokens: 50 } } : {}),
            },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(proxyOptions);
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const clientTools = sc.toolsOnClient ? [{ type: "function", function: { name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }] : undefined;
        const hist: Msg[] = [{ role: "system", content: "You are a coding agent. Follow conventions. Run tests." }];
        for (let t = 1; t <= sc.turns; t++) {
            hist.push({ role: "user", content: `Turn ${t}: analyze module ${t}. ` + FILLER(t, sc.fillerKb) });
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model: "gpt-fuzz", stream: true, tools: clientTools, messages: [...hist] }) });
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
                hist.push({ role: "assistant", content: null, tool_calls: [{ id: "call_cmp", type: "function", function: { name: "compress", arguments: comp } }] });
                hist.push({ role: "tool", tool_call_id: "call_cmp", content: "fuzz fold receipt" });
            } else {
                hist.push({ role: "assistant", content: reply });
            }
            if (t >= sc.bigFrom && (t - sc.bigFrom) % sc.bigEvery === 0) {
                hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls mod-${t}` }) } }] });
                hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: `total 8\n${FILLER(t, sc.toolKb)}` });
            }
        }
        if (process.env.FUZZ_DUMP) {
            fs.mkdirSync(process.env.FUZZ_DUMP, { recursive: true });
            captured.forEach((b, i) => fs.writeFileSync(path.join(process.env.FUZZ_DUMP, `${String(i).padStart(3, "0")}.json`), b));
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

function assertPairSeamStable(prev: string, cur: string, label: string): void {
    const a = JSON.parse(prev) as Item;
    const b = JSON.parse(cur) as Item;
    assert.deepEqual(b.tools ?? null, a.tools ?? null, `${label}: tools array mutated between consecutive requests (element-0 prefix break)`);
    const ma = msgsOf(a);
    const mb = msgsOf(b);
    let k = 0;
    const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
    while (k < Math.min(ma.length, mb.length) && eq(ma[k], mb[k])) k++;
    // Sanctioned classes (geometry pinned per-wire by the matrix F1-F3):
    //  - a NEW summary at the divergence element, or
    //  - the round-2 <-> steady-anchor swap: one side is the compress
    //    re-request (ephemeral tool pair rides the wire exactly once) and the
    //    other side carries the landed summary carrier somewhere in the body.
    const summaryInB = JSON.stringify(b).includes("Fuzz-fold summary covering");
    const anchorSwap = (isRound2(a) || isRound2(b)) && summaryInB;
    const summaryNew = JSON.stringify(mb[k] ?? "").includes("Fuzz-fold summary covering");
    // Sanction BOTH directions of the kernel's emergency-truncation band:
    // applying (marker in the new body) and reverting (marker in the old body,
    // estimate-grade tokenCount oscillation around truncate.threshold — a
    // kernel-side hysteresis question, not a host seam).
    const emergencyTrunc = JSON.stringify(mb[k] ?? "").includes("[truncated for context space]") || JSON.stringify(ma[k] ?? "").includes("[truncated for context space]");
    assert.ok(
        k >= ma.length - 3 || summaryNew || anchorSwap || emergencyTrunc,
        `${label}: mid-history divergence at message[${k}] of ${ma.length} (round2=${isRound2(b)}) — unsanctioned cache seam`,
    );
}

const baseSeed = Number(process.env.ACP_TEST_FUZZ_SEED ?? 1592);
const scenarios = process.env.ACP_TEST_FUZZ === "1" ? 12 : 3;

test(`cache-seam fuzz: ${scenarios} randomized scenarios (seed ${baseSeed})`, { timeout: 20 * 60_000 }, async () => {
    const rnd = mulberry32(baseSeed);
    for (let s = 0; s < scenarios; s++) {
        const sc = genScenario(rnd, baseSeed + s);
        // Adaptive fold forcing: a scenario whose threshold never trips the
        // compress demand is degenerate (checks nothing) — halve the
        // threshold and rerun, up to twice.
        let bodies = await drive(sc, `fuzz-${sc.seed}`);
        const foldsIn = (bs: string[]): number => bs.filter((b) => isRound2(JSON.parse(b) as Item)).length;
        for (let retry = 0; retry < 2 && (bodies.length < 8 || foldsIn(bodies) < 1); retry++) {
            sc.thresholdBytes = Math.floor(sc.thresholdBytes / 2);
            bodies = await drive(sc, `fuzz-${sc.seed}`);
        }
        assert.ok(bodies.length >= 8, `scenario ${JSON.stringify(sc)}: expected >= 8 requests, got ${bodies.length}`);
        let folds = foldsIn(bodies);
        for (let i = 1; i < bodies.length; i++) assertPairSeamStable(bodies[i - 1]!, bodies[i]!, `seed ${sc.seed} pair ${i}->${i + 1}`);
        assert.ok(folds >= 1, `scenario ${JSON.stringify(sc)}: no fold ever fired — rig degenerate after retries`);
        if (sc.ccr) {
            // per-ref placeholder stability (see cache-seam-probes P3)
            const refRe = /\[acp-stored #(m\d+) /g;
            const seen = new Map<string, string>();
            bodies.forEach((b, i) => {
                for (const m of msgsOf(JSON.parse(b) as Item)) {
                    const j = JSON.stringify(m);
                    if (!j.includes("[acp-stored")) continue;
                    let mm: RegExpExecArray | null; refRe.lastIndex = 0;
                    while ((mm = refRe.exec(j)) !== null) {
                        const prev = seen.get(mm[1]!);
                        if (prev === undefined) seen.set(mm[1]!, j);
                        else assert.equal(j, prev, `seed ${sc.seed} body ${i}: placeholder ${mm[1]} mutated`);
                    }
                }
            });
        }
    }
});
