// #2446 方案A: compress.protectedContentMarkers — the user-config lane of
// the durable-message protocol. The built-in lane table (dsh) is evidence-
// gated and proxy mode carries no client identity at all; this knob lets the
// OPERATOR declare carrier substrings himself (e.g. dsh's "Instructions
// from:" through proxy mode) pending lane evidence or host-side marker
// adoption. This suite pins: config validation (loud rejects, trims), the
// fold-time effect in a lane-less session (a marked message survives a
// positional fold that swallows its neighbors, an unmarked one does not),
// composition with the #2555 first-line marker, and that an absent/removed
// marker list stops pinning (config reflects current policy, not history).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { parseCompressSettings } from "../src/config.ts";
import type { ProxyOptions } from "../src/config.ts";
import { resetPersonaAnchorsForTest } from "../src/persona-anchor.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are the main coding agent.";
const CARRIER = "Instructions from: never force-push master, never merge PRs";
const MARKERS = ["Instructions from:"];
const DURABLE_MARKED = "\x3cbili-durable kind=\"memory\"\x3e\nmarked channel: never force-push master";

function filler(tag: string): string {
    return `${tag}-` + "z".repeat(900);
}

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(markers: string[] | undefined): Promise<Rig> {
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
        compress: markers === undefined ? { injectTool: true, injectNudge: false } : { injectTool: true, injectNudge: false, protectedContentMarkers: markers },
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
        messages = (JSON.parse(body) as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? [];
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

async function compressCall(port: number, conv: string, startId: string, endId: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            conversationId: conv,
            tool: "compress",
            args: {
                topic: "i2446c fold",
                content: [{ startId, endId, topic: "i2446c fold", summary: "i2446c fold summary: filler turns were discussed and consumed; nothing else survived this range." }],
            },
        }),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

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

async function post(rig: Rig, conv: string, history: Array<{ role: string; content: string }>): Promise<string> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": conv }, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...history] }) });
    assert.equal(r.status, 200);
    await r.text();
    return rig.bodies.at(-1)!;
}

test("config validation: accepted shape, trims, loud rejects", () => {
    const ok = parseCompressSettings({ protectedContentMarkers: ["  Instructions from: ", "\x3cmcp_catalog\x3e"] });
    assert.deepEqual(ok?.protectedContentMarkers, ["Instructions from:", "\x3cmcp_catalog\x3e"], "valid markers parse and trim");
    assert.equal(parseCompressSettings({ protectedContentMarkers: [] }), undefined, "empty array rejects (a bare [] is almost certainly a typo, and a no-op list pins nothing)");
    assert.equal(parseCompressSettings({ protectedContentMarkers: "Instructions from:" }), undefined, "non-array rejects");
    assert.equal(parseCompressSettings({ protectedContentMarkers: ["ok", 42] }), undefined, "non-string entries reject");
    assert.equal(parseCompressSettings({ protectedContentMarkers: ["ok", "   "] }), undefined, "blank-string entries reject");
});

test("lane-less session: a configured carrier survives a positional fold; unmarked content does not", async () => {
    const rig = await startRig(MARKERS);
    try {
        const conv = "i2446c-fold";
        await grow(rig, conv, [
            filler("F1"), filler("A1"),
            CARRIER,
            filler("F3"), filler("A3"), filler("F4"), filler("A4"), filler("F5"), filler("A5"),
        ]);
        const refIds = parseRefIds(rig.bodies.at(-1)!);
        assert.ok(refIds.length >= 8, `expected >=8 refs, got ${refIds.length}`);
        // The protected carrier renders UNTAGGED (kernel assignRefs: protected
        // messages get BLOCKED_REF — never advertised, never folded), so the
        // tagged ref stream skips it: 8 refs for 9 messages is the pin itself.
        const fold = await compressCall(rig.proxyPort, conv, refIds[0]!, refIds[refIds.length - 4]!);
        assert.equal(fold.status, 200);
        assert.ok(fold.status === 200 && fold.json.ok === true, `compress must succeed: ${JSON.stringify(fold.json)}`);
        const hist = histOf(conv);
        const body = await post(rig, conv, [...hist, { role: "user", content: filler("F6") }]);
        assert.ok(body.includes("[Compressed conversation section]"), "the fold happened");
        assert.ok(body.includes("never force-push master"), "the configured carrier survives the fold");
        assert.ok(!body.includes("never force-push master, never merge PRs\u003c/acp"), "carrier is UNTAGGED prose (BLOCKED_REF: never advertised, never citable-by-ref)");
        assert.ok(!body.includes("F3-"), "post-carrier neighbors fold — the fold is real, not vetoed wholesale");
    } finally {
        await closeRig(rig);
    }
});

test("composition: config marker and #2555 first-line marker co-protect in one session", async () => {
    const rig = await startRig(MARKERS);
    try {
        const conv = "i2446c-comp";
        const durableMarked = "\x3cbili-durable kind=\"memory\"\x3e\nmarked channel: never force-push master";
        await grow(rig, conv, [
            filler("F1"), filler("A1"),
            CARRIER,
            durableMarked,
            filler("F3"), filler("A3"), filler("F4"), filler("A4"),
        ]);
        const refIds = parseRefIds(rig.bodies.at(-1)!);
        const fold = await compressCall(rig.proxyPort, conv, refIds[0]!, refIds[refIds.length - 4]!);
        assert.equal(fold.status, 200);
        assert.ok(fold.status === 200 && fold.json.ok === true, `compress must succeed: ${JSON.stringify(fold.json)}`);
        const body = await post(rig, conv, [...histOf(conv), { role: "user", content: filler("F5") }]);
        assert.ok(body.includes("never force-push master"), "config-marker channel survives");
        assert.ok(body.includes("marked channel"), "#2555 marker channel survives");
        // "never merge PRs" is CARRIER-unique (the line above matches both carriers):
        // pins the CONFIG side independently so a config-guard regression under a
        // co-present #2555 marker is caught, not masked by the durable channel's survival.
        assert.ok(body.includes("never merge PRs"), "config-marker carrier survives its own token, not just the shared substring");
        assert.ok(body.includes("[Compressed conversation section]"), "the fold happened");
        assert.ok(!body.includes("A1-"), "the pre-protected segment folds — the fold is real");
    } finally {
        await closeRig(rig);
    }
});

test("absent markers: identical content folds — the knob is the only trigger", async () => {
    const rig = await startRig(undefined);
    try {
        const conv = "i2446c-absent";
        await grow(rig, conv, [filler("F1"), filler("A1"), CARRIER, filler("F3"), filler("A3"), filler("F4"), filler("A4")]);
        const refIds = parseRefIds(rig.bodies.at(-1)!);
        const fold = await compressCall(rig.proxyPort, conv, refIds[0]!, refIds[refIds.length - 4]!);
        assert.equal(fold.status, 200);
        assert.ok(fold.status === 200 && fold.json.ok === true, `compress must succeed: ${JSON.stringify(fold.json)}`);
        const body = await post(rig, conv, [...histOf(conv), { role: "user", content: filler("F5") }]);
        assert.ok(!body.includes("never force-push master"), "without the config the SAME carrier text folds — protection comes from the knob, not the text");
        assert.ok(body.includes("[Compressed conversation section]"), "the fold happened");
    } finally {
        await closeRig(rig);
    }
});

/** Raw client-side history per conversation — re-sent verbatim (NOT the
 *  upstream-bound body, whose injected tags would switch the proxy into
 *  ref-placeholder rendering and hide inline text from the assertions). */
function histOf(conv: string): Array<{ role: string; content: string }> {
    const carriers: Record<string, Array<{ role: string; content: string }>> = {
        "i2446c-fold": [
            { role: "user", content: filler("F1") },
            { role: "assistant", content: filler("A1") },
            { role: "user", content: CARRIER },
            { role: "assistant", content: filler("F3") },
            { role: "user", content: filler("A3") },
            { role: "assistant", content: filler("F4") },
            { role: "user", content: filler("A4") },
            { role: "assistant", content: filler("F5") },
            { role: "user", content: filler("A5") },
        ],
        "i2446c-comp": [
            { role: "user", content: filler("F1") },
            { role: "assistant", content: filler("A1") },
            { role: "user", content: CARRIER },
            { role: "assistant", content: DURABLE_MARKED },
            { role: "user", content: filler("F3") },
            { role: "assistant", content: filler("A3") },
            { role: "user", content: filler("F4") },
            { role: "assistant", content: filler("A4") },
        ],
        "i2446c-absent": [
            { role: "user", content: filler("F1") },
            { role: "assistant", content: filler("A1") },
            { role: "user", content: CARRIER },
            { role: "assistant", content: filler("F3") },
            { role: "user", content: filler("A3") },
            { role: "assistant", content: filler("F4") },
            { role: "user", content: filler("A4") },
        ],
    };
    return carriers[conv]!;
}
