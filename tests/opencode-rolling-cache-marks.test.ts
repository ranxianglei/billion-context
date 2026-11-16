import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";
import { __resetIncrementalClientForTests, noteIncrementalAck, noteIncrementalRejection, planIncrementalTurn, type IncrementalWireMessage } from "../src/agent/incremental-client.ts";

// Hosts like OpenCode keep a ROLLING cache_control breakpoint: every request
// marks only its newest messages, so an already-acknowledged message changes
// bytes (it loses its mark) on the next request. Before the retouch channel
// the client's prefix alignment saw that as an edit and re-sent the whole
// history (resync) on every turn, while the lane's cumulative marks kept the
// stale breakpoints — the assembled request drifted from the host's body.

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-rolling-marks-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

type Wire = { role: string; content: Record<string, unknown>[] };
const MARK = { type: "ephemeral" };
const SYSTEM = [{ type: "text", text: "you are a coding agent", cache_control: MARK }];

// The two A/B arms run seconds apart, and kernel time="…" attributes carry
// each arm's first-sight wall clock (#4313, default on) — stable within one
// session's renders but different across separately-run arms. Same sanctioned
// normalization as tests/issue5403-watermark-fastpath.test.ts (#5471): mask
// only that attribute before byte comparisons.
function canonMessages(messages: unknown): string {
    return JSON.stringify(messages).replace(/\stime=\\?"[0-9T:.Z+\- ]+\\?"/g, ' time="X"');
}

interface H {
    post: (path: string, body: string, headers: Record<string, string>) => Promise<{ status: number; appliedSeq?: number }>;
    forwarded: Record<string, unknown>[];
    forwardedHeaders: http.IncomingHttpHeaders[];
    resetLane: () => void;
    close: () => Promise<void>;
}

async function harness(): Promise<H> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    __resetIncrementalClientForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const forwardedHeaders: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwardedHeaders.push(req.headers);
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: false, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const post = async (path: string, body: string, headers: Record<string, string>) => {
        const response = await fetch(`${proxyUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
        await response.arrayBuffer();
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    return {
        post,
        forwarded,
        forwardedHeaders,
        resetLane: () => __resetIncrementalLaneForTests(),
        close: async () => {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

/** The host's growing history (unmarked); each request decorates a COPY with
 *  OpenCode's rolling breakpoint: the last block of the last two messages. */
function conversation(turns: number): Wire[][] {
    const history: Wire[] = [];
    const requests: Wire[][] = [];
    for (let t = 1; t <= turns; t++) {
        history.push({ role: "user", content: [{ type: "text", text: `task ${t}: ` + "detail ".repeat(200) }] });
        requests.push(decorate(history));
        // tool round inside the turn: assistant text + tool_use (one wire
        // message → two core rows), then the tool_result
        history.push({ role: "assistant", content: [{ type: "text", text: `working on ${t}` }, { type: "tool_use", id: `toolu_${t}`, name: "bash", input: { cmd: `echo ${t}` } }] });
        history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${t}`, content: `output ${t} ` + "line\n".repeat(100) }] });
        requests.push(decorate(history));
        history.push({ role: "assistant", content: [{ type: "text", text: `done with ${t}` }] });
    }
    return requests;
}

function decorate(history: Wire[]): Wire[] {
    return history.map((m, i) => {
        if (i < history.length - 2) return { role: m.role, content: m.content.map((b) => ({ ...b })) };
        const content = m.content.map((b) => ({ ...b }));
        content[content.length - 1] = { ...content[content.length - 1], cache_control: MARK };
        return { role: m.role, content };
    });
}

function messageBreakpoints(body: Record<string, unknown>): number {
    let n = 0;
    for (const m of (body.messages as { content: unknown }[])) {
        if (Array.isArray(m.content)) for (const b of m.content as Record<string, unknown>[]) if ("cache_control" in b) n++;
    }
    return n;
}

const CONV = "ses_rolling_marks";
const laneHeaders = { "x-bili-plugin": "opencode", "x-bili-plugin-conversation": CONV, "x-acp-session": CONV };

async function runIncremental(h: H, requests: Wire[][], opts: { restartBefore?: number } = {}) {
    const modes: string[] = [];
    const sizes: { full: number; sent: number }[] = [];
    for (const [i, messages] of requests.entries()) {
        if (opts.restartBefore === i) h.resetLane();
        const full = JSON.stringify({ model: "claude-test", max_tokens: 1024, system: SYSTEM, messages });
        let plan = planIncrementalTurn({ cacheControlRetouch: true, conversationId: CONV, path: "/v1/messages", messages: messages as IncrementalWireMessage[], system: SYSTEM, request: { model: "claude-test", max_tokens: 1024 } });
        assert.notEqual(plan.mode, "skip");
        let r = await h.post("/__bili/plugin/turn", (plan as { body: string }).body, laneHeaders);
        if (r.status === 409) {
            noteIncrementalRejection(CONV);
            modes.push(`${plan.mode}:409`);
            plan = planIncrementalTurn({ cacheControlRetouch: true, conversationId: CONV, path: "/v1/messages", messages: messages as IncrementalWireMessage[], system: SYSTEM, request: { model: "claude-test", max_tokens: 1024 } });
            r = await h.post("/__bili/plugin/turn", (plan as { body: string }).body, laneHeaders);
        }
        assert.equal(r.status, 200, `request ${i} accepted`);
        assert.ok(r.appliedSeq !== undefined);
        noteIncrementalAck(CONV, r.appliedSeq, messages as IncrementalWireMessage[], SYSTEM);
        modes.push(plan.mode);
        sizes.push({ full: Buffer.byteLength(full), sent: Buffer.byteLength((plan as { body: string }).body) });
    }
    return { modes, sizes };
}

async function runFullResend(h: H, requests: Wire[][]) {
    for (const messages of requests) {
        const r = await h.post("/v1/messages", JSON.stringify({ model: "claude-test", max_tokens: 1024, system: SYSTEM, messages }), laneHeaders);
        assert.equal(r.status, 200);
    }
}

test("rolling cache_control: deltas after the seed, upstream bodies identical to full resend", async () => {
    const requests = conversation(6);
    const base = await harness();
    try {
        await runFullResend(base, requests);
    } finally {
        await base.close();
    }
    const inc = await harness();
    try {
        const { modes, sizes } = await runIncremental(inc, requests);
        assert.equal(modes[0], "seed");
        assert.deepEqual(modes.slice(1), requests.slice(1).map(() => "delta"), "a moving breakpoint never forces a resync");
        assert.equal(inc.forwarded.length, base.forwarded.length);
        for (let i = 0; i < requests.length; i++) {
            assert.equal(canonMessages(inc.forwarded[i].messages), canonMessages(base.forwarded[i].messages), `request ${i}: assembled messages byte-identical to the host's full resend`);            assert.equal(messageBreakpoints(inc.forwarded[i]), messageBreakpoints({ messages: requests[i] }), `request ${i}: only the host's rolling breakpoints (no accumulation)`);
        }
        const last = sizes[sizes.length - 1];
        assert.ok(last.sent * 3 < last.full, `delta (${last.sent} B) is a fraction of the full body (${last.full} B)`);
    } finally {
        await inc.close();
    }
});

test("rolling cache_control: a retouch against a cold canonical answers 409 and the client recovers with one resync", async () => {
    const requests = conversation(3);
    const base = await harness();
    try {
        await runFullResend(base, requests);
    } finally {
        await base.close();
    }
    const inc = await harness();
    try {
        const { modes } = await runIncremental(inc, requests, { restartBefore: 3 });
        assert.deepEqual(modes, ["seed", "delta", "delta", "delta:409", "seed", "delta", "delta"], "cold canonical: one 409, one re-seed, then deltas again");
        for (let i = 0; i < requests.length; i++) {
            assert.equal(canonMessages(inc.forwarded[i].messages), canonMessages(base.forwarded[i].messages), `request ${i} byte-identical after recovery`);        }
    } finally {
        await inc.close();
    }
});

test("rolling cache_control: a retouch whose content differs from the canonical is refused (409), never applied", async () => {
    const requests = conversation(1);
    const inc = await harness();
    try {
        await runIncremental(inc, requests.slice(0, 1));
        const forged = JSON.stringify({ conversationId: CONV, sinceSeq: 1, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: [{ role: "assistant", content: [{ type: "text", text: "next" }] }], retouch: [{ index: 0, message: { role: "user", content: [{ type: "text", text: "a DIFFERENT first message", cache_control: MARK }] } }] });
        const before = inc.forwarded.length;
        const r = await inc.post("/__bili/plugin/turn", forged, laneHeaders);
        assert.equal(r.status, 409);
        assert.equal(inc.forwarded.length, before, "nothing forwarded upstream");
        const malformed = await inc.post("/__bili/plugin/turn", JSON.stringify({ conversationId: CONV, sinceSeq: 1, path: "/v1/messages", request: { model: "claude-test" }, messages: [{ role: "assistant", content: "x" }], retouch: [{ index: "0", message: {} }] }), laneHeaders);
        assert.equal(malformed.status, 400);
    } finally {
        await inc.close();
    }
});

test("rolling marks: repeated prompts retain distinct IDs and match full resend", async () => {
    const history: Wire[] = [];
    const requests: Wire[][] = [];
    for (let i = 0; i < 6; i++) {
        history.push({ role: "user", content: [{ type: "text", text: "continue" }] });
        requests.push(decorate(history));
        history.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    }
    const base = await harness();
    try { await runFullResend(base, requests); } finally { await base.close(); }
    const inc = await harness();
    try {
        const { modes } = await runIncremental(inc, requests);
        assert.deepEqual(modes, ["seed", ...requests.slice(1).map(() => "delta")]);
        for (let i = 0; i < requests.length; i++) {
            assert.equal(canonMessages(inc.forwarded[i].messages), canonMessages(base.forwarded[i].messages));
            assert.equal(messageBreakpoints(inc.forwarded[i]), messageBreakpoints({ messages: requests[i] }));
        }
    } finally { await inc.close(); }
});

test("continued content IDs can be replaced by client pins without losing the new mark", async () => {
    const inc = await harness();
    try {
        const common = { conversationId: CONV, path: "/v1/messages", system: SYSTEM, request: { model: "claude-test", max_tokens: 1024 } };
        const seed = await inc.post("/__bili/plugin/turn", JSON.stringify({ ...common, sinceSeq: 0, resync: true, messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }] }), laneHeaders);
        assert.equal(seed.status, 200);
        const delta = await inc.post("/__bili/plugin/turn", JSON.stringify({ ...common, sinceSeq: seed.appliedSeq, msgIds: ["pinned-reply", "pinned-repeat"], messages: [
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
            { role: "user", content: [{ type: "text", text: "continue", cache_control: MARK }] },
        ] }), laneHeaders);
        assert.equal(delta.status, 200);
        const messages = inc.forwarded.at(-1)!.messages as Wire[];
        assert.equal(messageBreakpoints(inc.forwarded.at(-1)!), 1);
        assert.deepEqual(messages.at(-1)?.content.at(-1)?.cache_control, MARK);
        assert.ok(messages[0].content.every((block) => block.cache_control === undefined), "the earlier identical prompt stays unmarked");
    } finally { await inc.close(); }
});

test("rolling marks follow client-pinned identities on seed and delta", async () => {
    const inc = await harness();
    try {
        const common = { conversationId: CONV, path: "/v1/messages", system: SYSTEM, request: { model: "claude-test", max_tokens: 1024 } };
        const seed = await inc.post("/__bili/plugin/turn", JSON.stringify({ ...common, sinceSeq: 0, resync: true, msgIds: ["client-first"], messages: [{ role: "user", content: [{ type: "text", text: "first pinned prompt", cache_control: MARK }] }] }), laneHeaders);
        assert.equal(seed.status, 200);
        assert.equal(messageBreakpoints(inc.forwarded.at(-1)!), 1, "seed's mark follows its pinned ID");
        const delta = await inc.post("/__bili/plugin/turn", JSON.stringify({ ...common, sinceSeq: seed.appliedSeq, msgIds: ["client-reply", "client-next"], messages: [
            { role: "assistant", content: [{ type: "text", text: "pinned reply" }] },
            { role: "user", content: [{ type: "text", text: "next pinned prompt", cache_control: MARK }] },
        ], retouch: [{ index: 0, message: { role: "user", content: [{ type: "text", text: "first pinned prompt" }] } }] }), laneHeaders);
        assert.equal(delta.status, 200);
        assert.equal(messageBreakpoints(inc.forwarded.at(-1)!), 1, "only the latest pinned message remains marked");
    } finally { await inc.close(); }
});

for (const kind of ["document", "image", "tool-result", "signed-thinking"] as const) {
    test(`rolling cache_control: ${kind} payloads stay exact when marks move`, async () => {
        const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "exact+opaque/bytes==" } };
        const prefix: Wire[] = kind === "tool-result" ? [
            { role: "user", content: [{ type: "text", text: "use the tool" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "opaque-call", name: "inspect", input: { literal: "keep", cache_control: "nested tool argument, never a mark" } }] },
        ] : [];
        const block = kind === "document" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: "unchanged+document/bytes==" } }
            : kind === "tool-result" ? { type: "tool_result", tool_use_id: "opaque-call", is_error: true, content: [image] }
            : kind === "signed-thinking" ? { type: "text", text: "answer after thinking" }
            : image;
        const reasoning = kind === "signed-thinking" ? [{ type: "thinking", thinking: "signed reasoning\n雪", signature: "exact+signature/bytes==" }] : [];
        const role = kind === "signed-thinking" ? "assistant" : "user";
        const requests: Wire[][] = [
            [...prefix, { role, content: [...reasoning, { ...block, cache_control: MARK }] }],
            [...prefix, { role, content: [...reasoning, block] }, { role: "assistant", content: [{ type: "text", text: "distinct continuation" }] }, { role: "user", content: [{ type: "text", text: "distinct next question", cache_control: MARK }] }],
        ];
        const base = await harness();
        try { await runFullResend(base, requests); } finally { await base.close(); }
        const inc = await harness();
        try {
            const { modes } = await runIncremental(inc, requests);
            assert.deepEqual(modes, ["seed", "delta"]);
            for (let i = 0; i < requests.length; i++) {
                assert.equal(canonMessages(inc.forwarded[i].messages), canonMessages(base.forwarded[i].messages));            }
        } finally { await inc.close(); }
    });
}

for (const removed of ["signature", "is_error"] as const) {
    test(`retouch removing ${removed} is refused atomically and valid retry still succeeds`, async () => {
        const block = removed === "signature"
            ? { type: "thinking", thinking: "unaltered signed content", signature: "unaltered signature" }
            : { type: "tool_result", tool_use_id: "call-error", content: "tool failed", is_error: true };
        const role = removed === "signature" ? "assistant" : "user";
        const seed: Wire[] = [{ role, content: [block, { type: "text", text: "rolling marker", cache_control: MARK }] }];
        const delta: Wire[] = [{ role: role === "assistant" ? "user" : "assistant", content: [{ type: "text", text: "valid delta" }] }];
        const unmarked: Wire[] = [{ role, content: [block, { type: "text", text: "rolling marker" }] }, ...delta];
        const base = await harness();
        try { await runFullResend(base, [seed, unmarked]); } finally { await base.close(); }
        const inc = await harness();
        try {
            const initial = await inc.post("/__bili/plugin/turn", JSON.stringify({ conversationId: CONV, sinceSeq: 0, resync: true, system: SYSTEM, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: seed }), laneHeaders);
            assert.equal(initial.status, 200);
            const changed: Record<string, unknown> = { ...block };
            delete changed[removed];
            const body = { conversationId: CONV, sinceSeq: initial.appliedSeq, system: SYSTEM, path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: delta, retouch: [{ index: 0, message: { role, content: [changed, { type: "text", text: "rolling marker" }] } }] };
            const before = inc.forwarded.length;
            const bad = await inc.post("/__bili/plugin/turn", JSON.stringify(body), laneHeaders);
            assert.equal(bad.status, 409);
            assert.equal(inc.forwarded.length, before, "rejected request never reaches upstream");
            body.retouch[0].message.content[0] = { ...block };
            const good = await inc.post("/__bili/plugin/turn", JSON.stringify(body), laneHeaders);
            assert.equal(good.status, 200, "same sequence still accepts the exact original");
            assert.equal(inc.forwarded.length, before + 1);
            assert.equal(canonMessages(inc.forwarded.at(-1)?.messages), canonMessages(base.forwarded.at(-1)?.messages), "rejected retouch changed neither payload nor the valid retry's rendered output");        } finally { await inc.close(); }
    });
}
