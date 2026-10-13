// #2612/#2728: Claude Code native-compaction wire guard (claude.allowNativeCompaction).
// Pins: (a) detector strictness — the FULL CC template (BOTH phrases) on the
// final user message, across anthropic/openai/responses wires; single-phrase
// paraphrase, mid-history quotes, and foreign summarize prompts must NOT trip
// it; (b) config resolution matrix (file / env / default OFF); (c) the
// end-to-end flip — the guard refuses CC compaction envelopes locally with 403
// (never forwarded, nothing reaches upstream) and forwards once the opt-in is
// set in the config file; (d) refusal body shape per protocol; (e) the
// strict-AND contract vs the #2619 retry-exemption detector (either-phrase,
// fail-open) which stays independently green.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { allowClaudeCompactionState, loadOptions, type ProxyOptions } from "../src/config.ts";
import { claudeCompactionRefusal, isClaudeCompactionCall } from "../src/server/claude-compaction-guard.ts";
import { requestExpectsProseSummary } from "../src/degenerate-turn.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** The production CC 2.1.x compaction instruction (mirror of the #2619
 *  fixture, tests/issue2612-compaction-draft-tail.test.ts). */
const CC_COMPACTION_PROMPT = [
    "Summarize the conversation so far. Your summary should be about 8-29 sentences. ",
    "Wrap your summary in <summary></summary> tags.",
    "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.",
].join("\n");

/** Just the first production phrase — what a human paraphrasing the format
 *  ("wrap your summary in tags") would produce. Must NOT trip the guard. */
const HALF_PHRASE = "Summarize our chat. Wrap your summary in <summary></summary> tags.";
/** Just the second phrase. */
const OTHER_HALF_PHRASE = "Answer in plain text only — an <analysis> block followed by a <summary> block.";

// ---------------------------------------------------------------------------
// (a) detector

test("#2612: isClaudeCompactionCall — full CC template on the FINAL user message, anthropic wire", () => {
    const body = {
        model: "claude-sonnet-4-5",
        system: "You are Claude Code",
        messages: [
            { role: "user", content: "help me write a login form" },
            { role: "assistant", content: "ok" },
            { role: "user", content: CC_COMPACTION_PROMPT },
        ],
    };
    assert.equal(isClaudeCompactionCall("anthropic", body), true, "full template on final user message = compaction call");
});

test("#2612: isClaudeCompactionCall — openai wire (CC behind a router)", () => {
    const body = {
        model: "gpt-x",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "do things" },
            { role: "assistant", content: "done" },
            { role: "user", content: CC_COMPACTION_PROMPT },
        ],
    };
    assert.equal(isClaudeCompactionCall("openai", body), true);
});

test("#2612: isClaudeCompactionCall — responses wire (input[] final user item)", () => {
    const body = {
        model: "gpt-x",
        instructions: "sys",
        input: [
            { type: "message", role: "user", content: "do things" },
            { type: "message", role: "assistant", content: "done" },
            { type: "message", role: "user", content: CC_COMPACTION_PROMPT },
        ],
    };
    assert.equal(isClaudeCompactionCall("responses", body), true);
});

test("#2612: strict-AND — a single phrase alone is human paraphrase, not the template", () => {
    for (const text of [HALF_PHRASE, OTHER_HALF_PHRASE]) {
        const body = { messages: [{ role: "user", content: text }] };
        assert.equal(isClaudeCompactionCall("anthropic", body), false, `must not refuse: ${text.slice(0, 40)}…`);
    }
});

test("#2612: mid-history quote is NOT a compaction call (final-user decisive)", () => {
    const body = {
        messages: [
            { role: "user", content: CC_COMPACTION_PROMPT },
            { role: "assistant", content: "past turn quoting it" },
            { role: "user", content: "and now the actual question?" },
        ],
    };
    assert.equal(isClaudeCompactionCall("anthropic", body), false);
});

test("#2612: ordinary traffic never trips the guard", () => {
    assert.equal(isClaudeCompactionCall("anthropic", { messages: [{ role: "user", content: "please summarize this file" }] }), false);
    assert.equal(isClaudeCompactionCall("anthropic", { messages: [{ role: "assistant", content: CC_COMPACTION_PROMPT }] }), false, "assistant-authored text is not a compaction trigger");
    assert.equal(isClaudeCompactionCall("openai", { messages: [{ role: "user", content: "hello" }] }), false);
    assert.equal(isClaudeCompactionCall("responses", { input: [{ type: "message", role: "user", content: "hello" }] }), false);
    assert.equal(isClaudeCompactionCall("anthropic", null), false, "unparseable body fails closed-forward (no refusal, normal pipeline)");
    assert.equal(isClaudeCompactionCall(null, { messages: [{ role: "user", content: CC_COMPACTION_PROMPT }] }), false, "unknown protocol is not guarded");
    assert.equal(isClaudeCompactionCall("google", { contents: [{ role: "user", parts: [{ text: CC_COMPACTION_PROMPT }] }] }), false, "google stays out of scope (CC speaks no google wire)");
});

test("#2612: refusal shape per protocol — anthropic error envelope vs openai coded error", () => {
    const ant = claudeCompactionRefusal("anthropic");
    assert.equal(ant.status, 403);
    const antBody = ant.body as { type: string; error: { type: string; message: string } };
    assert.equal(antBody.type, "error");
    assert.equal(antBody.error.type, "invalid_request_error");
    assert.ok(antBody.error.message.includes("allowNativeCompaction") && antBody.error.message.includes("BILI_ALLOW_CLAUDE_COMPACTION"), "message points at the real opt-in");

    const oai = claudeCompactionRefusal("openai");
    assert.equal(oai.status, 403);
    const oaiBody = oai.body as { error: { code: string; retryable: boolean; message: string } };
    assert.equal(oaiBody.error.code, "claude_compaction_refused");
    assert.equal(oaiBody.error.retryable, false, "policy refusal — retry logic must not treat it as transient");

    const resp = claudeCompactionRefusal("responses");
    assert.equal((resp.body as { error: { code: string } }).error.code, "claude_compaction_refused");
});

// ---------------------------------------------------------------------------
// (b) config resolution

function withConfig(body: string | null, fn: () => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue2612-"));
    const file = path.join(dir, "billion-context.json");
    if (body !== null) writeFileSync(file, body, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

function envWith(value: string | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) env.BILI_ALLOW_CLAUDE_COMPACTION = value;
    return env;
}

test("#2612: allowClaudeCompaction resolution — file, env, default OFF", () => {
    withConfig(null, () => assert.equal(loadOptions(envWith(undefined)).allowClaudeCompaction, false, "default OFF (guard active)"));
    withConfig('{"claude":{"allowNativeCompaction":true}}', () => assert.equal(loadOptions(envWith(undefined)).allowClaudeCompaction, true, "file enables (claude.* section)"));
    withConfig('{"claude":{"allowNativeCompaction":true}}', () => assert.equal(loadOptions(envWith("0")).allowClaudeCompaction, false, "env 0 beats file"));
    withConfig(null, () => assert.equal(loadOptions(envWith("1")).allowClaudeCompaction, true, "env 1 enables"));
    withConfig(null, () => assert.equal(loadOptions(envWith("yes")).allowClaudeCompaction, true, "non-\"0\" env values enable (house BILI_ boolean semantics)"));
});

test("#2612: allowClaudeCompactionState source resolution", () => {
    withConfig(null, () => assert.deepEqual(allowClaudeCompactionState(envWith(undefined)), { enabled: false, source: null }));
    withConfig('{"claude":{"allowNativeCompaction":true}}', () => assert.deepEqual(allowClaudeCompactionState(envWith(undefined)), { enabled: true, source: "file" }));
    withConfig('{"claude":{"allowNativeCompaction":true}}', () => assert.deepEqual(allowClaudeCompactionState(envWith("0")), { enabled: false, source: "env" }));
    withConfig(null, () => assert.deepEqual(allowClaudeCompactionState(envWith("1")), { enabled: true, source: "env" }));
});

// ---------------------------------------------------------------------------
// (e) contract vs the #2619 retry-exemption detector

test("#2612: division of labor with #2619 — exemption is either-phrase (fail-open), guard is both-phrase (fail-closed)", () => {
    // The exemption must still fire on EITHER phrase so a reworded/one-phrase
    // CC variant never wastes a draft-tail retry…
    assert.equal(requestExpectsProseSummary(HALF_PHRASE), true);
    assert.equal(requestExpectsProseSummary(OTHER_HALF_PHRASE), true);
    assert.equal(requestExpectsProseSummary("unrelated"), false);
    // …while the wire guard requires the full machine template.
    assert.equal(isClaudeCompactionCall("anthropic", { messages: [{ role: "user", content: HALF_PHRASE }] }), false);
    assert.equal(isClaudeCompactionCall("anthropic", { messages: [{ role: "user", content: CC_COMPACTION_PROMPT }] }), true);
});

// ---------------------------------------------------------------------------
// (c) integration: real bili server + mock upstream

function closeServer(server: http.Server): Promise<void> {
    server.closeAllConnections?.();
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function post(port: number, reqPath: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const data = JSON.stringify(payload);
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)), ...headers },
    }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(data);
    return promise;
}

test("#2612: the wire guard refuses CC compaction locally; claude.allowNativeCompaction forwards it", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2612-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;

    const received: string[] = [];
    const mock = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            received.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "msg_2612", type: "message", role: "assistant", model: "mock",
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 5 },
            }));
        });
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const mockPort = (mock.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${mockPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const bili = await startServer(opts);
    await once(bili, "listening");
    const port = (bili.address() as { port: number }).port;

    const compactionPost = (): Promise<{ status: number; body: string }> => post(port, "/v1/messages", {
        model: "mock",
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [
            { role: "user", content: "help me write a login form" },
            { role: "assistant", content: "sure" },
            { role: "user", content: CC_COMPACTION_PROMPT },
        ],
    }, { "x-acp-session": "s-2612" });
    const normalPost = (): Promise<{ status: number; body: string }> => post(port, "/v1/messages", {
        model: "mock",
        messages: [{ role: "user", content: HALF_PHRASE }],
    }, { "x-acp-session": "s-2612b" });

    try {
        // A: default — refused locally with the anthropic error envelope,
        //    nothing reaches the upstream; the session metadata records it.
        let r = await compactionPost();
        assert.equal(r.status, 403, `default must refuse (got ${r.status}: ${r.body})`);
        const refused = JSON.parse(r.body) as { type: string; error: { type: string; message: string } };
        assert.equal(refused.type, "error");
        assert.equal(refused.error.type, "invalid_request_error");
        assert.ok(refused.error.message.includes("refused by billion-context"), refused.error.message);
        assert.equal(received.length, 0, "refused call never reaches the upstream");

        // Repeat under the SAME session key: still 403, still nothing
        // upstream (idempotence; the once-warn flag must not gate the
        // refusal itself).
        r = await compactionPost();
        assert.equal(r.status, 403);
        assert.equal(received.length, 0);

        // B: paraphrase traffic is untouched by the guard (fails open onto
        //    the normal pipeline).
        r = await normalPost();
        assert.equal(r.status, 200, `half-phrase must forward (got ${r.status}: ${r.body})`);
        assert.equal(received.length, 1, "normal traffic reaches the upstream");

        // C: opt-in through the config file → the envelope forwards.
        writeFileSync(cfgFile, '{"providers":{},"claude":{"allowNativeCompaction":true}}\n', "utf8");
        const reloaded = loadOptions(process.env); // fresh resolution reads the file
        assert.equal(reloaded.allowClaudeCompaction, true, "file opt-in resolves");
        r = await compactionPost();
        // No hot-reload: startServer captured opts at launch, so the guard
        // decision is fixed for this server's lifetime — started without the
        // opt-in, it stays refusing even after the file flips above (the
        // opt-in path is covered by the fresh-server test below).
        assert.equal(r.status, 403, `no hot-reload: guard stays active for the server lifetime (got ${r.status})`);
    } finally {
        process.env.BILI_CONFIG_FILE = prevConfig ?? "";
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        await closeServer(bili);
        await closeServer(mock);
        rmrf(root);
    }
});

test("#2612: guard-off server lifetime — opts.allowClaudeCompaction=true forwards the envelope byte-exact", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2612b-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });

    const received: string[] = [];
    const mock = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            received.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_2612b", type: "message", role: "assistant", model: "mock", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
        });
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const mockPort = (mock.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${mockPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        allowClaudeCompaction: true, // the opt-in as the server would receive it from loadOptions()
    };
    const bili = await startServer(opts);
    await once(bili, "listening");
    const port = (bili.address() as { port: number }).port;

    try {
        const r = await post(port, "/v1/messages", {
            model: "mock",
            messages: [
                { role: "user", content: "work" },
                { role: "user", content: CC_COMPACTION_PROMPT },
            ],
        }, { "x-acp-session": "s-2612-optin" });
        assert.equal(r.status, 200, `opt-in must forward (got ${r.status}: ${r.body})`);
        assert.equal(received.length, 1);
        assert.ok(received[0].includes("Wrap your summary in"), "envelope forwarded (template text reaches upstream)");
    } finally {
        await closeServer(bili);
        await closeServer(mock);
        rmrf(root);
    }
});
