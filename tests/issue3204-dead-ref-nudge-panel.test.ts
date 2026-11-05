// #3204: three production lines advertised DEAD-ref spans from the
// unfiltered nudge.compressibleRanges — the model-decision directive surface
// (compress.nudgeModelDecided=true), the DEFAULT prose nudge (renderNudgeText
// lists the same spans for every session without nudgeModelDecided), and the
// /acp panel's compressibleRanges field + text. The submit gate rejects any
// span that brackets a ref recorded DEAD (the client rewrote/dropped those
// messages), so advertising them guarantees a doomed compress call plus
// breaker-count pollution on the nudge surfaces, and a panel-vs-tool split
// (#2778 class) on the panel surface. All lines now filter through
// excludeDeadRefRanges at one point per lane; these tests pin all three
// surfaces end-to-end through the real pipeline.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

const root = mkdtempSync(join(tmpdir(), "bili-issue3204-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

function refNum(ref: string): number {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
}

/** Ref assigned to the Nth first-seen message (refs mint in first-seen order). */
function refOfIndex(byRef: Record<string, string>, index: number): string {
    const refs = Object.keys(byRef).sort((a, b) => refNum(a) - refNum(b));
    return refs[index]!;
}

function parseSpans(text: string): Array<[number, number]> {
    return [...text.matchAll(/m(\d{4,})\s*[\u2013-]\s*m(\d{4,})/g)].map((m) => [parseInt(m[1]!, 10), parseInt(m[2]!, 10)]);
}

function brackets(span: [number, number], n: number): boolean {
    return n >= Math.min(span[0], span[1]) && n <= Math.max(span[0], span[1]);
}

function spanLabel(span: [number, number]): string {
    return `m${String(span[0]).padStart(4, "0")}\u2013m${String(span[1]).padStart(4, "0")}`;
}

function okJson(promptTokens: number): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

// Same 29-message history as nudge-model-decided.test.ts: 50k/64k = 78%
// arms the OVER-LIMIT tier-1 nudge deterministically (not EMERGENCY, so it
// routes through the model-decided path when enabled). Index 14 is q6 — the
// middle filler the client drops between turns.
const DROPPED_INDEX = 14;
function turn2Messages(): Record<string, unknown>[] {
    const longText = "y".repeat(20_000);
    const filler: { role: "user" | "assistant"; content: string }[] = [];
    for (let i = 1; i <= 12; i++) {
        filler.push({ role: "user", content: `q${i} ` + "f".repeat(997) });
        filler.push({ role: "assistant", content: `a${i} ` + "e".repeat(997) });
    }
    return [
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
        { role: "assistant", content: longText },
        ...filler,
        { role: "user", content: "now summarize" },
    ];
}

async function openaiScenario(sessionId: string, decided: boolean) {
    const mains: Record<string, unknown>[][] = [];
    const sides: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
            const textOf = (m: Record<string, unknown>): string => (typeof m.content === "string" ? m.content : "");
            if (typeof body.max_tokens === "number" && body.max_tokens <= 200) {
                sides.push(textOf(messages[messages.length - 1] ?? {}));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-decide",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: '{"compress": true}' }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 50_000, completion_tokens: 10, total_tokens: 50_010 },
                }));
                return;
            }
            mains.push(messages);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(50_000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-v4-flash": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: {
            injectTool: true,
            injectNudge: true,
            nudgeModelDecided: decided,
            // Narrow recent-tail protection (like the panel harness below) so
            // the compressible set reaches the middle of the history where the
            // dead ref sits — the default 5K-token budget would park it in the
            // protected zone and mask the defect.
            preserveRecentMessages: 1,
            preserveRecentTokens: 0,
            minCompressRangeChars: 100,
        },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": sessionId };
        const post = (messages: unknown[]) => fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 64_000, messages }) });

        let r = await post([{ role: "user", content: "hello" }]);
        assert.equal(r.status, 200);
        await r.text();
        r = await post(turn2Messages());
        assert.equal(r.status, 200);
        await r.text();

        // The client's next replay drops one middle filler (q6) — host-side
        // history normalization. Its ref stays in byRef but backs no visible
        // message: dangling. Production records the tombstone when a compress
        // attempt names it ("cannot be anchored"); the tests inject the same
        // state directly, the seam #3195's regression test established.
        const session = getSession(sessionId);
        assert.ok(session, "session must be resolvable by its header id");
        const deadRef = refOfIndex(session.state.messageRefs.byRef, DROPPED_INDEX);
        session.state.deadRefs = [deadRef];

        r = await post([
            ...turn2Messages().slice(0, DROPPED_INDEX),
            ...turn2Messages().slice(DROPPED_INDEX + 1),
            { role: "assistant", content: "ok" },
            { role: "user", content: "keep going" },
        ]);
        assert.equal(r.status, 200);
        await r.text();
        return { mains, sides, deadRef };
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
}

test("#3204: the decision prompt and injected directive never name a span bracketing a DEAD ref", async () => {
    const { mains, sides, deadRef } = await openaiScenario("decide-dead", true);
    const dead = refNum(deadRef);
    assert.equal(sides.length, 2, "both OVER-LIMIT tier-1 arms must fire a decision side call");
    assert.ok(sides[0]?.includes("[bili-compress-decision]"), "first side call carries the decision question");
    assert.ok(parseSpans(sides[0] ?? "").length > 0, "pre-drop decision prompt lists compressible spans");
    assert.equal(mains[1]?.length, 31, "pre-drop yes verdict injects the directive (29 client + system + directive)");

    for (const span of parseSpans(sides[1] ?? "")) {
        assert.ok(!brackets(span, dead), `post-drop decision prompt must not offer the ${deadRef}-bracketing span ${spanLabel(span)}`);
    }
    const directives = (mains[2] ?? []).filter((m) => typeof m.content === "string" && (m.content as string).includes("[bili-compress-directive]"));
    for (const d of directives) {
        for (const span of parseSpans(d.content as string)) {
            assert.ok(!brackets(span, dead), `injected directive must not target the ${deadRef}-bracketing span ${spanLabel(span)}`);
        }
    }
});

test("#3204: the default prose nudge never lists a span bracketing a DEAD ref", async () => {
    const { mains, deadRef } = await openaiScenario("prose-dead", false);
    const dead = refNum(deadRef);
    const nudgeOf = (ms: Record<string, unknown>[] | undefined) =>
        (ms ?? []).filter((m) => typeof m.content === "string" && (m.content as string).includes("Compressible ranges"));
    const pre = nudgeOf(mains[1]);
    assert.equal(pre.length, 1, "pre-drop turn injects the prose nudge");
    const preSpans = parseSpans(pre[0]!.content as string);
    assert.ok(preSpans.length > 0, "pre-drop nudge lists compressible spans");
    assert.ok(preSpans.some((s) => brackets(s, dead)), "sanity: pre-drop nudge offers the dead-bracketing span");
    const post = nudgeOf(mains[2]);
    assert.equal(post.length, 1, "post-drop turn still injects the prose nudge (~78% re-arms the arm)");
    const postSpans = parseSpans(post[0]!.content as string);
    assert.ok(postSpans.length > 0, "post-drop nudge still lists live spans (filter must not blank the list)");
    for (const span of postSpans) {
        assert.ok(!brackets(span, dead), `post-drop prose nudge must not offer the ${deadRef}-bracketing span ${spanLabel(span)}`);
    }
});

async function panelScenario() {
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: join(root, "sessions-panel"), enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const usage = { input_tokens: 50_000, cache_read_input_tokens: 0, output_tokens: 10 };
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_panel", role: "assistant", content: [{ type: "text", text: "answer" }], usage }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "claude-test": { context: 64_000 } } } },
        modelContextLimit: 64_000,
        kernelConfig: defaultConfig(64_000),
        compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;

    const send = async (history: unknown[]) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "deadpanel" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: history }) });
        assert.equal(r.status, 200, await r.text());
    };
    const status = async () => {
        const r = await fetch(`${origin}/__bili/plugin/status?conversationId=deadpanel`);
        assert.equal(r.status, 200);
        return (await r.json()) as { compressibleRanges: Array<{ startRef: string; endRef: string }> | null; panel?: string };
    };
    const close = async () => {
        store.cancelAll();
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    };

    const history = turn2Messages();
    await send(history);
    const session = resolveConversation("deadpanel").session!;
    const deadRef = refOfIndex(session.state.messageRefs.byRef, DROPPED_INDEX);
    await send([
        ...history.slice(0, DROPPED_INDEX),
        ...history.slice(DROPPED_INDEX + 1),
        { role: "assistant", content: "answer" },
        { role: "user", content: "keep going" },
    ]);
    session.state.deadRefs = [deadRef];
    return { status, deadRef, close };
}

test("#3204: the /acp panel never lists a compressible range bracketing a DEAD ref", async () => {
    const h = await panelScenario();
    try {
        const st = await h.status();
        const dead = refNum(h.deadRef);
        assert.ok(Array.isArray(st.compressibleRanges) && st.compressibleRanges.length > 0, "sanity: at ~78% usage the nudge is armed and lists ranges");
        for (const r of st.compressibleRanges!) {
            assert.ok(!brackets([refNum(r.startRef), refNum(r.endRef)], dead), `panel field must not list ${r.startRef}\u2013${r.endRef} spanning ${h.deadRef}`);
        }
        for (const span of parseSpans(st.panel ?? "")) {
            assert.ok(!brackets(span, dead), `panel text must not render the ${h.deadRef}-bracketing span ${spanLabel(span)}`);
        }
    } finally {
        await h.close();
    }
});
