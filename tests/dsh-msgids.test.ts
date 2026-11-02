/**
 * #4491 dsh host wiring: llm/stream msgIds on incremental lane turns.
 *
 * dsh stamps a stable UUID on every session message and hands the list to
 * the llm/stream waterfall (options.messages[].id). The plugin captures the
 * ids there (all-or-nothing) and — when the adapter's outgoing wire body
 * lines up 1:1 with them — carries them on the incremental turn envelope
 * (`msgIds`), so the server pins its canonical rows to the host's own
 * message identity instead of content-derived hashes.
 *
 * Stakes (all in one seam, beforeSend under the llm/stream scope):
 *   - aligned ids ride the turn body, sliced to the DELTA messages;
 *   - any unusable id (missing/duplicate/reserved/控制字符) drops the whole
 *     field for that turn — id-less incremental turns keep working;
 *   - a count mismatch against the actually-sent messages never ships a
 *     guessed pairing (degrade over misattribute).
 */
import { strict as assert } from "node:assert";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Same hermetic posture as the sibling dsh suites: nothing here may depend
// on this machine's real proxy/env wiring (planNativeDsh returns "off" with
// these set, and the plugin would never register).
delete process.env.BILI_PROVIDER_REWRITES;
delete process.env.BILI_NATIVE_DSH;
delete process.env.BILLION_CONTEXT_PLUGIN;

import {
    apply,
    _resetRegisterForTest,
    _settleNativeForTest,
    _stateBeforeSendForTest,
    _stateOnResponseForTest,
    _stateToolsReadyForTest,
    type PluginContext,
} from "../src/agent/dsh-native.ts";
import { __resetIncrementalClientForTests } from "../src/agent/incremental-client.ts";
import { __resetConversationRecallForTests } from "../src/agent/conversation-recall.ts";

const MODEL_URL = "https://api.anthropic.com/v1/messages";

interface RegisteredToolLike {
    name: string;
}

interface CtxHandle {
    ctx: PluginContext;
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>;
    setInitiator: (sid: string | undefined) => void;
    registered: RegisteredToolLike[];
}

function makeCtx(): CtxHandle {
    const events = new Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>();
    const registered: RegisteredToolLike[] = [];
    let currentSid: string | undefined;
    const ctx = {
        inject: (deps: readonly string[], cb: (sub: unknown) => void) => {
            // Only the llm service matters here; other inject targets
            // (webServer, credentials, sessions…) stay cold like the sibling
            // harnesses.
            if (deps.includes("llm")) cb({});
        },
        on: (name: string, listener: (payload: unknown, next: () => unknown) => unknown) => {
            const list = events.get(name) ?? [];
            list.push(listener);
            events.set(name, list);
        },
        emit: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        tools: { register: (tool: RegisteredToolLike) => void registered.push(tool) },
        commands: { register: () => undefined },
        agents: {
            currentInitiator: () =>
                currentSid === undefined ? undefined : { session: { id: currentSid } },
        },
        setInitiator: (sid: string | undefined) => {
            currentSid = sid;
        },
    } as unknown as PluginContext & { setInitiator: (sid: string | undefined) => void };
    return { ctx, events, setInitiator: (sid) => ctx.setInitiator(sid), registered };
}

/** Compose the registered llm/stream listeners like cordis does (outermost
 *  first, each receives (options, next)) over a base adapter. */
function runWaterfall(
    events: Map<string, Array<(payload: unknown, next: () => unknown) => unknown>>,
    options: Record<string, unknown>,
    base: () => AsyncIterable<number>,
): AsyncIterable<number> {
    const listeners = events.get("llm/stream") ?? [];
    const composed = listeners.reduceRight<(payload: unknown, next: () => unknown) => unknown>(
        (acc, listener) => (payload, next) => listener(payload, () => acc(payload, next)),
        () => base(),
    );
    return composed(options, () => base()) as AsyncIterable<number>;
}

/** Mock proxy: manifest + session-name + the incremental-turn probe (GET),
 *  advertised enabled so the conversion seam actually plans turns. */
function startMockProxy(): Promise<{ origin: string; server: http.Server }> {
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: [{ name: "compress", description: "Compress a range of messages", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }] },
            }));
            return;
        }
        if (url === "/__bili/plugin/session-name") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({}));
            return;
        }
        if (url === "/__bili/plugin/turn") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocol: 1, feature: "pluginIncrementalTurns", enabled: true, storage: "unified", serverHistory: true }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, server });
        });
    });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function withSetup(fn: (handle: CtxHandle) => Promise<void>): Promise<void> {
    __resetConversationRecallForTests();
    __resetIncrementalClientForTests();
    const proxy = await startMockProxy();
    const home = mkdtempSync(join(tmpdir(), "dsh-msgids-"));
    const stateHome = mkdtempSync(join(tmpdir(), "dsh-msgids-state-"));
    const saved: Record<string, string | undefined> = {};
    for (const key of ["BILLION_CONTEXT_PROXY", "DSH_HOME", "XDG_STATE_HOME", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_DSH", "BILI_PROVIDER_REWRITES"]) {
        saved[key] = process.env[key];
    }
    process.env.BILLION_CONTEXT_PROXY = proxy.origin;
    process.env.DSH_HOME = home;
    process.env.XDG_STATE_HOME = stateHome;
    delete process.env.BILLION_CONTEXT_PLUGIN;
    delete process.env.BILI_NATIVE_DSH;
    delete process.env.BILI_PROVIDER_REWRITES;
    _resetRegisterForTest(proxy.origin);
    const handle = makeCtx();
    try {
        apply(handle.ctx);
        await waitFor(() => handle.registered.length === 1, "manifest tool registration");
        await _stateToolsReadyForTest();
        await fn(handle);
    } finally {
        await _settleNativeForTest();
        proxy.server.close();
        proxy.server.closeIdleConnections?.();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(stateHome, { recursive: true, force: true });
    }
}

/** The "adapter": inside the llm/stream scope, drive beforeSend with the
 *  outgoing wire body and capture the (possibly swapped) init. */
async function dispatchTurn(
    handle: CtxHandle,
    options: Record<string, unknown>,
    wireMessages: Array<{ role: string; content: string }>,
): Promise<{ init: RequestInit; marker: string | null }> {
    const beforeSend = _stateBeforeSendForTest();
    assert.ok(beforeSend, "beforeSend seam armed");
    let init: RequestInit | undefined;
    const base = async function* (): AsyncIterable<number> {
        init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-test", max_tokens: 64, system: "be brief", messages: wireMessages }) };
        await beforeSend(MODEL_URL, init);
        yield 1;
    };
    const stream = runWaterfall(handle.events, options, base);
    const it = stream[Symbol.asyncIterator]();
    const first = await it.next();
    assert.deepEqual(first, { done: false, value: 1 }, "adapter stream advanced");
    const done = await it.return?.(undefined as never);
    assert.ok(done?.done, "adapter stream closed");
    assert.ok(init !== undefined, "beforeSend ran with the wire body");
    return { init, marker: new Headers(init.headers).get("x-bili-plugin-turn") };
}

type TurnBody = { conversationId?: string; sinceSeq?: number; resync?: boolean; messages?: unknown[]; msgIds?: string[] };

/** Ack one converted turn so the next dispatch on the same URL passes the
 *  single-flight guard (each case plans exactly one pending turn). */
function ackTurn(init: RequestInit, applied: number): void {
    const onResponse = _stateOnResponseForTest();
    assert.ok(onResponse);
    const turnId = new Headers(init.headers).get("x-bili-turn-id");
    assert.ok(turnId, "turn id stamped on the converted init");
    onResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": String(applied) } }), { "x-bili-turn-id": turnId });
}

test("llm/stream ids ride the incremental turn and stay sliced to the delta messages", async () => {
    await withSetup(async (handle) => {
        // No ambient initiator — the whole identity (sid + ids) rides the
        // llm/stream options, exactly the shape the scope exists for.
        handle.setInitiator(undefined);

        // Turn 1 (seed): 2 host messages with ids, 2 wire messages.
        const hostMsgs1 = [
            { id: "u-1", role: "user", content: "hello" },
            { id: "a-1", role: "assistant", content: "hi there" },
        ];
        const turn1 = await dispatchTurn(handle, { sessionId: "sess-msgids-1", messages: hostMsgs1 }, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ]);
        assert.equal(turn1.marker, "1", "seed converted to the incremental lane");
        const body1 = JSON.parse(turn1.init.body as string) as TurnBody;
        assert.equal(body1.conversationId, "sess-msgids-1");
        assert.equal(body1.messages?.length, 2, "seed carries the full history");
        assert.deepEqual(body1.msgIds, ["u-1", "a-1"], "seed pins the host ids in order");

        // Ack the seed (2 applied rows) so turn 2 plans a delta.
        const onResponse = _stateOnResponseForTest();
        assert.ok(onResponse);
        const turnId1 = new Headers(turn1.init.headers).get("x-bili-turn-id");
        assert.ok(turnId1, "turn id stamped on the seed");
        onResponse(MODEL_URL, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": "2" } }), { "x-bili-turn-id": turnId1 });

        // Turn 2 (delta): one NEW host message appended — only its id may
        // ride the envelope (the ids must follow the delta slice, never the
        // full history).
        const hostMsgs2 = [...hostMsgs1, { id: "u-2", role: "user", content: "and again" }];
        const turn2 = await dispatchTurn(handle, { sessionId: "sess-msgids-1", messages: hostMsgs2 }, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
            { role: "user", content: "and again" },
        ]);
        assert.equal(turn2.marker, "1", "delta converted");
        const body2 = JSON.parse(turn2.init.body as string) as TurnBody;
        assert.equal(body2.sinceSeq, 2, "delta against the acked base");
        assert.equal(body2.messages?.length, 1, "delta carries only the new message");
        assert.deepEqual(body2.msgIds, ["u-2"], "delta ids are the SLICE — the acked ids are not re-sent");
    });
});

test("one id-less host message drops the whole msgIds field (all-or-nothing)", async () => {
    await withSetup(async (handle) => {
        handle.setInitiator(undefined);
        const turn = await dispatchTurn(handle, { sessionId: "sess-msgids-2", messages: [
            { id: "u-1", role: "user", content: "hello" },
            { role: "assistant", content: "no id on me" },
        ] }, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "no id on me" },
        ]);
        assert.equal(turn.marker, "1", "turn still converts — ids are optional");
        const body = JSON.parse(turn.init.body as string) as TurnBody;
        assert.equal("msgIds" in body, false, "no partial id array is ever sent");
    });
});

test("sidecar-shaped dispatch (no messages/no ids on the options) carries no msgIds", async () => {
    await withSetup(async (handle) => {
        handle.setInitiator(undefined);
        // Title-gen / compaction sidecar: a sessionId but an options object
        // without host messages (or ids) — the turn must not invent any.
        // (Distinct wire content per shape: an identical re-send of an
        // already-acked set is a retry and legitimately plans "skip".)
        const shapes: Array<{ options: Record<string, unknown>; wire: string }> = [
            { options: { sessionId: "sess-msgids-3" }, wire: "summarize this session" },
            { options: { sessionId: "sess-msgids-3", messages: [] }, wire: "generate a session title" },
        ];
        for (const shape of shapes) {
            const turn = await dispatchTurn(handle, shape.options, [{ role: "user", content: shape.wire }]);
            assert.equal(turn.marker, "1", "sidecar turn still converts — ids are optional");
            const body = JSON.parse(turn.init.body as string) as TurnBody;
            assert.equal("msgIds" in body, false, `sidecar options (${shape.options.messages === undefined ? "no messages" : "empty messages"}) send no ids`);
            ackTurn(turn.init, body.messages?.length ?? 0);
        }
    });
});

test("captured ids that cannot line up with the sent messages never ship (degrade over mispair)", async () => {
    await withSetup(async (handle) => {
        handle.setInitiator(undefined);
        // 2 host ids vs 3 outgoing wire messages — a same-length guess could
        // misattribute; the field must be dropped entirely.
        const turn = await dispatchTurn(handle, { sessionId: "sess-msgids-4", messages: [
            { id: "u-1", role: "user", content: "hello" },
            { id: "a-1", role: "assistant", content: "hi" },
        ] }, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "extra wire message the adapter added" },
        ]);
        const body = JSON.parse(turn.init.body as string) as TurnBody;
        assert.equal(body.messages?.length, 3, "seed carries the actual wire history");
        assert.equal("msgIds" in body, false, "count mismatch ⇒ no ids — never a shifted pairing");
    });
});

test("ids the server would hard-fail on (duplicate/reserved/control) are dropped locally, turn still converts", async () => {
    await withSetup(async (handle) => {
        handle.setInitiator(undefined);
        const cases: Array<{ name: string; messages: unknown[]; wire: string[] }> = [
            { name: "duplicate id", messages: [
                { id: "u-1", role: "user", content: "hello" },
                { id: "u-1", role: "user", content: "again" },
            ], wire: ["hello", "again"] },
            { name: "reserved acp_summary_ prefix", messages: [
                { id: "acp_summary_x", role: "user", content: "third" },
            ], wire: ["third"] },
            { name: "control character in id", messages: [
                { id: "u-1\n", role: "user", content: "fourth" },
            ], wire: ["fourth"] },
        ];
        for (const c of cases) {
            const wire = c.wire.map((content) => ({ role: "user", content }));
            const turn = await dispatchTurn(handle, { sessionId: "sess-msgids-5", messages: c.messages }, wire);
            const body = JSON.parse(turn.init.body as string) as TurnBody;
            assert.equal(turn.marker, "1", `${c.name}: turn still converts`);
            assert.equal("msgIds" in body, false, `${c.name}: poisoned id array never leaves the host`);
            ackTurn(turn.init, body.messages?.length ?? 0);
        }
    });
});

test("a turn blocked by the single-flight guard does not burn its msgIds (#4491/#3370)", async () => {
    await withSetup(async (handle) => {
        // No ambient initiator — the whole identity (sid + ids) rides the
        // llm/stream options, same shape as the sibling cases above.
        handle.setInitiator(undefined);

        // Seed: converted and left UN-ACKED, so the next conversion on this
        // URL is still inside the guard's single-flight window.
        const hostMsgs1 = [
            { id: "u-1", role: "user", content: "hello" },
            { id: "a-1", role: "assistant", content: "hi there" },
        ];
        const turn1 = await dispatchTurn(handle, { sessionId: "sess-guard-burn", messages: hostMsgs1 }, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ]);
        assert.equal(turn1.marker, "1", "seed converted to the incremental lane");

        // Turn 2 while the seed is still pending: the guard leaves the
        // request on the normal pipeline. The blocked attempt must not
        // CLAIM this turn's ids client-side — a discarded plan's ids would
        // be unreclaimable (the all-or-nothing screen screens the retry
        // against them) and the host's retry would silently lose the whole
        // msgIds field, pinning the server to content-derived identity.
        const hostMsgs2 = [...hostMsgs1, { id: "u-2", role: "user", content: "and again" }];
        const wire2 = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
            { role: "user", content: "and again" },
        ];
        const turn2blocked = await dispatchTurn(handle, { sessionId: "sess-guard-burn", messages: hostMsgs2 }, wire2);
        assert.equal(turn2blocked.marker, null, "single-flight guard: the delta attempt rides the normal pipeline untouched");

        // The seed finally acks; the host retries turn 2 — the retry must
        // still pin the host ids ("u-2" must not have been burned by the
        // blocked attempt).
        ackTurn(turn1.init, 2);
        const turn2 = await dispatchTurn(handle, { sessionId: "sess-guard-burn", messages: hostMsgs2 }, wire2);
        assert.equal(turn2.marker, "1", "retry converts once the guard window closes");
        const body2 = JSON.parse(turn2.init.body as string) as TurnBody;
        assert.equal(body2.sinceSeq, 2, "delta against the acked base");
        assert.deepEqual(body2.msgIds, ["u-2"], "the blocked attempt did not burn the delta ids");
    });
});
