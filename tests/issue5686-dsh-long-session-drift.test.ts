import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { apply, _resetRegisterForTest, _resetWebProfileWarningForTest, _resetNonWebTraceForTest, _setSpawnForTest, _settleNativeForTest, _stateToolsReadyForTest } from "../src/agent/dsh-native.ts";
import { personaConversationOrder, resolveSessionOrder, resetSessionOrderForTest, type SessionOrderResolution } from "../src/session-resolve.ts";
import { rmrf } from "./tmp-rm.ts";

// #5686: dsh long-session drift comprehensive remediation — regression pins for
// the four parts: P0-1 the last native-compaction local-landing leak window in
// the fetch patch's direct-send paths; P0-2 the silent compaction-disable latch
// gap on non-web profile shapes; P1-1 fork/migration visibility; P1-2 the
// deterministic identity fork when a landed checkpoint meets a re-stamped system.
//
// #1365 hygiene copied from dsh-native.test.ts: drain attach chains after each
// test and start from a clean attach/proxy env slate.
afterEach(() => { void _settleNativeForTest(); });
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withPatch(state: NativeInterceptState, fn: (fetch: typeof globalThis.fetch) => Promise<Response>): Promise<{ sink: string[]; result: Response }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: string[] = [];
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn(globalThis.fetch);
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

/** A decisive dsh native-compaction call on the anthropic wire: the LAST user
 *  message starts with the versioned instruction prefix (#2193 marker doctrine). */
function anthropicCompactionBody(): string {
    return JSON.stringify({
        model: "dsh-test-model",
        max_tokens: 4096,
        messages: [
            { role: "user", content: "first user turn" },
            { role: "assistant", content: "first assistant turn" },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} condense the shadowed region into a checkpoint` },
        ],
    });
}

test("#5686 P0-1: no live proxy + decisive dsh compaction call ⇒ local 422, upstream untouched", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: anthropicCompactionBody() }));
    assert.equal(result.status, 422);
    assert.equal(result.headers.get("x-bili-gate"), "dsh-compaction-refused");
    const parsed = JSON.parse(await result.text()) as Record<string, unknown>;
    assert.equal(parsed.bili_final, true);
    assert.deepEqual(sink, []);
});

test("#5686 P0-1: takeover-gate-false path without origin ⇒ same refusal (the #2709 divert fall-through)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50, takeoverGate: async () => false };
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: anthropicCompactionBody() }));
    assert.equal(result.status, 422);
    assert.equal(result.headers.get("x-bili-gate"), "dsh-compaction-refused");
    assert.deepEqual(sink, []);
});

test("#5686 P0-1: responses wire shape is refused too (protocol inference + input[] reader)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const body = JSON.stringify({
        model: "dsh-test-model",
        input: [
            { type: "message", role: "user", content: "hi" },
            { type: "message", role: "assistant", content: "yo" },
            { type: "message", role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} write the checkpoint` },
        ],
    });
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body }));
    assert.equal(result.status, 422);
    assert.equal(result.headers.get("x-bili-gate"), "dsh-compaction-refused");
    assert.deepEqual(sink, []);
});

test("#5686 P0-1: marker merely MENTIONED mid-body never false-positives (fail-open direct send)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const body = JSON.stringify({
        model: "dsh-test-model",
        max_tokens: 1024,
        messages: [
            { role: "user", content: `please quote verbatim in your reply: "${DSH_COMPACTION_INSTRUCTION_PREFIX}"` },
            { role: "assistant", content: "ok" },
            { role: "user", content: "now write the test file" },
        ],
    });
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body }));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-bili-gate"), null);
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
});

test("#5686 P0-1: streaming request body stays fail-open (fetch API cannot peek a ReadableStream)", async () => {
    const state: NativeInterceptState = { origin: undefined, ready: Promise.resolve(undefined), readyTimeoutMs: 50 };
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(anthropicCompactionBody()));
            controller.close();
        },
    });
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: stream }));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-bili-gate"), null);
    assert.deepEqual(sink, ["http://127.0.0.1:8199/v1/messages"]);
});

test("#5686 P0-1: with a LIVE proxy the choke point is inert — the request routes to bili (server gate owns it)", async () => {
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { sink, result } = await withPatch(state, async (fetch) =>
        fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: anthropicCompactionBody() }));
    assert.equal(result.status, 200);
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

// ---- P0-2: the compaction-disable overlay latch alarm must fire on EVERY
// profile shape, not only the web-app one (#5684 desktop blind spot). --------

function startMinimalMockProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        const url = (req.url ?? "").split("?")[0];
        if (url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.119", tools: {} }));
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ panel: "PANEL-OK" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

type BareCtx = Parameters<typeof apply>[0];

function runApplyWithShape(bare: BareCtx): Promise<string[]> {
    let proxy!: { origin: string; close: () => void };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-p02-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-p02-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    // Filter to the compaction-disable latch lines specifically ("overlay" in
    // the alarm wording, "middleware" in the passive trace): a fresh process
    // also logs first-attach noise (version negotiation, manifest retries) on
    // this channel, which is orthogonal to what these pins assert.
    const overlayLines = (): string[] => fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("compaction-disable"))
        : [];
    _setSpawnForTest(async () => undefined);
    let lines: string[] = [];
    return (async () => {
        try {
            proxy = await startMinimalMockProxy();
            lines = await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
                _resetRegisterForTest(proxy.origin);
                _resetWebProfileWarningForTest();
                _resetNonWebTraceForTest();
                apply(bare);
                await _stateToolsReadyForTest();
                return overlayLines();
            });
        } finally {
            _setSpawnForTest(undefined);
            proxy.close();
            rmrf(home);
            rmrf(stateHome);
            _resetRegisterForTest(undefined);
            _resetWebProfileWarningForTest();
            _resetNonWebTraceForTest();
        }
        return lines;
    })();
}

test("#5686 P0-2: non-web profile + hook-less host ⇒ ARMED alarm (was: silent passive trace)", async () => {
    const bare: BareCtx = {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: {},
        profileContext: { startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"] },
    };
    const lines = await runApplyWithShape(bare);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /do not include @deepseek-ai\/dsh-web-app/);
    assert.match(lines[0], /could not latch/i);
    assert.match(lines[0], /no-config-hook/);
    assert.match(lines[0], /ARMED/i);
    assert.match(lines[0], /#5684/);
    assert.doesNotMatch(lines[0], /registered anyway/i);
});

test("#5686 P0-2: non-web profile + capable host ⇒ existing passive trace unchanged (regression)", async () => {
    const capable: BareCtx = {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: {},
        on: () => undefined,
        reflect: { provide: () => undefined },
        profileContext: { startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"] },
    };
    const lines = await runApplyWithShape(capable);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /do not include @deepseek-ai\/dsh-web-app/);
    assert.match(lines[0], /#3354/);
    assert.doesNotMatch(lines[0], /could not latch/i);
});

test("#5686 P0-2: web profile + hook-less host ⇒ existing web ARMED alarm unchanged (regression)", async () => {
    const bare: BareCtx = {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: {},
        profileContext: { startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "billion-context"] },
    };
    const lines = await runApplyWithShape(bare);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /include @deepseek-ai\/dsh-web-app/);
    assert.match(lines[0], /could not latch/i);
    assert.match(lines[0], /no-config-hook/);
    assert.match(lines[0], /ARMED/i);
});

test("#5686 P0-2: unintrospectable profile shape (no bundle list) + hook-less host ⇒ ARMED alarm too", async () => {
    // Absorbed from parallel PR #5692's broader coverage: older dsh builds
    // expose no profileContext at all — pre-absorption this shape stayed
    // silent even when the overlay could not latch.
    const bare: BareCtx = {
        tools: { register: () => undefined },
        commands: { register: () => undefined },
        agents: {},
    };
    const lines = await runApplyWithShape(bare);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /could not be introspected/);
    assert.match(lines[0], /could not latch/i);
    assert.match(lines[0], /no-config-hook/);
    assert.match(lines[0], /ARMED/i);
});

// ---- P1-1 + P1-2: session order resolution visibility and the landed-checkpoint rung. ----

const H = [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
];
/** Head truncation keeping the old tail VERBATIM — the post-landing shape:
 *  the checkpoint rewrote the head, the living tail survives byte-identical. */
const TAIL = H.slice(2);

test("#5686 P1-2 control: tagless head truncation still reanchors (existing shorter-rung unchanged)", () => {
    resetSessionOrderForTest();
    const claim = resolveSessionOrder("id-x", H, "system-tag-A");
    assert.equal(claim.action, "claim");
    assert.equal(claim.key, "id-x");
    const r = resolveSessionOrder("id-x", TAIL, "system-tag-A");
    assert.equal(r.action, "reanchor");
    assert.equal(r.key, "id-x");
});

test("#5686 P1-2 regression pin: head truncation WITH persona re-stamp reanchors instead of forking", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("id-x", H, "system-tag-A");
    const r = resolveSessionOrder("id-x", TAIL, "system-tag-B");
    assert.equal(r.action, "reanchor");
    assert.equal(r.key, "id-x");
    assert.match(r.reason ?? "", /#5686/);
});

test("#5686 P1-2 guard: shorter stranger with a DIFFERENT tail still forks (byte-equality stays hard)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("id-y", H, "system-tag-A");
    const stranger = [
        { role: "user", content: "x2" },
        { role: "assistant", content: "y2" },
        { role: "user", content: "x3" },
        { role: "assistant", content: "y3" },
    ];
    const r = resolveSessionOrder("id-y", stranger, "system-tag-B");
    assert.equal(r.action, "derived-persona");
    assert.notEqual(r.key, "id-y");
    assert.ok(r.key.startsWith("id-y|sub:"), `lane key should be suffixed, got ${r.key}`);
});

test("#5686 P1-2 guard: same-length disjoint history under a new tag still forks (strict-shorter gate holds)", () => {
    resetSessionOrderForTest();
    resolveSessionOrder("id-z", H, "system-tag-A");
    const eq = [
        { role: "user", content: "q1" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "r2" },
        { role: "user", content: "q3" },
        { role: "assistant", content: "r3" },
    ];
    const r = resolveSessionOrder("id-z", eq, "system-tag-B");
    assert.equal(r.action, "derived-persona");
    assert.notEqual(r.key, "id-z");
});

test("#5686 P1-1: personaConversationOrder callback surfaces the full resolution; absence keeps old behavior", () => {
    resetSessionOrderForTest();
    const seen: Array<{ rawId: string; resolution: SessionOrderResolution }> = [];
    const cb = (rawId: string, resolution: SessionOrderResolution): void => { seen.push({ rawId, resolution }); };

    const k1 = personaConversationOrder("id-cb", H, "tag-A", undefined, undefined, undefined, cb);
    assert.equal(k1, "id-cb");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rawId, "id-cb");
    assert.equal(seen[0].resolution.action, "claim");
    assert.equal(seen[0].resolution.key, "id-cb");

    // tag change onto a disjoint same-length history ⇒ fork, surfaced
    const eq = [
        { role: "user", content: "q1" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "r2" },
        { role: "user", content: "q3" },
        { role: "assistant", content: "r3" },
    ];
    const k2 = personaConversationOrder("id-cb", eq, "tag-B", undefined, undefined, undefined, cb);
    assert.notEqual(k2, "id-cb");
    assert.equal(seen[1].resolution.action, "derived-persona");
    assert.equal(seen[1].resolution.key, k2);

    // reanchor (P1-2 rung) also flows through the adapter
    const k3 = personaConversationOrder("id-cb", TAIL, "tag-C", undefined, undefined, undefined, cb);
    assert.equal(k3, "id-cb");
    assert.equal(seen[2].resolution.action, "reanchor");

    // no callback ⇒ identical key behavior
    resetSessionOrderForTest();
    assert.equal(personaConversationOrder("id-cb2", H, "tag-A"), "id-cb2");
});
