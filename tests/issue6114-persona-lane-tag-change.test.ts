// #6114: a conversation riding a derived-persona lane forked a NEW sibling
// lane on every system-text change — even when the incoming history was a
// strict byte-level continuation of the lane. The tag-change ladder read the
// RAW skeleton only; the lane's own skeleton (recorded at fork exit, grown
// on every later request) was never consulted back, so a host upgrade that
// rewrites the system prompt re-keyed the whole conversation onto an empty
// sibling and orphaned the lane's fold blocks (incident: ~2400-message
// session, 9 active folds, ~1.29M-token preflight blowup and client abort).
//
// Fix (src/session-resolve.ts): one more rung before the fork exit — a tag
// change whose incoming continues one of THIS id's existing derived-persona
// lanes (same discriminator segment, ≥ CONTINUATION_MIN_RUN consecutive
// same-index fragment agreements, incoming extends the lane, mainShaped)
// migrates onto that lane instead of minting a sibling. No new state: lane
// skeletons were already recorded + persisted under their lane keys. Every
// raw-key rung and the msgid rescue keep priority over the new rung.
//
// Gate discipline (#3617): the bug shape migrates, and EACH guardrail leg
// keeps its designed fork alive (stranger content, stale-shorter replay,
// shallow blob, scattered below-threshold agreement, different
// discriminator, raw-rung priority, msgid-rescue priority).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { resetSessionOrderForTest, resolveSessionOrder, sessionOrderSkeletonOf } from "../src/session-resolve.ts";
import { anthropicFirstUserFrag } from "../src/session-id.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

// Hermetic state dirs (#7.2: no environmental luck) — a stray persisted
// snapshot or affinity cache from another run would noise the rungs.
const testRoot = mkdtempSync(join(tmpdir(), "bili-6114-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type M = { role: string; content?: string | null };
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const key3 = (id: string, tag: string, disc: string): string => `${id}|sub:${fp16(tag)}:${fp16(disc)}`;
const key2 = (id: string, tag: string): string => `${id}|sub:${fp16(tag)}`;

/** Alternating user/assistant turns with distinct, padded content. */
const turns = (label: string, n: number): M[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${label}-${i}-` + "x".repeat(120) }));

const V0 = "SYS-V0";
const V1 = "SYS-V1";
const V2 = "SYS-V2";

/** Claim the raw id with a tiny unrelated history under V0, then fork +
 *  grow a three-segment persona lane under V1 from `main` (first user
 *  message = discriminator source). Returns the lane key. */
const establishLane = (id: string, main: M[], disc: string): string => {
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder(id, turns(`early-${id}`, 6), V0).action, "claim");
    assert.equal(resolveSessionOrder(id, main, V1, undefined, undefined, disc).action, "derived-persona");
    resolveSessionOrder(id, [...main, ...turns(`grow-${id}`, 2)], V1, undefined, undefined, disc);
    return key3(id, V1, disc);
};

test("#6114 regression: tag change continuing a derived-persona lane migrates onto it, no sibling minted", () => {
    const id = "sess-6114-a";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42, "lane grew with its second request");
    // Host rewrite: new system text, same conversation extended by two turns.
    const r = resolveSessionOrder(id, [...main, ...turns("more", 4)], V2, undefined, undefined, disc);
    assert.equal(r.key, lane, "continuing history must NOT mint a sibling");
    assert.equal(r.action, "reanchor");
    assert.equal(sessionOrderSkeletonOf(key3(id, V2, disc)), undefined, "no V2 sibling lane exists");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 44, "the lane skeleton grew with the migrated request");
});

test("#6114 steady state: further appends under the new tag stay on the migrated lane", () => {
    const id = "sess-6114-b";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    resolveSessionOrder(id, [...main, ...turns("more", 4)], V2, undefined, undefined, disc);
    const r = resolveSessionOrder(id, [...main, ...turns("later", 6)], V2, undefined, undefined, disc);
    assert.equal(r.key, lane, "no oscillation back to a sibling");
    assert.equal(sessionOrderSkeletonOf(key3(id, V2, disc)), undefined);
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 46);
});

test("#6114 guardrail: disjoint stranger history under a new tag still forks its own lane", () => {
    const id = "sess-6114-c";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    // Same first user message (same discriminator) but everything else diverges.
    const stranger: M[] = [{ role: "user", content: disc }, ...turns("stranger", 43)];
    const r = resolveSessionOrder(id, stranger, V2, undefined, undefined, disc);
    assert.equal(r.key, key3(id, V2, disc), "stranger mints its own lane");
    assert.equal(r.action, "derived-persona");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42, "existing lane untouched");
});

test("#6114 guardrail: stale-shorter replay under a new tag never rewinds a live lane", () => {
    const id = "sess-6114-d";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    const shortHist = main.slice(0, 10); // a prefix of the lane's own history
    const r = resolveSessionOrder(id, shortHist, V2, undefined, undefined, disc);
    assert.notEqual(r.key, lane, "shorter incoming must not adopt the longer lane");
    assert.equal(r.key, key3(id, V2, disc), "it forks fresh instead");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42, "live lane keeps its depth");
});

test("#6114 guardrail: shallow blob under a new tag still forks (no adoption without continuity)", () => {
    const id = "sess-6114-e";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    const otherDisc = "a one-shot auxiliary prompt " + "q".repeat(120);
    const r = resolveSessionOrder(id, [{ role: "user", content: "one-shot blob " + "y".repeat(120) }], V2, undefined, undefined, otherDisc);
    assert.notEqual(r.key, lane, "shallow traffic cannot ride the lane");
    assert.equal(r.key, key3(id, V2, otherDisc), "shallow traffic mints its own lane");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42);
});

test("#6114 guardrail: scattered agreement below CONTINUATION_MIN_RUN still forks", () => {
    const id = "sess-6114-f";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    const base = [...main, ...turns(`grow-${id}`, 2)]; // the lane's exact history (42 cells)
    const broken = base.map((m, i) =>
        (i === 7 || i === 15 || i === 23 || i === 31 || i === 39 ? { role: m.role, content: `broken-${i}-` + "z".repeat(120) } : m));
    // longest intact same-index run is 7 < CONTINUATION_MIN_RUN (8)
    const r = resolveSessionOrder(id, [...broken, ...turns("after", 2)], V2, undefined, undefined, disc);
    assert.equal(r.key, key3(id, V2, disc), "below-threshold scatter must not migrate");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42);
});

test("#6114 guardrail: a run with a different discriminator never collapses into another run's lane (#5095)", () => {
    const id = "sess-6114-g";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    const cont = [...main, ...turns(`grow-${id}`, 2), ...turns("cont", 2)]; // true continuation of the lane
    const otherDisc = "a DIFFERENT first-user-message task prompt" + "w".repeat(120);
    const r = resolveSessionOrder(id, cont, V2, undefined, undefined, otherDisc);
    assert.notEqual(r.key, lane, "different discriminator excludes the candidate despite full content continuity");
    assert.equal(r.key, key3(id, V2, otherDisc));
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42);
});

test("#6114 two-segment lanes (no discriminator, dsh-style): continuation under a new tag stays on the lane", () => {
    const id = "sess-6114-h";
    resetSessionOrderForTest();
    assert.equal(resolveSessionOrder(id, turns("early-dsh", 6), V0).action, "claim");
    const main = turns("main-dsh", 40);
    const lane = key2(id, V1);
    assert.equal(resolveSessionOrder(id, main, V1).key, lane, "persona fork lands on the two-segment lane");
    const r = resolveSessionOrder(id, [...main, ...turns("more-dsh", 4)], V2);
    assert.equal(r.key, lane, "two-segment lane kept across the tag change");
    assert.equal(r.action, "reanchor");
    assert.equal(sessionOrderSkeletonOf(key2(id, V2)), undefined, "no V2 sibling");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 44);
});

test("#6114 priority: a tag change that continues the RAW key still re-anchors raw over a stale lane", () => {
    const id = "sess-6114-i";
    resetSessionOrderForTest();
    const sharedHead = turns("shared", 16);
    const rawBody = [...sharedHead, ...turns("rawtail", 8)]; // raw = 24 cells
    assert.equal(resolveSessionOrder(id, rawBody, V0).action, "claim");
    // Shorter than raw (20 < 24) so NO raw-key rung fires on it: head frags
    // diverge at cell 16 (rung ②), length gate false (rung ⑤), tail frags
    // diverge (rung ⑥) — it must fork its own lane.
    const laneBody = [...sharedHead, ...turns("lanetail", 4)];
    const ldisc = laneBody[0].content as string;
    const lane = key3(id, V1, ldisc);
    assert.equal(resolveSessionOrder(id, laneBody, V1, undefined, undefined, ldisc).key, lane, "divergent tail forks the lane");
    // Continues RAW past its recorded end AND aligns with the lane's shared
    // head — the raw-key rung must win (placement: it precedes the new rung).
    const incoming = [...sharedHead, ...turns("rawtail", 8), ...turns("pmore", 4)];
    const r = resolveSessionOrder(id, incoming, V2, undefined, undefined, ldisc);
    assert.equal(r.key, id, "raw continuation outranks lane migration");
    assert.equal(r.action, "reanchor");
});

test("#6114 priority: msgid rescue to the raw key outranks lane migration", () => {
    const id = "sess-6114-j";
    const main = turns("main", 40);
    const disc = main[0].content as string;
    const lane = establishLane(id, main, disc);
    const incoming = [...main, ...turns("qm", 4)]; // continues the lane byte-for-byte
    const r = resolveSessionOrder(id, incoming, V2, undefined, undefined, disc, ["hostmsg-1"], () => ["hostmsg-1", "stored-only"]);
    assert.equal(r.key, id, "store-id overlap rescues onto the raw key before lane migration");
    assert.equal(r.action, "reanchor");
    assert.equal(sessionOrderSkeletonOf(lane)?.length, 42, "the lane was not touched");
});

// ── end to end: the incident wire (Anthropic Messages + x-claude-code-session-id) ──

function sse(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): string {
    return (
        sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sse("content_block_stop", { index: 0 }) +
        sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        sse("message_stop", {})
    );
}

function startMockUpstream(): http.Server {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(anthropicStream());
        res.end();
    });
    server.listen(0, "127.0.0.1");
    return server;
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startHarness(upstream: http.Server, over: Partial<ProxyOptions> = {}): Promise<{ proxy: http.Server; post: (headers: Record<string, string>, body?: Record<string, unknown>) => Promise<{ status: number; text: string }> }> {
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 1_000_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: false, injectNudge: false },
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
        ...over,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const post = async (headers: Record<string, string>, body?: Record<string, unknown>) => {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body ?? { model: "claude-test", stream: true, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }),
            duplex: "half",
        } as RequestInit);
        const text = await res.text();
        return { status: res.status, text };
    };
    return { proxy, post };
}

const tagJoin = (blocks: string[]): string => blocks.join("\n\n");

test("#6114 end to end: a system-text rewrite mid-conversation keeps the CC-subagent lane (and its folds) reachable", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    resetSessionOrderForTest();
    const SESSION = randomUUID();
    const ccHeaders = { "x-claude-code-session-id": SESSION };
    const upstream = startMockUpstream();
    await listen(upstream);
    const { proxy, post } = await startHarness(upstream);
    try {
        const MAIN_SYS = ["You are Claude Code, Anthropic's official CLI for Claude."];
        const SYS_V1 = ["You are a Claude agent, built on Anthropic's infrastructure.", "You are a file search specialist for testing."];
        const SYS_V2 = ["You are a Claude agent, built on Anthropic's infrastructure.", "You are a file search specialist for testing. (v2: host upgrade rewrote the prompt)"];
        const history = (prefix: string, n: number): M[] => {
            const out: M[] = [];
            for (let i = 1; i <= n; i++) {
                out.push({ role: "user", content: `${prefix}-user-${i}` });
                out.push({ role: "assistant", content: `${prefix}-assistant-${i}` });
            }
            return out;
        };
        const body = (hist: M[], system: string[]): Record<string, unknown> => ({
            model: "claude-test",
            stream: true,
            max_tokens: 1024,
            system: system.map((t) => ({ type: "text", text: t })),
            messages: hist,
        });

        for (let t = 1; t <= 3; t++) {
            const r = await post(ccHeaders, body(history("main", t), MAIN_SYS));
            assert.equal(r.status, 200, `parent turn ${t}: ${r.text}`);
        }
        const parent = peekSession(SESSION);
        assert.ok(parent, "parent session exists");
        assert.equal(parent.stats.requests, 3);

        // Histories grow past CONTINUATION_MIN_RUN (8 cells) before the
        // rewrite so the continuation rung has evidence to work with — the
        // incident lane had ~2400 messages, not 4.
        const h6 = history("sub", 6);
        const disc = anthropicFirstUserFrag(h6);
        const lane = `${SESSION}|sub:${fp16(tagJoin(SYS_V1))}:${fp16(disc)}`;
        const a1 = await post(ccHeaders, body(h6, SYS_V1));
        assert.equal(a1.status, 200, `subagent pass 1: ${a1.text}`);
        assert.ok(peekSession(lane), "subagent rides its three-segment lane");
        assert.equal(peekSession(lane)!.stats.requests, 1);

        const a2 = await post(ccHeaders, body(history("sub", 8), SYS_V1));
        assert.equal(a2.status, 200, `subagent pass 2: ${a2.text}`);
        assert.equal(peekSession(lane)!.stats.requests, 2, "successive passes of the same run stay on one lane");

        // The incident: the host upgrade rewrites the system text between two
        // passes of the SAME conversation (strict byte-continuation below).
        const h12 = history("sub", 12);
        const a3 = await post(ccHeaders, body(h12, SYS_V2));
        assert.equal(a3.status, 200, `subagent pass 3 (rewritten system): ${a3.text}`);
        assert.equal(peekSession(lane)!.stats.requests, 3, "the rewritten system text must NOT re-key the conversation");
        assert.equal(peekSession(`${SESSION}|sub:${fp16(tagJoin(SYS_V2))}:${fp16(anthropicFirstUserFrag(h12))}`), undefined, "no sibling lane was minted");
        assert.equal(peekSession(SESSION)!.stats.requests, 3, "parent session untouched");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
