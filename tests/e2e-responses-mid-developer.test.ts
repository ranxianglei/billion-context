// E2E regression for #1999 — same bug class as #355/#377/#428, but on the
// RESPONSES wire. After any compress fold the kernel renders each active
// block's summary as a role:"system" core message anchored mid-history, and
// coreToResponses projects that to a `developer` input item AT ITS POSITION.
// Strict single-system backends (Qwen3-family "system-first" chat templates
// behind local /v1/responses engines) map developer→system and reject every
// subsequent request with 400 "System message must be at the beginning" —
// the fold state persists, so the whole session is dead after one fold.
//
// The fix re-voices surviving system/developer core messages to user BEFORE
// the responses codec (the same policy the chat wire applies via systemToUser
// after coreToOpenai), so the wire invariant this suite pins is: in EVERY
// forwarded body, system/developer message items form a contiguous LEADING
// prefix (in practice just the injected head developer item). The mock
// upstream emulates the strict backend: a mid-input system/developer item
// yields the exact 400 the reporter's engine produced.
//
// Three lanes through the REAL proxy (startServer + capturing upstream):
//   1. plugin lane, PRUNED echo — DSH shape: the host executes compress via
//      POST /__bili/plugin/tool but its next request does NOT carry the
//      function_call pair (pruned/flattened history) → stripKernelSummaries
//      keeps the anchor → pre-fix this was the fatal mid-history developer.
//   2. plugin lane, ECHOED pair — happy path: the pair rides inbound history,
//      the anchor is stripped, the summary rides exactly once (in the call
//      args). Pins that the fix does not break the #1567 carrier handoff.
//   3. proxy lane, INLINE loop — the model streams a compress function_call,
//      the proxy executes it server-side; the pair never enters the client
//      history, so the anchor ALWAYS survives alongside the loop records.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ProxyOptions } from "../src/config.ts";

// XDG env BEFORE importing the server (e2e-plugin-grow-compress pattern):
// boot-time conversation restore must not read a developer-local state dir.
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-middev-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

type Item = Record<string, unknown>;

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}

const FILLER = "the quick brown fox jumps over the lazy dog. ";

function userText(i: number): string {
    return `user turn ${i}: ${FILLER.repeat(12)}`;
}

/** Refs attached to CONVERSATION message items only (the head developer item
 *  carrying instructions is skipped — it is not a conversation message). */
function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    try {
        const parsed = JSON.parse(body) as { input?: Item[] };
        for (const item of parsed.input ?? []) {
            if (item.type !== "message") continue;
            const c = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(c)) !== null) ids.push(m[1]!);
        }
    } catch {
        // non-JSON body — no refs
    }
    return ids;
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

/** sglang/Qwen3-template invariant (#1999): system-class items must form a
 *  contiguous leading prefix of the input array. Returns the violating item,
 *  or null when the body is clean. */
function findMidSysDev(body: string): { index: number; role: string } | null {
    let input: Item[];
    try {
        input = (JSON.parse(body) as { input?: Item[] }).input ?? [];
    } catch {
        return null;
    }
    let firstNonSysDev = -1;
    for (let j = 0; j < input.length; j++) {
        const it = input[j]!;
        const sysDev = it.type === "message" && (it.role === "system" || it.role === "developer");
        if (!sysDev) { firstNonSysDev = j; break; }
    }
    if (firstNonSysDev === -1) return null;
    for (let j = firstNonSysDev; j < input.length; j++) {
        const it = input[j]!;
        if (it.type === "message" && (it.role === "system" || it.role === "developer")) {
            return { index: j, role: String(it.role) };
        }
    }
    return null;
}

function assertNoMidSysDev(label: string, body: string): void {
    const bad = findMidSysDev(body);
    assert.equal(bad, null, `${label}: role "${bad?.role}" at index ${bad?.index} AFTER the leading prefix — strict single-system backend would 400 "System message must be at the beginning"`);
}

type Harness = {
    url: string;
    toolUrl: string;
    bodies: string[];
};

async function withHarness(handler: (raw: string, bodies: string[]) => string, fn: (h: Harness) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Strict-backend emulation: the Qwen3-family chat template rejects a
            // system/developer item past the leading prefix with exactly this 400.
            const bad = findMidSysDev(raw);
            if (bad !== null) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ code: "invalid_prompt", message: `artifact:chat_template.jinja: System message must be at the beginning (${bad.role} at input index ${bad.index})` }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(handler(raw, bodies));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 1, maxSummaryLength: 20000, minSummaryLength: 1 },
        }),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1`;
    const h: Harness = { url: `${base}/responses`, toolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, bodies };
    try {
        await fn(h);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
}

async function turn(h: Harness, headers: Record<string, string>, input: Item[]): Promise<void> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "gpt-test", stream: true, instructions: "mid-developer e2e agent", input }),
    });
    const text = await r.text();
    assert.equal(r.status, 200, `turn failed: HTTP ${r.status}: ${text.slice(0, 500)}`);
}

async function pluginCompress(h: Harness, conversationId: string, args: unknown): Promise<string> {
    const tr = await fetch(h.toolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, tool: "compress", args }),
    });
    const tj = (await tr.json()) as { ok?: boolean; error?: string; result?: string };
    assert.ok(tr.status === 200 && tj.ok === true, `plugin compress failed: HTTP ${tr.status} ${JSON.stringify(tj)}`);
    return tj.result ?? "";
}

test("#1999 plugin lane: pruned compress echo keeps the Responses wire strict-backend-safe", async () => {
    await withHarness((_raw, bodies) => completed(100), async (h) => {
        const conv = "middev-plugin-pruned";
        const headers = { "x-bili-plugin": "dsh-e2e", "x-bili-plugin-conversation": conv, "x-bili-plugin-model": "gpt-test" };
        const input: Item[] = [];
        for (let i = 1; i <= 10; i++) {
            input.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(i) }] });
            await turn(h, headers, input);
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply ${i}` }] });
        }
        const refs = parseRefIds(h.bodies[h.bodies.length - 1]!);
        assert.ok(refs.length >= 13, `expected >=13 refs on the wire, got ${refs.length}`);
        const args = { content: [{ startId: refs[2]!, endId: refs[refs.length - 10]!, topic: "middev e2e", summary: "MIDDEV-PRUNED-MARKER early segment folded" }] };
        await pluginCompress(h, conv, args);
        // Next turn WITHOUT echoing the pair (the client pruned the tool
        // exchange) — the anchor is the only carrier and must ride legally.
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(11) }] });
        await turn(h, headers, input);
        assert.ok(h.bodies.length >= 11, "post-fold turn must reach upstream");
        const last = h.bodies[h.bodies.length - 1]!;
        assert.ok(last.includes("MIDDEV-PRUNED-MARKER"), "summary carrier must survive a pruned echo");
        // Every earlier body passed the invariant inside the mock already;
        // re-assert the post-fold one here for a readable failure message.
        assertNoMidSysDev("post-fold request", last);
    });
});

test("#1999 plugin lane: echoed compress pair keeps the anchor stripped (no double carrier)", async () => {
    await withHarness((_raw, bodies) => completed(100), async (h) => {
        const conv = "middev-plugin-echo";
        const headers = { "x-bili-plugin": "dsh-e2e", "x-bili-plugin-conversation": conv, "x-bili-plugin-model": "gpt-test" };
        const input: Item[] = [];
        for (let i = 1; i <= 10; i++) {
            input.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(i) }] });
            await turn(h, headers, input);
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply ${i}` }] });
        }
        const refs = parseRefIds(h.bodies[h.bodies.length - 1]!);
        assert.ok(refs.length >= 13, `expected >=13 refs on the wire, got ${refs.length}`);
        const args = { content: [{ startId: refs[2]!, endId: refs[refs.length - 10]!, topic: "middev e2e", summary: "MIDDEV-ECHO-MARKER early segment folded" }] };
        await pluginCompress(h, conv, args);
        // The client echoes the pair (object-form args, the DSH contract).
        input.push({ type: "function_call", call_id: "call_echo_1", name: "compress", arguments: JSON.stringify(args) });
        input.push({ type: "function_call_output", call_id: "call_echo_1", output: "compressed" });
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(11) }] });
        await turn(h, headers, input);
        const last = h.bodies[h.bodies.length - 1]!;
        assert.ok(last.includes("MIDDEV-ECHO-MARKER"), "echoed pair must ride the wire");
        assert.ok(last.includes("call_echo_1"), "echoed function_call item must survive to upstream");
        assert.equal(countOccurrences(last, "MIDDEV-ECHO-MARKER"), 1, "anchor stripped while the pair carries the summary — no double carrier");
        assert.ok(!last.includes("[Compressed conversation section]"), "kernel-rendered anchor must be stripped in the happy path");
        assertNoMidSysDev("post-fold request", last);
    });
});

test("#1999 proxy lane: inline compress loop keeps the Responses wire strict-backend-safe", async () => {
    let fired = false;
    await withHarness((raw, bodies) => {
        if (!fired && bodies.length >= 10) {
            const refs = parseRefIds(raw);
            if (refs.length >= 13) {
                fired = true;
                const args = JSON.stringify({ content: [{ startId: refs[2]!, endId: refs[refs.length - 10]!, topic: "middev e2e", summary: "MIDDEV-PROXY-MARKER early segment folded" }] });
                return fcEvents("call_px", args) + completed(100);
            }
        }
        return completed(100);
    }, async (h) => {
        const headers = { "x-acp-session": "middev-proxy" };
        const input: Item[] = [];
        for (let i = 1; i <= 12; i++) {
            input.push({ type: "message", role: "user", content: [{ type: "input_text", text: userText(i) }] });
            await turn(h, headers, input);
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply ${i}` }] });
        }
        assert.ok(fired, "mock never fired the inline compress — ref layout unexpected");
        const foldBody = h.bodies.find((b) => b.includes("call_px"));
        assert.ok(foldBody, "loop-generated compress pair must ride a rebuilt upstream view");
        assert.ok(foldBody!.includes("MIDDEV-PROXY-MARKER"), "summary must ride the post-fold request");
        const last = h.bodies[h.bodies.length - 1]!;
        assert.ok(last.includes("MIDDEV-PROXY-MARKER"), "folded summary must persist on later requests (persisted block)");
        assertNoMidSysDev("final request", last);
    });
});
