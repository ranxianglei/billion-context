import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { responsesToCore, type ResponsesRequestBody } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { strippedResponseIdWarning } from "../src/util.ts";
import { createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #1954: bili's Responses adapter replays `input` as the FULL conversation and
// strips `previous_response_id`, so it cannot materialize the history a native-
// chaining (delta) continuation references. Stripping therefore converts "can't
// compress this delta" into silent total context loss (HTTP 200 either way).
// These tests pin the SAFETY BOUNDARY added here: a production WARN fires on
// both the HTTP and loop-adapter paths whenever a non-empty id is stripped, so
// the loss stops being invisible. This is visibility only — it does NOT rebuild
// the missing history (that is the separately-tracked chaining-support feature).

// ── Pure helper: the warning condition ──────────────────────────────────────

test("strippedResponseIdWarning: fires on a non-empty id, keyed off the id alone (omitted store covered)", () => {
    // The trigger keys off the id ALONE, not off `store`: Responses stores
    // responses by default, so an omitted `store` still leaves the referenced
    // response resolvable upstream. Gating on explicit store:true would miss it.
    const w = strippedResponseIdWarning("resp_audit_first");
    assert.ok(w, "non-empty string id produces a warning");
    assert.ok(w!.includes("resp_audit_first"), "warning names the stripped id");
    assert.ok(w!.includes("#1954"), "warning carries the issue provenance for log grepping");
});

test("strippedResponseIdWarning: silent on absent / empty / non-string ids", () => {
    assert.equal(strippedResponseIdWarning(undefined), null);
    assert.equal(strippedResponseIdWarning(null), null);
    assert.equal(strippedResponseIdWarning(""), null);
    assert.equal(strippedResponseIdWarning(123), null);
    assert.equal(strippedResponseIdWarning({}), null);
});

// ── Loop-adapter path ───────────────────────────────────────────────────────

function runAdapterCase(id: string | undefined): { rebuilt: Record<string, unknown>; warns: string[] } {
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    try {
        const body = { model: "gpt-x", input: [{ type: "message", role: "user", content: "turn" }], ...(id !== undefined ? { previous_response_id: id } : {}) } as unknown as ResponsesRequestBody;
        const projection = responsesToCore(body);
        const adapter = createResponsesAdapter(false, projection);
        const rebuilt = adapter.buildRequest(projection.msgs, buildCompressSystemPrompt(), body) as Record<string, unknown>;
        return { rebuilt, warns: captured.filter((m) => m.includes("#1954")) };
    } finally {
        setLogCapture(null);
    }
}

function withKeep(v: string | undefined, fn: () => void): void {
    const prev = process.env.ACP_KEEP_RESPONSE_ID;
    if (v === undefined) delete process.env.ACP_KEEP_RESPONSE_ID; else process.env.ACP_KEEP_RESPONSE_ID = v;
    try { fn(); } finally {
        if (prev === undefined) delete process.env.ACP_KEEP_RESPONSE_ID; else process.env.ACP_KEEP_RESPONSE_ID = prev;
    }
}

test("#1954 loop adapter: stripping a non-empty previous_response_id warns once", () => {
    withKeep(undefined, () => {
        const { rebuilt, warns } = runAdapterCase("resp_delta_1");
        assert.ok(!("previous_response_id" in rebuilt), "id stripped from the rebuilt body");
        assert.equal(warns.length, 1, "exactly one #1954 warn");
        assert.ok(warns[0].includes("resp_delta_1"), "warn names the stripped id");
    });
});

test("#1954 loop adapter: ACP_KEEP_RESPONSE_ID=1 preserves the id and stays silent", () => {
    withKeep("1", () => {
        const { rebuilt, warns } = runAdapterCase("resp_keep_1");
        assert.equal(rebuilt.previous_response_id, "resp_keep_1", "id preserved under KEEP=1");
        assert.equal(warns.length, 0, "no #1954 warn when the id is kept");
    });
});

test("#1954 loop adapter: absent id neither strips nor warns", () => {
    withKeep(undefined, () => {
        const { rebuilt, warns } = runAdapterCase(undefined);
        assert.ok(!("previous_response_id" in rebuilt), "no id to strip");
        assert.equal(warns.length, 0, "no #1954 warn without an id");
    });
});

// ── HTTP path (real proxy through startServer) ──────────────────────────────

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}
function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
function textDone(): string {
    return [
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }),
    ].join("");
}

async function withProxy(fn: (url: string, bodies: string[]) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(textDone());
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-chain-1954": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        // log:true is REQUIRED: the handler routes through logMsg(), which drops
        // every line when opts.log is falsy before reaching the module logger —
        // so setLogCapture could only observe direct module-log callers (e.g.
        // affinity-persist) and would miss the request-handler warn under test.
        log: true,
        logFile: "off",
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
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, bodies);
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

async function driveDeltaContinuation(url: string, bodies: string[], keepEnv: string | undefined): Promise<void> {
    const prev = process.env.ACP_KEEP_RESPONSE_ID;
    const apply = (v: string | undefined): void => { if (v === undefined) delete process.env.ACP_KEEP_RESPONSE_ID; else process.env.ACP_KEEP_RESPONSE_ID = v; };
    apply(keepEnv);
    try {
        const headers = { "content-type": "application/json", "x-acp-session": "audit-chain" };
        // turn 1: seed, no chain ref
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-chain-1954", stream: true, input: [{ type: "message", role: "user", content: "Remember AUDIT_SECRET_4781" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        // turn 2: DELTA continuation — only the new turn, references turn 1 via
        // previous_response_id, `store` omitted (Responses default = stored).
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-chain-1954", stream: true, previous_response_id: "resp_audit_first", input: [{ type: "message", role: "user", content: "Repeat the previous secret" }] }) });
        assert.equal(r2.status, 200);
        await r2.text();
    } finally {
        apply(prev);
    }
}

test("#1954 HTTP path: delta continuation strips the id, does NOT rebuild history, and warns", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    try {
        await withProxy(async (url, bodies) => {
            await driveDeltaContinuation(url, bodies, undefined);
            assert.equal(bodies.length, 2, "one upstream forward per client turn");
            const fwd2 = JSON.parse(bodies[1]) as Record<string, unknown>;
            assert.ok(!("previous_response_id" in fwd2), "chain ref stripped from the forwarded body");
            assert.ok(!bodies[1].includes("AUDIT_SECRET_4781"), "turn-1 history NOT rebuilt into the delta forward (the #1954 gap this PR only surfaces)");
            const warns = captured.filter((m) => m.includes("#1954") && m.includes("resp_audit_first"));
            assert.equal(warns.length, 1, "exactly one #1954 warn names the stripped id");
        });
    } finally {
        setLogCapture(null);
    }
});

test("#1954 HTTP path: ACP_KEEP_RESPONSE_ID=1 keeps the id forwarded and stays silent", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    try {
        await withProxy(async (url, bodies) => {
            await driveDeltaContinuation(url, bodies, "1");
            assert.equal(bodies.length, 2);
            const fwd2 = JSON.parse(bodies[1]) as Record<string, unknown>;
            assert.equal(fwd2.previous_response_id, "resp_audit_first", "id forwarded intact under KEEP=1 (native semantics preserved)");
            assert.equal(captured.filter((m) => m.includes("#1954")).length, 0, "no #1954 warn when the id is kept");
        });
    } finally {
        setLogCapture(null);
    }
});
