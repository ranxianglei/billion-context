// #2556: POST /__bili/plugin/protect — the durable-registration AUX channel.
// The marker (#2555, tests/issue2555-bili-durable-marker.test.ts) stays the
// durable truth; registration buys zero content pollution and post-hoc
// protection of an already-emitted message. This suite pins the endpoint's
// validation contract (loud rejects, no guessing), the fold-time effect in a
// lane-less session (registered raw id survives a positional fold that
// swallows its neighbors), the clear semantics, and the guard composition
// (marker + registration co-protected in one session).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { resetPersonaAnchorsForTest } from "../src/persona-anchor.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are the main coding agent.";
const DURABLE_MARKED = "\x3cbili-durable kind=\"memory\"\x3e\nmarked channel: never force-push master";

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            bodies.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetPersonaAnchorsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 0,
            compress: { minCompressRange: 500, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream, bodies };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

/** Refs from NON-SYSTEM message content only (system prompt carries literal
 *  ACP-tag examples that a whole-body scan would mistake for live refs). */
function parseRefIds(body: string): string[] {
    let messages: Array<{ role?: string; content?: unknown }> = [];
    try {
        messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    } catch {
        return [];
    }
    const text = messages
        .filter((m) => m.role !== "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) ids.push(m[1]!);
    return ids;
}

async function protectCall(port: number, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`http://127.0.0.1:${port}/__bili/plugin/protect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function compressCall(port: number, conv: string, startId: string, endId: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            conversationId: conv,
            tool: "compress",
            args: {
                topic: "i2556 fold",
                content: [{ startId, endId, topic: "i2556 fold", summary: "i2556 fold summary: filler turns were discussed and consumed; nothing else survived this range." }],
            },
        }),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Grow a lane-less conversation; return (bodies, refs) after warmup. */
async function grow(rig: Rig, conv: string, texts: string[]): Promise<void> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const headers = { "content-type": "application/json", "x-acp-session": conv };
    const msgs: Array<{ role: string; content: string }> = [];
    for (const [i, t] of texts.entries()) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: t });
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...msgs] }) });
        assert.equal(r.status, 200);
        await r.text();
    }
}

test("protect endpoint: validation contract (loud rejects, no guessing)", async () => {
    const rig = await startRig();
    try {
        await grow(rig, "i2556-val", [filler("V1"), filler("V2")]);
        let r = await protectCall(rig.proxyPort, { refs: ["m00001"] });
        assert.equal(r.status, 400, "conversationId is required");
        assert.equal(r.json.code, "INVALID_REQUEST");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-val", refs: "m00001" });
        assert.equal(r.status, 400, "refs must be an array");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-val", refs: [] });
        assert.equal(r.status, 400, "empty refs array rejects");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-val", refs: ["not-a-ref"] });
        assert.equal(r.status, 400, "malformed ref rejects");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-val", refs: ["m00001"], clear: "yes" });
        assert.equal(r.status, 400, "clear must be boolean");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-nope", refs: ["m00001"] });
        assert.equal(r.status, 404, "unknown conversation 404s");
        assert.equal(r.json.code, "NOT_FOUND");
        r = await protectCall(rig.proxyPort, { conversationId: "i2556-val", refs: ["m099999"] });
        assert.equal(r.status, 400, "unknown ref rejects loudly");
        assert.equal(r.json.code, "UNKNOWN_REF");
        assert.ok(String(r.json.error).includes("m099999"), "the unknown ref is named in the error");
        const s = getSession("i2556-val");
        assert.equal(s.metadata["protectedRawIds"], undefined, "no registration leaks on rejects");
    } finally {
        await closeRig(rig);
    }
});

test("lane-less session: a registered ref survives a positional fold; clear re-exposes it", async () => {
    const rig = await startRig();
    try {
        const conv = "i2556-fold";
        await grow(rig, conv, [
            filler("F1"), filler("A1"),
            "KEEP-ME-REGISTERED registered channel: workspace rules live here",
            filler("A2"), filler("F3"), filler("A3"), filler("F4"), filler("A4"), filler("F5"),
        ]);
        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 9, `expected >= 9 refs, got ${refIds.length}`);
        // refIds[2] is the third wire message = KEEP-ME-REGISTERED (F1, A1, then it).
        const target = refIds[2]!;
        assert.ok(rig.bodies.some((b) => b.includes("KEEP-ME-REGISTERED")));

        let r = await protectCall(rig.proxyPort, { conversationId: conv, refs: [target] });
        assert.equal(r.status, 200);
        assert.equal(r.json.changed, 1);
        assert.equal(r.json.total, 1);
        // registration resolved ref -> raw id into metadata (persisted shape)
        const s = getSession(conv);
        const registered = s.metadata["protectedRawIds"] as string[];
        assert.equal(registered.length, 1);
        assert.equal(s.state.messageRefs.byRef[target], registered[0], "registered raw id must be the ref's own raw id");
        // re-registering the same ref is idempotent
        r = await protectCall(rig.proxyPort, { conversationId: conv, refs: [target] });
        assert.equal(r.json.changed, 0, "idempotent registration");
        assert.equal(r.json.total, 1);

        // fold a range that fully covers the registered message
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const fold = await compressCall(rig.proxyPort, conv, startId, endId);
        assert.ok(fold.status === 200 && fold.json.ok === true, `compress must succeed: ${JSON.stringify(fold.json)}`);

        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": conv };
        const post = (msgs: Array<{ role: string; content: string }>) => fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...msgs] }) });
        const history: Array<{ role: string; content: string }> = [
            { role: "user", content: filler("F1") },
            { role: "assistant", content: filler("A1") },
            { role: "user", content: "KEEP-ME-REGISTERED registered channel: workspace rules live here" },
            { role: "assistant", content: filler("A2") },
            { role: "user", content: filler("F3") },
            { role: "assistant", content: filler("A3") },
            { role: "user", content: filler("F4") },
            { role: "assistant", content: filler("A4") },
            { role: "user", content: filler("F5") },
            { role: "user", content: filler("F6") },
        ];
        const r2 = await post(history);
        await r2.text();
        const body = rig.bodies.at(-1)!;
        assert.ok(body.includes("[Compressed conversation section]"), "the fold must have happened");
        assert.ok(body.includes("KEEP-ME-REGISTERED"), "the registered message must survive the fold");
        assert.ok(!body.includes("A1-"), "folded neighbors before must be gone");
        assert.ok(!body.includes("F3-"), "folded neighbors after must be gone");

        // clear re-exposes the message to folding. Re-derive the range from
        // the CURRENT wire (fold 1 consumed the old boundary refs) and fold a
        // fresh range that covers the still-live target ref.
        const r3 = await protectCall(rig.proxyPort, { conversationId: conv, refs: [target], clear: true });
        assert.equal(r3.status, 200);
        assert.equal(r3.json.action, "clear");
        assert.equal(r3.json.total, 0);
        assert.equal(getSession(conv).metadata["protectedRawIds"], undefined, "empty set removes the key entirely");
        const liveRefs = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(liveRefs.includes(target), `target ref ${target} must still be live after fold 1: [${liveRefs.join(",")}]`);
        const fold2 = await compressCall(rig.proxyPort, conv, liveRefs[0]!, liveRefs[liveRefs.length - 2]!);
        assert.ok(fold2.status === 200 && fold2.json.ok === true, `second compress must succeed: ${JSON.stringify(fold2.json)}`);
        const r4 = await post([...history, { role: "user", content: filler("F7") }]);
        await r4.text();
        const body2 = rig.bodies.at(-1)!;
        assert.ok(!body2.includes("KEEP-ME-REGISTERED"), "after clear the same message folds away — registration was the only protection");
    } finally {
        await closeRig(rig);
    }
});

test("composition: marker channel and registered channel co-protected in one session", async () => {
    const rig = await startRig();
    try {
        const conv = "i2556-comp";
        await grow(rig, conv, [
            filler("F1"), filler("A1"),
            DURABLE_MARKED,
            "KEEP-REGISTERED too: second channel",
            filler("A2"), filler("F3"), filler("A3"), filler("F4"), filler("A4"),
        ]);
        const refIds = parseRefIds(rig.bodies.at(-1)!);
        const target = refIds[3]!; // KEEP-REGISTERED (4th wire message)
        const r = await protectCall(rig.proxyPort, { conversationId: conv, refs: [target] });
        assert.equal(r.status, 200);
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const fold = await compressCall(rig.proxyPort, conv, startId, endId);
        assert.ok(fold.status === 200 && fold.json.ok === true, JSON.stringify(fold.json));
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": conv };
        const history: Array<{ role: string; content: string }> = [
            { role: "user", content: filler("F1") },
            { role: "assistant", content: filler("A1") },
            { role: "user", content: DURABLE_MARKED },
            { role: "user", content: "KEEP-REGISTERED too: second channel" },
            { role: "assistant", content: filler("A2") },
            { role: "user", content: filler("F3") },
            { role: "assistant", content: filler("A3") },
            { role: "user", content: filler("F4") },
            { role: "assistant", content: filler("A4") },
            { role: "user", content: filler("F5") },
        ];
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...history] }) });
        await r2.text();
        const body = rig.bodies.at(-1)!;
        assert.ok(body.includes("[Compressed conversation section]"), "the fold must have happened");
        assert.ok(body.includes("never force-push master"), "marker channel survives (primary)");
        assert.ok(body.includes("KEEP-REGISTERED too"), "registered channel survives (aux)");
        assert.ok(!body.includes("A1-"), "the pre-protected segment folds — the fold is real, not vetoed wholesale");
    } finally {
        await closeRig(rig);
    }
});

test("manifest advertises the protect endpoint", async () => {
    const rig = await startRig();
    try {
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/manifest`);
        const json = (await r.json()) as { protectEndpoint?: string };
        assert.equal(json.protectEndpoint, "/__bili/plugin/protect");
    } finally {
        await closeRig(rig);
    }
});
