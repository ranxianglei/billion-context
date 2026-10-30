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
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-incr-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Turn {
    sinceSeq: number;
    messages: unknown[];
    resync?: boolean;
    system?: string;
    request?: Record<string, unknown>;
}

interface Harness {
    proxyUrl: string;
    path: string;
    turn: (t: Turn) => Promise<{ status: number; headers: Headers; body: unknown }>;
    probe: () => Promise<{ status: number; body: unknown }>;
    markerTurn: (reqPath: string, payload: { conversationId: string; sinceSeq: number; resync?: boolean; system?: unknown; request?: Record<string, unknown>; messages: unknown[] }) => Promise<{ status: number; body: unknown; appliedSeq?: number }>;
    markerRaw: (reqPath: string, anthropicBody: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
    forwarded: Record<string, unknown>[];
    dir: string;
    settle: () => Promise<void>;
    close: () => Promise<void>;
}

async function harness(storageMode: "full" | "legacy", opts: { upstreamDelayMs?: number; upstreamStatus?: number; debounceMs?: number } = {}): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = storageMode === "full" ? "full" : "legacy";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: opts.debounceMs ?? 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            const reply = (): void => {
                res.writeHead(opts.upstreamStatus ?? 200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            };
            if (opts.upstreamDelayMs) setTimeout(reply, opts.upstreamDelayMs);
            else reply();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const path = "/v1/messages";
    const turn = async (t: Turn) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-inc-1" },
            body: JSON.stringify({ conversationId: "conv-inc-1", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.system !== undefined ? { system: t.system } : {}), path, request: { model: "claude-test", max_tokens: 1024, ...(t.request ?? {}) }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, headers: response.headers, body };
    };
    // store handle must be released before the teardown rm -rf: Windows cannot
    // unlink an open index.db (EBUSY) — same seam the storage-unified suite uses.
    const probe = async () => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, { method: "GET", headers: { "x-bili-plugin": "dsh" } });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    // #3248 marker divert: shaped incremental body posted on the ORDINARY model path
    const markerTurn = async (reqPath: string, payload: { conversationId: string; sinceSeq: number; resync?: boolean; system?: unknown; request?: Record<string, unknown>; messages: unknown[] }) => {
        const response = await fetch(`${proxyUrl}${reqPath}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": payload.conversationId, "x-acp-session": payload.conversationId, "x-bili-plugin-turn": "1" },
            body: JSON.stringify({ conversationId: payload.conversationId, sinceSeq: payload.sinceSeq, ...(payload.resync ? { resync: true } : {}), ...(payload.system !== undefined ? { system: payload.system } : {}), request: { model: "claude-test", max_tokens: 1024, ...(payload.request ?? {}) }, messages: payload.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, body, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    // marker on an ordinary anthropic body: must ride the normal pipeline unchanged
    const markerRaw = async (reqPath: string, anthropicBody: Record<string, unknown>) => {
        const response = await fetch(`${proxyUrl}${reqPath}`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-acp-session": "conv-marker-plain", "x-bili-plugin-turn": "1" }, body: JSON.stringify(anthropicBody) });
        const body: unknown = await response.json().catch(() => null);
        return { status: response.status, body };
    };
    return { proxyUrl, path, turn, probe, markerTurn, markerRaw, forwarded, dir, settle: async () => { await new Promise<void>((resolve) => setTimeout(resolve, (opts.debounceMs ?? 60000) + 40)); }, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

const userTurn = (n: number, text = "hello") => ({ id: `u${n}`, role: "user", contentType: "text", content: text.repeat(400) });
const assistantTurn = (n: number) => ({ id: `a${n}`, role: "assistant", contentType: "text", content: `model answer ${n}` });

test("incremental lane: seed → delta → upstream receives the assembled full history; ack advances", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");
        const upstream1 = h.forwarded.at(-1) as { system?: unknown; messages: { role: string; content: string }[] };
        assert.ok(Array.isArray(upstream1.messages) && upstream1.messages.length === 1);
        assert.equal(upstream1.messages[0].role, "user");

        // Delta: everything after ack — the previous assistant reply + the new user turn.
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "second question")] });
        assert.equal(delta.status, 200);
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        const upstream2 = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstream2.messages.length, 3, "assembled history = seed + delta");
        assert.deepEqual(upstream2.messages.map((m) => m.role), ["user", "assistant", "user"]);
    } finally {
        await h.close();
    }
});

test("incremental lane: a failed turn (non-2xx) carries NO x-bili-applied-seq (#3344)", async () => {
    const h = await harness("full", { upstreamStatus: 500 });
    try {
        const failed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.ok(failed.status >= 400, `expected a non-2xx failure from the failing upstream, got ${failed.status}`);
        // The ack must not ride a failure: a host trusting it unconditionally
        // would skip its resend and lose the user's message (#3344).
        assert.equal(failed.headers.get("x-bili-applied-seq"), null);
    } finally {
        await h.close();
    }
});

test("incremental lane: seq mismatch answers 409 with the server's seq; resync recovers", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        // Client guesses a stale seq.
        const stale = await h.turn({ sinceSeq: 0, messages: [assistantTurn(1), userTurn(2)] });
        assert.equal(stale.status, 409);
        assert.equal((stale.body as { error?: string }).error, "seq-mismatch");
        assert.equal((stale.body as { serverSeq?: number }).serverSeq, 1);
        // Resync with the full history re-seeds the canonical.
        const recovered = await h.turn({ sinceSeq: 0, resync: true, messages: [userTurn(1), assistantTurn(1), userTurn(2)] });
        assert.equal(recovered.status, 200);
        assert.equal(recovered.headers.get("x-bili-applied-seq"), "3");
        const upstream = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.deepEqual(upstream.messages.map((m) => m.role), ["user", "assistant", "user"]);
    } finally {
        await h.close();
    }
});

test("incremental lane: cold rebuild after restart serves the next delta from the unified table", async () => {
    const h = await harness("full", { debounceMs: 20 });
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        // #5155: the wrap-up schedules a DEBOUNCED save, so the rows settle
        // a moment later — let the flush land before simulating the restart.
        await h.settle();
        _resetSessionsForTest();
        // Simulate a process restart: session pool + warm caches dropped. The
        // canonical prefix must rebuild from the unified messages table.
        _resetSessionsForTest();
        __resetIncrementalLaneForTests();
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "after restart")] });
        assert.equal(delta.status, 200);
        const upstream = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.deepEqual(upstream.messages.map((m) => m.role), ["user", "assistant", "user"], "table-rebuilt canonical + delta");
    } finally {
        await h.close();
    }
});

test("incremental lane: divergent resync survives a cold restart without a 409 loop", async () => {
    const h = await harness("full", { debounceMs: 20 });
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1, "old branch one"), assistantTurn(1), userTurn(2, "old branch two")] });
        assert.equal(seed.status, 200);
        // The client rewinds to an edited branch (divergent content, ids and all).
        const resync = await h.turn({ sinceSeq: 0, resync: true, messages: [userTurn(1, "edited branch")] });
        assert.equal(resync.status, 200);
        assert.equal(resync.headers.get("x-bili-applied-seq"), "1");
        // #5155: debounced save — let the new branch's rows settle first.
        await h.settle();
        // Cold restart: the canonical must rebuild from the CURRENT branch
        // only — the rejected branch's rows stay in the table (append-only)
        // but the served history slices past them (baseSeq epoch).
        _resetSessionsForTest();
        __resetIncrementalLaneForTests();
        const delta = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2, "new branch tail")] });
        assert.equal(delta.status, 200, `delta body: ${JSON.stringify(delta.body)}`);
        assert.equal(delta.headers.get("x-bili-applied-seq"), "3");
        const upstream = h.forwarded.at(-1) as { messages: { role: string; content: unknown }[] };
        assert.equal(upstream.messages.length, 3, "served history is the edited branch, not the row union");
        const first = JSON.stringify(upstream.messages[0].content);
        assert.ok(first.includes("edited branch"), `first message is the resynced one: ${first.slice(0, 80)}`);
        assert.ok(!JSON.stringify(upstream.messages).includes("old branch"), "old branch rows do not leak into the canonical");
    } finally {
        await h.close();
    }
});

test("incremental lane: sessions share the plugin conversation id — incremental and normal traffic interop", async () => {
    const h = await harness("full");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        const session = peekSession("conv-inc-1");
        assert.ok(session, "session id = the plugin conversation id (same as normal plugin traffic)");
        assert.equal(session.stats.requests, 1);
    } finally {
        await h.close();
    }
});

test("incremental lane: sticky system — omitted system keeps the last one, a new value replaces it", async () => {
    const h = await harness("full");
    // The assembled body rides the normal pipeline, which renders the system
    // prompt as anthropic blocks (with its cache marks) — compare by text.
    const sysText = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((b) => (b as { text?: string })?.text ?? "").join("") : String(v);
    try {
        await h.turn({ sinceSeq: 0, system: "SYSTEM-A", messages: [userTurn(1)] });
        const upstream1 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream1.startsWith("SYSTEM-A"), `turn 1 carries the client system: ${upstream1.slice(0, 40)}`);
        // Omitted → sticky.
        await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2)] });
        const upstream2 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream2.startsWith("SYSTEM-A"), "omitted system keeps the last one");
        // Explicit new value replaces.
        await h.turn({ sinceSeq: 3, system: "SYSTEM-B", messages: [assistantTurn(2), userTurn(3)] });
        const upstream3 = sysText((h.forwarded.at(-1) as { system?: unknown }).system);
        assert.ok(upstream3.startsWith("SYSTEM-B"), "explicit system replaces");
        assert.ok(!upstream3.includes("SYSTEM-A"), "the old system is fully replaced");
    } finally {
        await h.close();
    }
});

test("incremental lane: a second concurrent turn on the same conversation answers 409 turn-in-flight", async () => {
    // Margins sized for loaded runners: the settle sleep must beat the first
    // request's path into inFlight, and the upstream delay must outlive it —
    // 40ms/150ms flaked (review of #3253).
    const h = await harness("full", { upstreamDelayMs: 800 });
    try {
        const first = h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        await new Promise((r) => setTimeout(r, 120)); // let the first enter forward
        const second = await h.turn({ sinceSeq: 1, messages: [assistantTurn(1), userTurn(2)] });
        assert.equal(second.status, 409);
        assert.equal((second.body as { error?: string }).error, "turn-in-flight");
        assert.equal((await first).status, 200);
    } finally {
        await h.close();
    }
});

test("incremental lane: request params (tools/max_tokens) ride the assembled body to the upstream", async () => {
    const h = await harness("full");
    try {
        const tools = [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }];
        await h.turn({ sinceSeq: 0, request: { max_tokens: 777, tools }, messages: [userTurn(1)] });
        const upstream = h.forwarded.at(-1) as { max_tokens?: number; tools?: unknown; model?: string };
        assert.equal(upstream.max_tokens, 777);
        assert.equal(upstream.model, "claude-test");
        assert.ok(Array.isArray(upstream.tools));
        // Disallowed request params never ride.
        await h.turn({ sinceSeq: 1, request: { max_tokens: 512, messages: [{ role: "user", content: "smuggled" }] } as never, messages: [assistantTurn(1), userTurn(2)] });
        const upstream2 = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstream2.messages.length, 3, "request.messages is ignored — the lane owns the message list");
    } finally {
        await h.close();
    }
});

test("incremental lane: a Vertex turn keeps anthropic_version and still drops an unlisted field", async () => {
    const h = await harness("full");
    try {
        // Anthropic-on-Vertex has no `model` in the body — `anthropic_version`
        // carries the wire revision instead (live capture 2026-10-15). The
        // allowlist is the only thing that could drop it on the way out.
        await h.turn({ sinceSeq: 0, request: { anthropic_version: "vertex-2023-10-16" }, messages: [userTurn(1)] });
        const upstream = h.forwarded.at(-1) as { anthropic_version?: string; smuggled?: unknown };
        assert.equal(upstream.anthropic_version, "vertex-2023-10-16");
        // The allowlist is still a whitelist: an unlisted key must not ride.
        await h.turn({ sinceSeq: 1, request: { anthropic_version: "vertex-2023-10-16", smuggled: true } as never, messages: [assistantTurn(1), userTurn(2)] });
        const upstream2 = h.forwarded.at(-1) as { anthropic_version?: string; smuggled?: unknown };
        assert.equal(upstream2.anthropic_version, "vertex-2023-10-16");
        assert.equal(upstream2.smuggled, undefined);
    } finally {
        await h.close();
    }
});

test("incremental lane: legacy-only storage answers 503 with the enablement hint", async () => {
    const h = await harness("legacy");
    try {
        const seed = await h.turn({ sinceSeq: 0, messages: [userTurn(1)] });
        assert.equal(seed.status, 503);
        assert.match(String((seed.body as { error?: string }).error), /storage\.unified/);
    } finally {
        await h.close();
    }
});

// --- marker divert (#3248 phase 2) -------------------------------------------------
// The host keeps its ordinary provider URL and stamps `x-bili-plugin-turn: 1`;
// the body shape is the final word (non-incremental bodies ride the normal
// pipeline byte-identically).

test("incremental marker divert: probe reports the rollout state", async () => {
    const h = await harness("full");
    try {
        const off = await h.probe();
        assert.equal(off.status, 200);
        const offBody = off.body as { ok: boolean; enabled: boolean; feature: string; protocol: number };
        assert.equal(offBody.ok, true);
        assert.equal(offBody.feature, "pluginIncrementalTurns");
        assert.equal(offBody.protocol, 1);
        assert.equal(offBody.enabled, false, "default rollout percent is 0 — probe must report disabled");
        process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
        try {
            const on = await h.probe();
            assert.equal(on.status, 200);
            assert.equal((on.body as { enabled: boolean }).enabled, true, "env force flips the probe");
        } finally {
            delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        }
    } finally {
        await h.close();
    }
});

test("incremental marker divert: shaped body on the ordinary model path is diverted and assembled", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
        h = await harness("full");
        const seed = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-1", sinceSeq: 0, request: { max_tokens: 512 }, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        assert.ok(seed.appliedSeq !== undefined && seed.appliedSeq >= 1, "diverted turn carries x-bili-applied-seq");
        const upstream = h.forwarded.at(-1) as { model?: string; max_tokens?: number; messages: { role: string }[] };
        assert.equal(upstream.model, "claude-test", "assembled body is a real anthropic request");
        assert.equal(upstream.max_tokens, 512);
        assert.equal(upstream.messages.length, 1);
        // delta through the same ordinary path
        const delta = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-1", sinceSeq: seed.appliedSeq ?? 1, request: { max_tokens: 512 }, messages: [assistantTurn(1), userTurn(2)] });
        assert.equal(delta.status, 200);
        const upstream2 = h.forwarded.at(-1) as { messages: { role: string }[] };
        assert.equal(upstream2.messages.length, 3, "delta was assembled onto the canonical prefix");
        assert.deepEqual(upstream2.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user"]);
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("incremental marker divert: marker on a non-incremental body rides the normal pipeline unchanged", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    try {
        h = await harness("full");
        // an ordinary anthropic body WITH the marker: shape is the final word.
        // The normal pipeline re-serializes anthropic bodies (content may come
        // back as blocks), so assert semantics, not byte identity: model rides,
        // one message, text preserved, and no incremental artifacts leak
        // upstream (conversationId/sinceSeq must be absent).
        const res = await h.markerRaw("/v1/messages", { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "plain turn with marker" }] });
        assert.equal(res.status, 200);
        const upstream = h.forwarded.at(-1) as { model?: string; conversationId?: string; sinceSeq?: number; messages: { role: string; content: unknown }[] };
        assert.equal(upstream.model, "claude-test");
        assert.equal(upstream.messages.length, 1);
        assert.equal("conversationId" in upstream, false, "not diverted");
        assert.equal("sinceSeq" in upstream, false, "not diverted");
        const c = upstream.messages[0].content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : String(c);
        // The ordinary pipeline stamps the hidden <acp> ref on the first user
        // turn — exactly what a marker-less request would carry too.
        assert.ok(text.endsWith("plain turn with marker"), `text rides the normal pipeline (got: ${JSON.stringify(text.slice(0, 60))}…)`);
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

test("incremental marker divert: rollout off answers 503 on shaped turns only", async () => {
    const h = await harness("full");
    try {
        const shaped = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-off", sinceSeq: 0, request: { max_tokens: 512 }, messages: [userTurn(1)] });
        assert.equal(shaped.status, 503);
        assert.match(String((shaped.body as { error?: string }).error), /pluginIncrementalTurns/);
        // a plain body with the marker still rides the normal pipeline
        const plain = await h.markerRaw("/v1/messages", { model: "claude-test", max_tokens: 512, messages: [{ role: "user", content: "plain while off" }] });
        assert.equal(plain.status, 200);
    } finally {
        await h.close();
    }
});

test("incremental marker divert: system-only change rides an empty delta — canonical unchanged, sticky system updates", async () => {
    process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    const sysText = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v) ? v.map((b) => (b as { text?: string })?.text ?? "").join("") : String(v);
    try {
        h = await harness("full");
        const seed = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-sys", sinceSeq: 0, system: "SYSTEM-A", request: { max_tokens: 512 }, messages: [userTurn(1)] });
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 1);
        // Same message set, different system → empty delta: the canonical must
        // not extend, and the assembled request carries the new sticky system.
        const sysOnly = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-sys", sinceSeq: seed.appliedSeq ?? 1, system: "SYSTEM-B", request: { max_tokens: 512 }, messages: [] });
        assert.equal(sysOnly.status, 200);
        assert.equal(sysOnly.appliedSeq, seed.appliedSeq, "a pure system update does not extend the canonical");
        const upstream = h.forwarded.at(-1) as { system?: unknown; messages: { role: string }[] };
        assert.equal(upstream.messages.length, 1, "history unchanged by the system-only turn");
        const sys = sysText(upstream.system);
        assert.ok(sys.startsWith("SYSTEM-B"), `assembled request carries the new system: ${sys.slice(0, 40)}`);
        assert.ok(!sys.includes("SYSTEM-A"), "the old system is fully replaced");
        // An empty delta WITHOUT a system update stays a client error.
        const bareEmpty = await h.markerTurn("/v1/messages", { conversationId: "conv-marker-sys", sinceSeq: seed.appliedSeq ?? 1, request: { max_tokens: 512 }, messages: [] });
        assert.equal(bareEmpty.status, 400);
    } finally {
        delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        await h?.close();
    }
});

for (const scenario of ["append", "system-only", "edit", "forced resync", "fresh client"] as const) {
    test(`incremental client: removed system clears the upstream on ${scenario}`, async () => {
        const { __resetIncrementalClientForTests, planIncrementalTurn, noteIncrementalAck } = await import("../src/agent/incremental-client.js");
        const priorRollout = process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
        process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = "1";
        __resetIncrementalClientForTests();
        let h: Harness | undefined;
        try {
            h = await harness("full");
            const conversationId = "conv-system-clear";
            const original = [{ role: "user", content: "original request" }];
            const seed = planIncrementalTurn({ conversationId, messages: original, system: "OLD-SYSTEM-INSTRUCTION" });
            assert.notEqual(seed.mode, "skip");
            if (seed.mode === "skip") return;
            const seeded = await h.markerTurn(h.path, JSON.parse(seed.body));
            assert.equal(seeded.status, 200);
            assert.equal(seeded.appliedSeq, original.length);
            assert.ok(JSON.stringify(h.forwarded.at(-1)?.system).includes("OLD-SYSTEM-INSTRUCTION"));
            noteIncrementalAck(conversationId, original.length, original, "OLD-SYSTEM-INSTRUCTION");
            if (scenario === "fresh client") __resetIncrementalClientForTests();
            const messages = scenario === "append"
                ? [...original, { role: "assistant", content: "answer" }, { role: "user", content: "next request" }]
                : scenario === "edit" ? [{ role: "user", content: "edited request" }] : original;
            const plan = planIncrementalTurn({ conversationId, messages, system: undefined }, scenario === "forced resync");
            assert.equal(plan.mode, scenario === "fresh client" ? "seed" : scenario === "edit" || scenario === "forced resync" ? "resync" : "delta");
            const cleared = await h.markerTurn(h.path, JSON.parse(plan.body));
            assert.equal(cleared.status, 200);
            assert.equal(cleared.appliedSeq, messages.length);
            assert.equal(JSON.stringify(h.forwarded.at(-1)?.system ?? "").includes("OLD-SYSTEM-INSTRUCTION"), false, "removed original system must not be forwarded");
            noteIncrementalAck(conversationId, messages.length, messages, undefined);
            const next = planIncrementalTurn({ conversationId, messages: [...messages, { role: "user", content: "another request" }], system: undefined });
            assert.equal(next.mode, "delta");
            if (next.mode !== "delta") return;
            assert.equal(Object.hasOwn(JSON.parse(next.body), "system"), false, "acknowledged absence stays omitted on subsequent deltas");
            const followed = await h.markerTurn(h.path, JSON.parse(next.body));
            assert.equal(followed.status, 200);
            assert.equal(JSON.stringify(h.forwarded.at(-1)?.system ?? "").includes("OLD-SYSTEM-INSTRUCTION"), false);
        } finally {
            if (priorRollout === undefined) delete process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS;
            else process.env.BILI_ROLLOUT_PLUGIN_INCREMENTAL_TURNS = priorRollout;
            __resetIncrementalClientForTests();
            await h?.close();
        }
    });
}

// --- client helper state machine (src/agent/incremental-client.ts) ------------------

test("incremental client helper: seed implies resync, delta slices, edits resync, sticky system", async () => {
    const { __resetIncrementalClientForTests, planIncrementalTurn, noteIncrementalAck, markIncrementalDead } = await import("../src/agent/incremental-client.js");
    __resetIncrementalClientForTests();
    const conv = "conv-helper-1";
    const msgs1 = [{ role: "user", content: "hello there" }];
    const seed = planIncrementalTurn({ conversationId: conv, messages: msgs1, system: "be terse" });
    assert.equal(seed.mode, "seed");
    const seedBody = JSON.parse(seed.body) as { sinceSeq: number; resync: boolean; messages: unknown[]; system?: string };
    assert.equal(seedBody.sinceSeq, 0);
    assert.equal(seedBody.resync, true, "seed never 409s — replacement semantics");
    assert.equal(seedBody.system, "be terse");

    // ack seq 1 → next turn sends only the new tail
    noteIncrementalAck(conv, 1, msgs1, "be terse");
    const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "and now?" }];
    const delta = planIncrementalTurn({ conversationId: conv, messages: msgs2, system: "be terse" });
    assert.equal(delta.mode, "delta");
    const deltaBody = JSON.parse(delta.body) as { sinceSeq: number; messages: unknown[]; system?: string };
    assert.equal(deltaBody.sinceSeq, 1);
    assert.equal(deltaBody.messages.length, 2, "only the messages added since the ack");
    assert.equal(deltaBody.system, undefined, "sticky system omitted when unchanged");

    // edited prefix → resync with the full history
    const edited = [{ role: "user", content: "hello there (edited)" }, ...msgs2.slice(1)];
    const rs = planIncrementalTurn({ conversationId: conv, messages: edited, system: "be terse" });
    assert.equal(rs.mode, "resync");
    const rsBody = JSON.parse(rs.body) as { sinceSeq: number; resync: boolean; messages: unknown[] };
    assert.equal(rsBody.resync, true);
    assert.equal(rsBody.messages.length, edited.length);

    // system change with an equal message set rides an EMPTY delta — the
    // canonical is unchanged, the sticky system updates server-side
    noteIncrementalAck(conv, edited.length, edited, "be terse");
    const sysChange = planIncrementalTurn({ conversationId: conv, messages: edited, system: "be verbose" });
    assert.equal(sysChange.mode, "delta");
    const sysBody = JSON.parse(sysChange.body) as { sinceSeq: number; messages: unknown[]; system?: string };
    assert.equal(sysBody.messages.length, 0, "pure sticky-system update — empty delta");
    assert.equal(sysBody.system, "be verbose");

    // dead conversation falls back to skip until re-probed/reset
    markIncrementalDead(conv);
    const dead = planIncrementalTurn({ conversationId: conv, messages: edited, system: "be verbose" });
    assert.equal(dead.mode, "skip", "dead conversation rides full resend (host's own path)");
    __resetIncrementalClientForTests();
});

test("wireMessagesLookAnthropic: anthropic shapes pass, OpenAI-tool shapes fall back to full resend", async () => {
    const { wireMessagesLookAnthropic } = await import("../src/agent/incremental-client.js");
    assert.equal(wireMessagesLookAnthropic([{ role: "user", content: "hi" }]), true, "string content");
    assert.equal(wireMessagesLookAnthropic([{ role: "user", content: [{ type: "text", text: "hi" }] }]), true, "block content");
    assert.equal(wireMessagesLookAnthropic([{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }]), true, "anthropic tool blocks are native wire shape");
    assert.equal(wireMessagesLookAnthropic([]), false, "empty list is not a conversation");
    assert.equal(wireMessagesLookAnthropic("nope"), false);
    assert.equal(wireMessagesLookAnthropic([{ role: "user", content: "hi" }, { role: "tool", content: "out" }]), false, "OpenAI tool role is not convertible");
    assert.equal(wireMessagesLookAnthropic([{ role: "assistant", content: "x", tool_calls: [{ id: "c", type: "function", function: { name: "f" } }] }]), false, "tool_calls cannot ride anthropicToCore");
    assert.equal(wireMessagesLookAnthropic([{ role: "user", content: "hi", tool_call_id: "c" }]), false);
    assert.equal(wireMessagesLookAnthropic([{ role: "user", content: 42 }]), false, "content must be string or array");
});

test("incrementalTurnBodyShape accepts the incremental payload and rejects anthropic/garbage", async () => {
    const { incrementalTurnBodyShape } = await import("../src/incremental-lane.js");
    const inc = Buffer.from(JSON.stringify({ conversationId: "c1", sinceSeq: 0, request: {}, messages: [] }));
    assert.equal(incrementalTurnBodyShape(inc), true);
    const anthropic = Buffer.from(JSON.stringify({ model: "claude-test", max_tokens: 64, messages: [] }));
    assert.equal(incrementalTurnBodyShape(anthropic), false, "top-level model = ordinary request");
    const garbage = Buffer.from("not json at all");
    assert.equal(incrementalTurnBodyShape(garbage), false);
    const badSeq = Buffer.from(JSON.stringify({ conversationId: "c1", sinceSeq: "3", messages: [] }));
    assert.equal(incrementalTurnBodyShape(badSeq), false, "sinceSeq must be an integer");
});

// #3433: the lane ingests with anthropicToCore and re-emits with coreToAnthropic,
// so non-anthropic message shapes must be rejected LOUDLY at the boundary —
// converting them would silently drop assistant.tool_calls or mis-map
// role:"tool" into user text. The client-side mirror is
// wireMessagesLookAnthropic; this is the trust-boundary enforcement.
test("#3433: lane rejects non-anthropic message shapes with 400, never half-converts them", async () => {
    const h = await harness("full");
    try {
        const toolRole = await h.turn({ sinceSeq: 0, resync: true, messages: [
            { role: "user", content: "hi" },
            { role: "tool", tool_call_id: "c1", content: "out" },
        ] });
        assert.equal(toolRole.status, 400);
        assert.match((toolRole.body as { error?: string }).error ?? "", /anthropic wire shape/);

        const toolCalls = await h.turn({ sinceSeq: 0, resync: true, messages: [
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        ] });
        assert.equal(toolCalls.status, 400);
        assert.match((toolCalls.body as { error?: string }).error ?? "", /anthropic wire shape/);

        // the rejections applied nothing — a valid anthropic seed still lands
        const seed = await h.turn({ sinceSeq: 0, resync: true, messages: [{ role: "user", content: "hello" }] });
        assert.equal(seed.status, 200);
        assert.equal(seed.headers.get("x-bili-applied-seq"), "1");
    } finally {
        await h.close();
    }
});
