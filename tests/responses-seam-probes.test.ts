// Responses-wire cache-seam probes (#1650, blind spot exposed by the #1638
// OMP-burst attribution): the chat-wire seam net (cache-seam-fuzz/-probes/-detector)
// pins byte-prefix stability for the OpenAI-chat shape only — ZERO coverage of
// the Responses wire's reasoning items. #1638's production fingerprint (cached
// pinned at 39x128 tokens, monotone 4992->21K->full recovery) points at host-side
// churn where a large opaque block sits early in the input: on the provider side
// the FIRST changed element IS the prefix-cache breakpoint.
//
// This probe drives a REAL proxy against a scripted fake Responses upstream with
// omp's faithful per-turn quad (#242 shape):
//   1. user message WITHOUT the spec-required "type" field (role+content only;
//      normalizeResponsesMessageItems stamps it at ingress)
//   2. reasoning item (opaque encrypted_content ~1KB, provider-issued rs_* id)
//   3. function_call (fc_*/call_*, status completed)
//   4. function_call_output
// over 12 consecutive turns of plain burst growth (no folds — folds are covered
// by responses-fold-cache-seam #1548 / abort-rewind-cache-seam).
//
// Invariants pinned on EVERY consecutive pair of upstream-bound bodies:
//   RP1 tools     — the tools array is hashed into the provider prefix; any
//                   per-request mutation breaks the cache at element 0.
//   RP2 prefix    — input strictly extends; element-wise identity through the
//                   stable head (divergence allowed ONLY at the trailing volatile
//                   slots: chain checkpoint / nudge / freshly appended turn items);
//                   plus a byte-level floor so key-order drift OUTSIDE `input`
//                   cannot hide behind the element walk.
//   RP3 reasoning — each rs_* item byte-identical across ALL bodies that carry
//                   it (tracked by id, since growth shifts positions), persists
//                   from introduction onward, every role-bearing item left typed
//                   by the ingress stamp (#242), and every turn's user prompt got
//                   its own kernel ref (a silently-dropped item would get none).
//
// Estimate-grade by design: the fake upstream reports NO usage field — the regime
// where token-count source disagreements surface (same rationale as the chat probes).
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

const TURNS = 12;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Deterministic base64-shaped opaque blob standing in for the provider's
 *  encrypted reasoning payload (size class matters, not content). */
const encBlob = (seed: number): string =>
    Array.from({ length: 1024 }, (_, i) => B64[(seed * 31 + i * 7) % B64.length]!).join("");

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: pipeline clean, suite green, four regions stable, metrics recorded. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const INSTRUCTIONS = ["You are a coding agent operating in a sandbox.", "Follow repo conventions strictly.", "Run tests before finishing."].join("\n") + "\n\n" + FILLER(999, 1);

const TOOLS: Item[] = [
    { type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

const asArr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const inputsOf = (p: Item): Item[] => asArr(p.input) as Item[];
const toolsOf = (p: Item): unknown => p.tools ?? null;

function listen(srv: http.Server): Promise<void> {
    return new Promise<void>((resolve) => {
        if (srv.listening) resolve();
        else srv.once("listening", () => resolve());
    });
}
async function closeServer(srv: http.Server): Promise<void> {
    const closed = once(srv, "close");
    srv.closeAllConnections?.();
    srv.close(() => {});
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Text-only Responses SSE reply. NO usage field, ever (estimate-grade
 *  session by design). Never demands compress — plain burst growth only. */
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

function startUpstream(captured: string[]): http.Server {
    let n = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            let label = "0";
            const reL = /Turn (\d+):/g;
            let mm: RegExpExecArray | null;
            while ((mm = reL.exec(body)) !== null) label = mm[1]!;
            n++;
            textSse(res, `resp_${n}`, `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2));
        });
    });
}

async function drive(sessionId: string): Promise<string[]> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "respseam-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    delete process.env.ACP_DUMP_BODY;
    const captured: string[] = [];
    const upstream = startUpstream(captured);
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
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: true, injectNudge: true },
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
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;
        const input: Item[] = [];
        for (let t = 0; t < TURNS; t++) {
            // omp's faithful quad, part 1: user message WITHOUT the spec-required
            // "type" field — normalizeResponsesMessageItems stamps it at ingress (#242).
            const userMsg: Item = { role: "user", content: `Turn ${t}: analyze module ${t}. ` + FILLER(t, 6) };
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": sessionId }, body: JSON.stringify({ model: "gpt-test", stream: true, instructions: INSTRUCTIONS, tools: TOOLS, input: [...input, userMsg] }) });
            if (!res.ok) throw new Error(`turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            let reply = "";
            for (const block of (await res.text()).split("\n\n")) {
                const line = block.split("\n").find((l) => l.startsWith("data:"));
                if (!line) continue;
                const payload = line.slice(5).trim();
                if (!payload) continue;
                const d = JSON.parse(payload) as Item;
                if (d.type === "response.output_text.delta" && typeof d.delta === "string") reply += d.delta;
            }
            assert.ok(reply.length > 0, `turn ${t}: empty SSE`);
            // omp's faithful quad, parts 2-4 (+ the echoed assistant reply).
            input.push(userMsg);
            input.push({ type: "reasoning", id: `rs_${t}`, encrypted_content: encBlob(t) });
            input.push({ type: "message", id: `msg_a${t}`, role: "assistant", content: reply });
            input.push({ type: "function_call", id: `fc_t${t}`, call_id: `call_t${t}`, name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}` }), status: "completed" });
            input.push({ type: "function_call_output", id: `fco_t${t}`, call_id: `call_t${t}`, output: `total 8\ndrwxr-xr-x mod-${t}\n${FILLER(t, 2)}` });
        }
        if (process.env.RESPONSES_SEAM_DUMP) {
            fs.mkdirSync(process.env.RESPONSES_SEAM_DUMP, { recursive: true });
            captured.forEach((b, i) => fs.writeFileSync(path.join(process.env.RESPONSES_SEAM_DUMP, `${String(i).padStart(3, "0")}.json`), b));
        }
        return captured;
    } finally {
        await closeServer(proxy!);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Longest common prefix length (UTF-16 code units) of two strings. */
function commonPrefixLen(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (a.slice(0, mid) === b.slice(0, mid)) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** Consecutive-pair walker for the Responses wire: strict growth, element-wise
 *  identity through the stable head (only the trailing volatile slots may
 *  diverge), and a byte-level floor so drift outside `input` cannot hide. */
function assertPairPrefixStable(prev: string, cur: string, label: string): void {
    const a = JSON.parse(prev) as Item;
    const b = JSON.parse(cur) as Item;
    const ia = inputsOf(a);
    const ib = inputsOf(b);
    assert.ok(ib.length > ia.length, `${label}: input shrank or stalled (${ia.length} -> ${ib.length}) — burst growth must strictly extend`);
    const eq = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
    let k = 0;
    while (k < Math.min(ia.length, ib.length) && eq(ia[k], ib[k])) k++;
    assert.ok(k >= ia.length - 3, `${label}: mid-history divergence at input[${k}] of ${ia.length} — unsanctioned cache seam on the Responses wire`);
    const minBytes = Math.min(Buffer.byteLength(prev), Buffer.byteLength(cur));
    const lcpBytes = Buffer.byteLength(prev.slice(0, commonPrefixLen(prev, cur)), "utf8");
    const tailBudget = Buffer.byteLength(JSON.stringify(ia.slice(-3))) + 512;
    assert.ok(lcpBytes >= minBytes - tailBudget, `${label}: byte-prefix LCP ${lcpBytes}/${minBytes} (${((lcpBytes / minBytes) * 100).toFixed(1)}%) below the stable-head floor (${minBytes - tailBudget}) — divergence inside the stable prefix`);
}

test("probe RP1: tools array byte-stable across consecutive Responses requests", { timeout: 90_000 }, async () => {
    const bodies = await drive("resp-seam-rp1");
    assert.ok(bodies.length >= 10, `expected >= 10 requests, got ${bodies.length}`);
    for (let i = 1; i < bodies.length; i++) {
        assert.deepEqual(toolsOf(JSON.parse(bodies[i]!) as Item), toolsOf(JSON.parse(bodies[i - 1]!) as Item), `pair ${i}->${i + 1}: tools array mutated between consecutive requests (element-0 prefix break)`);
    }
});

test("probe RP2: burst growth keeps adjacent outbound bodies prefix-stable (reasoning sits in the stable head)", { timeout: 90_000 }, async () => {
    const bodies = await drive("resp-seam-rp2");
    assert.ok(bodies.length >= 10, `expected >= 10 requests, got ${bodies.length}`);
    for (let i = 1; i < bodies.length; i++) assertPairPrefixStable(bodies[i - 1]!, bodies[i]!, `pair ${i}->${i + 1}`);
});

test("probe RP3: reasoning items byte-stable by id; ingress type stamp intact (#242)", { timeout: 90_000 }, async () => {
    const bodies = await drive("resp-seam-rp3");
    assert.ok(bodies.length >= 10, `expected >= 10 requests, got ${bodies.length}`);
    const seen = new Map<string, { firstBody: number; el: string }>();
    for (let i = 0; i < bodies.length; i++) {
        const items = inputsOf(JSON.parse(bodies[i]!) as Item);
        const present = new Set<string>();
        for (const it of items) {
            if (it.role === "user" || it.role === "assistant") {
                assert.equal(it.type, "message", `body ${i}: role-bearing item carries type=${String(it.type)} — ingress stamp missing or wrong (#242)`);
            }
            if (it.type !== "reasoning") continue;
            const id = typeof it.id === "string" ? it.id : "";
            assert.ok(id.length > 0, `body ${i}: reasoning item without an id — identity tracking impossible`);
            present.add(id);
            const j = JSON.stringify(it);
            const prevSeen = seen.get(id);
            if (prevSeen === undefined) seen.set(id, { firstBody: i, el: j });
            else assert.equal(j, prevSeen.el, `reasoning ${id} mutated between body ${prevSeen.firstBody} and ${i} — the first changed element is the provider's cache breakpoint`);
        }
        for (const [rid, meta] of seen) {
            if (meta.firstBody <= i && !present.has(rid)) {
                assert.fail(`reasoning ${rid} disappeared in body ${i} (introduced at ${meta.firstBody}) — churn/reorder signal on the Responses wire`);
            }
        }
    }
    // 12 requests carry at most rs_0..rs_10: the final turn's reasoning item is
    // only pushed after the last request goes out.
    assert.ok(seen.size >= TURNS - 1, `expected >= ${TURNS - 1} distinct reasoning items, got ${seen.size}`);
    // Untyped user prompts must have ENTERED the kernel: every turn's user
    // message got its own ref (a silently-dropped item would never get one).
    const refRe = /\x3cacp [^>]*>(m\d+)\x3c\/acp>/g;
    const refs = new Set<string>();
    let mm: RegExpExecArray | null;
    while ((mm = refRe.exec(bodies[bodies.length - 1]!)) !== null) refs.add(mm[1]!);
    assert.ok(refs.size >= TURNS, `final body carries only ${refs.size} distinct refs (< ${TURNS}) — user prompts invisible to the kernel`);
});
