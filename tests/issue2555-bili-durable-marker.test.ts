// #2555: the lane-less <bili-durable> self-declaration marker. The dsh lane
// permitlist (#2419/#2447/#2481/#2446) is closed-world: it grows only when a
// human ships a bili release and structurally cannot fire in proxy mode (no
// lane identity on the wire) even for the four carriers it knows. The marker
// protocol flips the model — any injector (host core, third-party plugin)
// stamps its durable-state message's FIRST LINE with the namespaced
// bili-durable marker and bili honors it in EVERY session. This suite pins:
// the guard's anchor semantics (first line, not mid-prose), a REAL fold
// through /__bili/plugin/tool in a lane-less proxy-shape session (the exact
// configuration #2446's reporter runs, where no lane guard can fire), the
// BLOCKED-ref stamp at assignment time, and the dsh-lane composition (marker
// AND lane carriers co-protected).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { biliDurableMarkerGuard, durableMessageGuards } from "../src/durable-message-guards.ts";
import { resetPersonaAnchorsForTest } from "../src/persona-anchor.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are the main coding agent.";
// First-line declaration, payload from line two — the documented shape.
const DURABLE_MSG = `\x3cbili-durable kind="memory-baseline"\x3e
Project context injected by the host memory plugin.
- repo: billion-context
- owner rule: never force-push master
`;

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

/** Refs from NON-SYSTEM message content only: the injected system prompt
 *  carries literal ACP-tag EXAMPLES that a whole-body scan would mistake
 *  for live refs. */
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

const msg = (contentType: string, text: unknown) => ({ id: "id-1", createdAt: 0, contentType, text }) as never;

test("biliDurableMarkerGuard: first-line anchor semantics", () => {
    assert.equal(biliDurableMarkerGuard(msg("text", DURABLE_MSG)), true, "documented shape (attributed first line + payload) pins");
    assert.equal(biliDurableMarkerGuard(msg("text", "\x3cbili-durable\x3e\nbare payload")), true, "unattributed marker pins");
    assert.equal(biliDurableMarkerGuard(msg("text", "\x3cbili-durable kind=\"x\" /\x3e\npayload")), true, "self-closing form pins");
    assert.equal(biliDurableMarkerGuard(msg("text", "\x3cbili-durable\x3e")), true, "marker-only message (no payload) pins — injector said so");
    // Misses — the false-positive surface stays closed:
    assert.equal(biliDurableMarkerGuard(msg("text", "prose first\n\x3cbili-durable\x3e\nlater")), false, "marker NOT on the first line does not pin");
    assert.equal(biliDurableMarkerGuard(msg("text", "\x3csystem-reminder\x3e\n\x3cbili-durable\x3e\n\x3c/system-reminder\x3e")), false, "a wrapper around the marker does not pin — first-line anchor is what the injector controls");
    assert.equal(biliDurableMarkerGuard(msg("text", "mentions bili durable in lowercase prose")), false, "lowercase prose never pins");
    assert.equal(biliDurableMarkerGuard(msg("text", "\x3cbili-durable-ish\x3e\npayload")), false, "lookalike tag with a suffix never pins (exact prefix)");
    assert.equal(biliDurableMarkerGuard(msg("tool-call", DURABLE_MSG)), false, "non-text content types never pin");
    assert.equal(biliDurableMarkerGuard(msg("text", undefined)), false, "missing text is safe");
    assert.equal(biliDurableMarkerGuard(msg("text", "")), false, "empty text is safe");
    // Registry discipline unchanged: the marker guard is NOT a lane entry.
    assert.deepEqual(Object.keys(durableMessageGuards), ["dsh"], "lane permitlist stays dsh-only and frozen (#2555)");
});

/** Grow a conversation (optionally lane-less: no x-bili-plugin headers at
 *  all — the proxy-mode shape from #2446), execute a real compress through
 *  /__bili/plugin/tool, and return the next turn's upstream body. */
async function runFoldScenario(opts: { agent?: string; conv: string; durableText: string }): Promise<{ postFoldBody: string; blockedRefs: number }> {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": opts.conv };
        if (opts.agent) headers["x-bili-plugin"] = opts.agent;
        if (opts.agent) headers["x-bili-plugin-conversation"] = opts.conv;
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        const msgs: Array<{ role: string; content: string }> = [];
        msgs.push({ role: "user", content: filler("F1") });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A1") });
        msgs.push({ role: "user", content: opts.durableText });
        await (await post(msgs)).text();
        msgs.push({ role: "assistant", content: filler("A2") });
        for (let i = 3; i <= 8; i++) {
            msgs.push({ role: "user", content: filler(`F${i}`) });
            await (await post(msgs)).text();
            msgs.push({ role: "assistant", content: filler(`A${i}`) });
        }

        const blockedBefore = opts.agent ? 0 : Object.entries(getSession(opts.conv).state.messageRefs.byRaw).filter(([, ref]) => ref === "BLOCKED").length;

        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 10, `expected >= 10 tagged messages, got ${refIds.length}`);
        const startId = refIds[0]!;
        const endId = refIds[refIds.length - 4]!;
        const toolRes = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                conversationId: opts.conv,
                tool: "compress",
                args: {
                    topic: "i2555 fold",
                    content: [{ startId, endId, topic: "i2555 fold", summary: "i2555 fold summary: filler turns F1..F8 were discussed and consumed; nothing else survived this range." }],
                },
            }),
        });
        const toolJson = (await toolRes.json()) as Record<string, unknown>;
        assert.ok(toolRes.status === 200 && toolJson.ok === true, `compress must succeed: HTTP ${toolRes.status} ${JSON.stringify(toolJson)}`);

        msgs.push({ role: "user", content: filler("F9") });
        await (await post(msgs)).text();
        return { postFoldBody: rig.bodies.at(-1)!, blockedRefs: blockedBefore };
    } finally {
        await closeRig(rig);
    }
}

test("lane-less session (proxy shape, #2446 reporter's config): the marker survives a positional fold", async () => {
    const { postFoldBody, blockedRefs } = await runFoldScenario({ conv: "i2555-plain", durableText: DURABLE_MSG });
    assert.ok(blockedRefs >= 1, "the marker message must carry a BLOCKED ref at assignment time — protected from the very first absorb, before any fold window could reach it");
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened (protection may not veto the whole range)");
    assert.ok(postFoldBody.includes("bili-durable"), "the marker line must survive the fold");
    assert.ok(postFoldBody.includes("never force-push master"), "the payload must survive too (one message carries declaration + content)");
    assert.ok(!postFoldBody.includes("A1-"), "folded filler before the marker must be gone");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler after the marker must be gone");
});

test("lane-less session: WITHOUT the marker the same content folds away (pins that the marker is the trigger)", async () => {
    const { postFoldBody } = await runFoldScenario({ conv: "i2555-nomarker", durableText: DURABLE_MSG.replace("\x3cbili-durable kind=\"memory-baseline\"\x3e\n", "host memory plugin says:\n") });
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(!postFoldBody.includes("never force-push master"), "identical content without the first-line declaration is ordinary history and folds away — the text itself is not what protects");
});

test("dsh lane: marker and legacy lane carriers stay co-protected (composition)", async () => {
    const { postFoldBody } = await runFoldScenario({ agent: "dsh", conv: "i2555-dsh", durableText: DURABLE_MSG });
    assert.ok(postFoldBody.includes("[Compressed conversation section]"), "the fold must have happened");
    assert.ok(postFoldBody.includes("bili-durable"), "the marker survives in the dsh lane too (lane OR marker)");
    assert.ok(!postFoldBody.includes("F5-"), "folded filler is gone");
});

test("effectiveConfig read path: lane-less sessions resolve the marker guard", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "i2555-stamp" },
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: DURABLE_MSG }] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = peekSession("i2555-stamp");
        assert.ok(s, "plain session exists");
        const sFull = getSession("i2555-stamp");
        const blockedRefs = Object.entries(sFull.state.messageRefs.byRaw).filter(([, ref]) => ref === "BLOCKED").length;
        assert.ok(blockedRefs >= 1, "a no-lane session stamps BLOCKED on the marker message at assignment — the wire path attached the guard without any pluginAgent");
    } finally {
        await closeRig(rig);
    }
});
