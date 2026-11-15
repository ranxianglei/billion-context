/**
 * A nudge the upstream rejects never reached the model, yet the kernel stamped it as
 * shown when it decided to inject (lastNudgeShownTokens / lastShownByTier). The growth
 * reference then sits at the rejected request's meter, so the cadence holds every later
 * nudge until the context grows a full growth floor past the rejected request, although
 * the model has seen no nudge. Seen in a Claude Code session on v0.1.213 (2026-11-11):
 * the session's first nudge drew `400 messages.N: role 'system' must precede an
 * 'assistant' message` (#5432), the next request was smaller than the rejected one and
 * the decision read `growth=-21002 ... (ref=178592) blocked: T1 (cadence)`.
 *
 * Scenario (token model = ceil(chars/4), matching the mock's reported input_tokens):
 *   grow turn by turn until bili injects its nudge (request k)
 *   k+1 next request  smaller than the rejected one → carries NO nudge (held until a success)
 *   k+2 next turn     small growth → nudge present again (without the fix, cadence-blocked)
 * Control session (same sizes, nudge accepted): k+2 carries no nudge — a delivered nudge
 * still holds the cadence (negative direction).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { ProxyOptions } from "../src/server.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-rejected-nudge-"));
process.env.XDG_STATE_HOME = path.join(tmpRoot, "state");
process.env.XDG_CACHE_HOME = path.join(tmpRoot, "cache");
process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "config");
delete process.env.ACP_DUMP_BODY;

const LIMIT = 200_000;
const MODEL = "claude-test";

const filler = (seed: number, chars: number): string => {
    const words = ["context", "compression", "session", "anchor", "baseline", "growth", "interval", "meter"];
    let out = "";
    let i = 0;
    while (out.length < chars) {
        out += `${words[(i + seed) % words.length]}-${seed}-${i} `;
        i += 1;
    }
    return out.slice(0, chars);
};

const SYSTEM = "You are a helpful coding assistant. Keep answers concise.\n" + filler(999, 800);
const TOOLS = [
    { name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

type Msg = { role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> };
const um = (n: number, len: number): Msg => ({ role: "user", content: [{ type: "text", text: `Task ${n}:\n${filler(n, len)}` }] });
const am = (n: number, len: number): Msg => ({ role: "assistant", content: [{ type: "text", text: `Step ${n} done.\n${filler(n + 20, len)}` }] });

const estTok = (s: string) => Math.ceil(s.length / 4);
const msgChars = (m: { content: unknown }): number => {
    const c = m.content;
    if (typeof c === "string") return c.length;
    if (Array.isArray(c)) return c.reduce((n: number, p) => n + (typeof (p as { text?: unknown })?.text === "string" ? ((p as { text: string }).text).length : 0), 0);
    return 0;
};

const NUDGE_MARK = "efficiency nudge";

test("a nudge the upstream rejected is re-armed after the next success; a delivered one is not", { timeout: 120_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { rmrf } = await import("./tmp-rm.ts");
    const { setLogCapture } = await import("../src/logger.ts");
    const logLines: string[] = [];
    setLogCapture((_level: string, msg: string) => { logLines.push(msg); });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    try {
        const bodies: Record<string, string[]> = {};
        const rejectFirstNudge = new Set<string>();
        // After the first nudge-carrying request of a session is caught, the
        // next `extraRejects[sid]` requests of that session are rejected too
        // (regardless of content) — for the consecutive-4xx scenario.
        const extraRejects: Record<string, number> = {};
        const rejectArmed = new Set<string>();
        const rejectRemaining: Record<string, number> = {};
        const nudgeAt: Record<string, number> = {};
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const sid = String(req.headers["x-claude-code-session-id"] ?? "");
                const body = Buffer.concat(chunks).toString("utf8");
                (bodies[sid] ??= []).push(body);
                if (rejectFirstNudge.has(sid) && body.includes(NUDGE_MARK) && !rejectArmed.has(sid)) {
                    rejectArmed.add(sid);
                    rejectRemaining[sid] = 1 + (extraRejects[sid] ?? 0);
                }
                if ((rejectRemaining[sid] ?? 0) > 0) {
                    rejectRemaining[sid]!--;
                    res.writeHead(400, { "content-type": "application/json", "request-id": "req_test" });
                    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.5: role 'system' must precede an 'assistant' message or end the array" } }));
                    return;
                }
                const parsed = JSON.parse(body) as { messages?: Array<{ content: unknown }>; tools?: unknown };
                const inputTokens = estTok(SYSTEM) + estTok(JSON.stringify(parsed.tools ?? [])) + (parsed.messages ?? []).reduce((n, m) => n + Math.ceil(msgChars(m) / 4), 0);
                const sse = (ev: string, data: object) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                sse("message_start", { type: "message_start", message: { id: `msg-${bodies[sid]!.length}`, role: "assistant", model: MODEL, content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } });
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
                sse("content_block_stop", { type: "content_block_stop", index: 0 });
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
                sse("message_stop", { type: "message_stop" });
                res.end();
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const baseKernel = defaultConfig(LIMIT, { preserveRecentMessages: 3, preserveRecentTokens: 800 });
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: LIMIT } } } } as ProxyOptions["routes"],
            modelContextLimit: LIMIT,
            kernelConfig: { ...baseKernel, nudge: { ...baseKernel.nudge, growthFloor: 4000, growthCap: 4000, minGrowthFloor: 100, minGrowthRatio: 0.1, tierGrowthTokens: { t1: 600 } } },
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

        const runSession = async (sid: string): Promise<{ statuses: number[]; nudged: boolean[] }> => {
            const headers = { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-session-id": sid };
            const statuses: number[] = [];
            const post = async (msgs: Msg[]): Promise<void> => {
                const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, system: SYSTEM, messages: msgs, tools: TOOLS }) });
                statuses.push(res.status);
                await res.text();
            };
            // Grow one turn at a time until bili injects its nudge (request k).
            let H: Msg[] = [um(1, 800)];
            let Hprev: Msg[] = H;
            let k = -1;
            for (let n = 1; n <= 8 && k < 0; n++) {
                await post(H);
                if ((bodies[sid] ?? []).at(-1)?.includes(NUDGE_MARK)) k = n - 1;
                else { Hprev = H; H = [...H, am(n, 6000), um(n + 1, 700)]; }
            }
            assert.ok(k >= 0, `the nudge fires within 8 turns: ${JSON.stringify({ statuses, n: (bodies[sid] ?? []).map((b) => b.includes(NUDGE_MARK)), keys: Object.keys(bodies) })}`);
            // The client's next request is smaller than the rejected one, then it takes a short turn.
            const G: Msg[] = [...Hprev, um(50, 700)];
            await post(G);
            await post([...G, am(99, 2400), um(100, 700)]);
            nudgeAt[sid] = k;
            return { statuses, nudged: (bodies[sid] ?? []).map((b) => b.includes(NUDGE_MARK)) };
        };

        rejectFirstNudge.add("11111111-1111-4111-8111-111111111111");
        const rejected = await runSession("11111111-1111-4111-8111-111111111111");
        const control = await runSession("22222222-2222-4222-8222-222222222222");

        const kr = nudgeAt["11111111-1111-4111-8111-111111111111"]!;
        const kc = nudgeAt["22222222-2222-4222-8222-222222222222"]!;
        assert.equal(rejected.statuses[kr], 400, "the upstream rejects the nudged request");
        assert.deepEqual(rejected.statuses.slice(kr + 1), [200, 200]);
        assert.equal(rejected.nudged[kr + 1], false, "the request right after the 400 carries no nudge — the nudge may be what drew it");
        assert.equal(rejected.nudged[kr + 2], true, "after a request succeeds, the undelivered nudge is re-armed");
        assert.ok(control.statuses.every((st) => st === 200));
        assert.equal(control.nudged[kc + 2], false, "control: a delivered nudge still holds the cadence on the next turn");
    } catch (err) {
        process.stderr.write(logLines.filter((l) => /nudge|upstream 4|error|502|fail/i.test(l)).join("\n") + "\n");
        throw err;
    } finally {
        setLogCapture(null);
        await closeServer(proxy);
        await closeServer(upstream);
        try { rmrf(tmpRoot); } catch { /* ignore */ }
    }
});

test("consecutive 4xxs after a rejected nudge neither re-restore the stamps nor clear the hold", { timeout: 120_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { setLogCapture } = await import("../src/logger.ts");
    const logLines: string[] = [];
    setLogCapture((_level: string, msg: string) => { logLines.push(msg); });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    const SID = "33333333-3333-4333-8333-333333333333";
    try {
        const bodies: string[] = [];
        let rejectArmed = false;   // set the moment a nudge-carrying request arrives
        let rejectRemaining = 0;   // budget: the nudge request itself + the very next one
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                bodies.push(body);
                if (!rejectArmed && body.includes(NUDGE_MARK)) {
                    rejectArmed = true;
                    rejectRemaining = 2; // reject the nudge request AND the next one
                }
                if (rejectRemaining > 0) {
                    rejectRemaining--;
                    res.writeHead(400, { "content-type": "application/json", "request-id": "req_test" });
                    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.5: role 'system' must precede an 'assistant' message or end the array" } }));
                    return;
                }
                const parsed = JSON.parse(body) as { messages?: Array<{ content: unknown }>; tools?: unknown };
                const inputTokens = estTok(SYSTEM) + estTok(JSON.stringify(parsed.tools ?? [])) + (parsed.messages ?? []).reduce((n, m) => n + Math.ceil(msgChars(m) / 4), 0);
                const sse = (ev: string, data: object) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                sse("message_start", { type: "message_start", message: { id: `msg-${bodies.length}`, role: "assistant", model: MODEL, content: [], usage: { input_tokens: inputTokens, output_tokens: 0 } } });
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
                sse("content_block_stop", { type: "content_block_stop", index: 0 });
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
                sse("message_stop", { type: "message_stop" });
                res.end();
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const baseKernel = defaultConfig(LIMIT, { preserveRecentMessages: 3, preserveRecentTokens: 800 });
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: LIMIT } } } } as ProxyOptions["routes"],
            modelContextLimit: LIMIT,
            kernelConfig: { ...baseKernel, nudge: { ...baseKernel.nudge, growthFloor: 4000, growthCap: 4000, minGrowthFloor: 100, minGrowthRatio: 0.1, tierGrowthTokens: { t1: 600 } } },
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-session-id": SID };
        const statuses: number[] = [];
        const post = async (msgs: Msg[]): Promise<void> => {
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, system: SYSTEM, messages: msgs, tools: TOOLS }) });
            statuses.push(res.status);
            await res.text();
        };

        // Grow until the nudge fires (request k); it and the next request both 400.
        let H: Msg[] = [um(1, 800)];
        let Hprev: Msg[] = H;
        let k = -1;
        for (let n = 1; n <= 8 && k < 0; n++) {
            await post(H);
            if (bodies.at(-1)?.includes(NUDGE_MARK)) k = n - 1;
            else { Hprev = H; H = [...H, am(n, 6000), um(n + 1, 700)]; }
        }
        assert.ok(k >= 0, `the nudge fires within 8 turns: ${JSON.stringify(statuses)}`);
        assert.equal(statuses[k], 400, "the nudged request is rejected");
        const G: Msg[] = [...Hprev, um(50, 700)];
        await post(G);                                     // k+1: rejected again, MUST be nudge-free
        await post([...G, am(99, 2400), um(100, 700)]);     // k+2: 200, hold still set at prepare time
        await post([...G, am(99, 2400), um(100, 700), am(101, 2400), um(102, 700)]); // k+3: 200, re-armed

        assert.deepEqual(statuses.slice(k), [400, 400, 200, 200]);
        assert.equal(bodies[k].includes(NUDGE_MARK), true, "the rejected request carried the nudge");
        assert.equal(bodies[k + 1].includes(NUDGE_MARK), false, "k+1 is nudge-free (hold) and its 4xx must not re-restore or clear anything");
        assert.equal(bodies[k + 2].includes(NUDGE_MARK), false, "k+2: the hold survives until a usage-settled success");
        assert.equal(bodies[k + 3].includes(NUDGE_MARK), true, "k+3: after the success settled usage, the undelivered nudge re-arms exactly once");
    } catch (err) {
        process.stderr.write(logLines.filter((l) => /nudge|upstream 4|error|502|fail/i.test(l)).join("\n") + "\n");
        throw err;
    } finally {
        setLogCapture(null);
        await closeServer(proxy);
        await closeServer(upstream);
    }
});

/**
 * Lane-coverage mirror (#6531 extension): the nudge rides every protocol lane
 * (anthropic/google/openai/responses), so the reject re-arm must not be
 * anthropic-only. This drives the GOOGLE lane end to end: a rejected nudge
 * request rolls the cadence back, the hold suppresses the next request, and a
 * usage-settled success re-arms the nudge — the same three-step contract as
 * the anthropic test above.
 */
type GPart = { text: string };
type GMsg = { role: "user" | "model"; parts: GPart[] };
const gu = (n: number, len: number): GMsg => ({ role: "user", parts: [{ text: `Task ${n}:\n${filler(n, len)}` }] });
const gm = (n: number, len: number): GMsg => ({ role: "model", parts: [{ text: `Step ${n} done.\n${filler(n + 20, len)}` }] });
const gChars = (m: { parts: unknown }): number => (m.parts as Array<{ text?: unknown }>).reduce((n, p) => n + (typeof p.text === "string" ? p.text.length : 0), 0);

test("the google lane re-arms a rejected nudge the same way the anthropic lane does", { timeout: 120_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { setLogCapture } = await import("../src/logger.ts");
    const logLines: string[] = [];
    setLogCapture((_level: string, msg: string) => { logLines.push(msg); });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    const SID = "44444444-4444-4444-8444-444444444444";
    try {
        const bodies: string[] = [];
        let rejectArmed = false;
        let rejectRemaining = 0;
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                bodies.push(body);
                if (!rejectArmed && body.includes(NUDGE_MARK)) {
                    rejectArmed = true;
                    rejectRemaining = 1; // reject the nudge request itself
                }
                if (rejectRemaining > 0) {
                    rejectRemaining--;
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "contents: part 7: unexpected nudge fragment (synthetic upstream rejection)" } }));
                    return;
                }
                const parsed = JSON.parse(body) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
                const promptTokens = estTok(SYSTEM) + (parsed.contents ?? []).reduce((n, m) => n + Math.ceil(gChars(m as { parts: Array<{ text?: string }> }) / 4), 0);
                const frame = {
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 1, totalTokenCount: promptTokens + 1 },
                };
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(`data: ${JSON.stringify(frame)}\n\n`);
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const baseKernel = defaultConfig(LIMIT, { preserveRecentMessages: 3, preserveRecentTokens: 800 });
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: LIMIT } } } } as ProxyOptions["routes"],
            modelContextLimit: LIMIT,
            kernelConfig: { ...baseKernel, nudge: { ...baseKernel.nudge, growthFloor: 4000, growthCap: 4000, minGrowthFloor: 100, minGrowthRatio: 0.1, tierGrowthTokens: { t1: 600 } } },
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
        const statuses: number[] = [];
        const post = async (contents: GMsg[]): Promise<void> => {
            const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": SID }, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: SYSTEM }] }, generationConfig: { maxOutputTokens: 4096 } }) });
            statuses.push(res.status);
            await res.text();
        };

        let H: GMsg[] = [gu(1, 800)];
        let Hprev: GMsg[] = H;
        let k = -1;
        for (let n = 1; n <= 8 && k < 0; n++) {
            await post(H);
            if (bodies.at(-1)?.includes(NUDGE_MARK)) k = n - 1;
            else { Hprev = H; H = [...H, gm(n, 6000), gu(n + 1, 700)]; }
        }
        assert.ok(k >= 0, `the nudge fires within 8 turns on the google lane: ${JSON.stringify(statuses)}`);
        assert.equal(statuses[k], 400, "the upstream rejects the nudged request");
        const G: GMsg[] = [...Hprev, gu(50, 700)];
        await post(G);
        await post([...G, gm(99, 2400), gu(100, 700)]);
        assert.deepEqual(statuses.slice(k + 1), [200, 200]);
        assert.equal(bodies[k + 1].includes(NUDGE_MARK), false, "k+1 carries no nudge (hold)");
        assert.equal(bodies[k + 2].includes(NUDGE_MARK), true, "k+2: the undelivered nudge re-arms after the usage-settled success");
    } catch (err) {
        process.stderr.write(logLines.filter((l) => /nudge|upstream 4|error|502|fail/i.test(l)).join("\n") + "\n");
        throw err;
    } finally {
        setLogCapture(null);
        await closeServer(proxy);
        await closeServer(upstream);
    }
});

/**
 * Route-coverage mirror (#6531 extension): the reject hold must end on ANY
 * success — including upstreams that never report usage (#1595 route class).
 * settleUsageReport only clears the flag for s.total > 0 samples, so on this
 * route the hold latched forever before the fix: one 4xx killed nudging for
 * the rest of the process lifetime. This fake upstream emits a complete
 * Anthropic stream with NO usage fields at all (input stays undefined, so the
 * no-usage success site is the one that must release the hold).
 */
test("a rejected nudge re-arms after a no-usage success on the #1595 route", { timeout: 120_000 }, async () => {
    const { defaultConfig } = await import("acp-kernel");
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { setLogCapture } = await import("../src/logger.ts");
    const logLines: string[] = [];
    setLogCapture((_level: string, msg: string) => { logLines.push(msg); });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    const closeServer = (s: http.Server | undefined): Promise<void> => s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();

    const SID = "44444444-4444-4444-8444-444444444444";
    try {
        const bodies: string[] = [];
        let rejectArmed = false;
        let rejectRemaining = 0;
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                bodies.push(body);
                if (!rejectArmed && body.includes(NUDGE_MARK)) {
                    rejectArmed = true;
                    rejectRemaining = 1; // reject only the nudge request itself
                }
                if (rejectRemaining > 0) {
                    rejectRemaining--;
                    res.writeHead(400, { "content-type": "application/json", "request-id": "req_test" });
                    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.5: role 'system' must precede an 'assistant' message or end the array" } }));
                    return;
                }
                // Complete stream, NO usage fields anywhere — the #1595 route.
                const sse = (ev: string, data: object) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                sse("message_start", { type: "message_start", message: { id: `msg-${bodies.length}`, role: "assistant", model: MODEL, content: [] } });
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
                sse("content_block_stop", { type: "content_block_stop", index: 0 });
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
                sse("message_stop", { type: "message_stop" });
                res.end();
            });
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;

        const baseKernel = defaultConfig(LIMIT, { preserveRecentMessages: 3, preserveRecentTokens: 800 });
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: LIMIT } } } } as ProxyOptions["routes"],
            modelContextLimit: LIMIT,
            kernelConfig: { ...baseKernel, nudge: { ...baseKernel.nudge, growthFloor: 4000, growthCap: 4000, minGrowthFloor: 100, minGrowthRatio: 0.1, tierGrowthTokens: { t1: 600 } } },
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: true,
            debug: false,
            passthrough: false,
            autoUpdate: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            passthroughSource: null,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const headers = { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (external, cli)", "x-claude-code-session-id": SID };
        const statuses: number[] = [];
        const post = async (msgs: Msg[]): Promise<void> => {
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 4096, stream: true, system: SYSTEM, messages: msgs, tools: TOOLS }) });
            statuses.push(res.status);
            await res.text();
        };

        // Grow until the nudge fires (request k) — on local estimates, since the
        // upstream never reports usage — then it is rejected exactly once.
        let H: Msg[] = [um(1, 800)];
        let Hprev: Msg[] = H;
        let k = -1;
        for (let n = 1; n <= 8 && k < 0; n++) {
            await post(H);
            if (bodies.at(-1)?.includes(NUDGE_MARK)) k = n - 1;
            else { Hprev = H; H = [...H, am(n, 6000), um(n + 1, 700)]; }
        }
        assert.ok(k >= 0, `the nudge fires within 8 turns on the no-usage route: ${JSON.stringify(statuses)}`);
        assert.equal(statuses[k], 400, "the nudged request is rejected");
        const G: Msg[] = [...Hprev, um(50, 700)];
        await post(G);                                    // k+1: 200, no usage reported — the hold must end here
        await post([...G, am(99, 2400), um(100, 700)]);   // k+2: re-armed

        assert.deepEqual(statuses.slice(k), [400, 200, 200]);
        assert.equal(bodies[k].includes(NUDGE_MARK), true, "the rejected request carried the nudge");
        assert.equal(bodies[k + 1].includes(NUDGE_MARK), false, "k+1 is nudge-free (hold)");
        assert.equal(bodies[k + 2].includes(NUDGE_MARK), true, "k+2: the no-usage success released the hold and the undelivered nudge re-arms — without the release it latched forever");
    } catch (err) {
        process.stderr.write(logLines.filter((l) => /nudge|upstream 4|error|502|fail/i.test(l)).join("\n") + "\n");
        throw err;
    } finally {
        setLogCapture(null);
        await closeServer(proxy);
        await closeServer(upstream);
    }
});
