// #2028/#3666: the allowDshCompaction escape hatch is REMOVED — dsh native
// compaction is refused unconditionally by the #1729 wire guard on every lane.
// This suite pins the removal contract: (a) legacy file keys (nested dsh.* and
// the bare top-level position) and the stale env var are ignored, each with a
// one-time deprecation warning; (b) the refusal message states the
// unconditional contract with no dead opt-in pointers; (c) the web API no
// longer exposes the field, rejects structured dsh writes loudly, and
// whole-file saves preserve leftover keys verbatim (still inert).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadOptions, loadRoutes, type ProxyOptions } from "../src/config.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX, dshCompactionRefusal } from "../src/server/dsh-compaction-guard.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

const REMOVED_MARK = "was removed (#3651";
const UNKNOWN_KEY_PREFIX = "[acp-config] ignoring unknown top-level config key(s): ";

function removedWarns(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.level === "warn" && e.msg.startsWith("[acp-config]") && e.msg.includes(REMOVED_MARK));
}

function unknownKeyWarns(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.level === "warn" && e.msg.startsWith(UNKNOWN_KEY_PREFIX));
}

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

/** Point BILI_CONFIG_FILE at a temp file (or a missing path when body is
 *  null) for the duration of fn, restoring the previous value afterwards. */
function withConfig(body: string | null, fn: () => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue2028-"));
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

test("#3666: legacy dsh.allowDshCompaction file key is ignored with a one-time deprecation warning", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfig('{"dsh":{"allowDshCompaction":true}}', () => {
            loadRoutes();
            let warns = removedWarns(captured);
            assert.equal(warns.length, 1, `expected 1 removal warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
            assert.ok(warns[0].msg.includes("dsh.allowDshCompaction"), warns[0].msg);
            assert.ok(!unknownKeyWarns(captured).some((e) => e.msg.includes("dsh")), "the recognized dsh section must not trip the unknown-key warning");
            loadRoutes();
            assert.equal(removedWarns(captured).length, 1, "identical key set must not repeat the warning");
        });
    } finally {
        stop();
    }
});

test("#3666: the live dsh.authoredCompaction key (#3723/#3901) never trips the removed-key warning", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfig('{"dsh":{"authoredCompaction":false}}', () => {
            loadRoutes();
            assert.equal(removedWarns(captured).length, 0, `a live key must not be named in a removal warning: ${captured.map((e) => e.msg).join(" | ")}`);
        });
    } finally {
        stop();
    }
});

test("#3666: legacy top-level allowDshCompaction gets its own warning, not the generic unknown-key one", () => {
    const { captured, stop } = captureLogs();
    try {
        withConfig('{"allowDshCompaction":true}', () => {
            loadRoutes();
            assert.ok(!unknownKeyWarns(captured).some((e) => e.msg.includes("allowDshCompaction")), "removed key must not be flagged as an unknown typo");
            const warns = removedWarns(captured);
            assert.equal(warns.length, 1, `expected 1 removal warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
            assert.ok(warns[0].msg.includes('top-level "allowDshCompaction"'), warns[0].msg);
        });
    } finally {
        stop();
    }
});

test("#3666: stale BILI_ALLOW_DSH_COMPACTION env warns once per process and changes nothing", () => {
    const { captured, stop } = captureLogs();
    try {
        loadOptions({ BILI_ALLOW_DSH_COMPACTION: "1" });
        let warns = removedWarns(captured);
        assert.equal(warns.length, 1, `expected 1 env removal warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
        assert.ok(warns[0].msg.includes("BILI_ALLOW_DSH_COMPACTION"), warns[0].msg);
        loadOptions({ BILI_ALLOW_DSH_COMPACTION: "1" });
        warns = removedWarns(captured);
        assert.equal(warns.length, 1, "env warning is once per process");
        assert.ok(!("allowDshCompaction" in loadOptions({})), "the option itself is gone from ProxyOptions");
    } finally {
        stop();
    }
});

test("#3666: refusal message states the unconditional contract (dead opt-in pointers gone)", () => {
    const body = dshCompactionRefusal("openai").body as { error: { message: string } };
    assert.ok(!body.error.message.includes("standard-bili-auto-off"), "stale preset reference must be gone");
    assert.ok(body.error.message.includes("unconditional") && body.error.message.includes("#3651"), body.error.message);
    assert.ok(!body.error.message.includes("BILI_ALLOW_DSH_COMPACTION"), "dead env pointer must be gone");
});

// ---------------------------------------------------------------------------
// Integration: real bili server + real mock upstream, live web API contract.

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

/** PUT variant — the web config API is PUT /__bili/config (POST 404s). */
function put(port: number, reqPath: string, payload: unknown): Promise<{ status: number; body: string }> {
    const data = JSON.stringify(payload);
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) },
    }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(data);
    return promise;
}

async function get(port: number, reqPath: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}

test("#3666: web API no longer exposes or accepts the switch; the guard refuses unconditionally", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2028-${process.pid}-${Date.now()}`);
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
                id: "chatcmpl_2028", object: "chat.completion", created: 1, model: "mock",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

    const compactionPost = (): Promise<{ status: number; body: string }> => post(port, "/v1/chat/completions", {
        model: "mock",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Summarize the conversation above.` },
        ],
    }, { "x-acp-session": "s-2028" });
    const cfgJson = async (): Promise<Record<string, unknown>> => JSON.parse((await get(port, "/__bili/config")).body);

    try {
        // A: GET no longer exposes the field; the default wire refusal stands.
        assert.ok(!("allowDshCompaction" in (await cfgJson())), "GET must not expose the removed field");
        let r = await compactionPost();
        assert.equal(r.status, 422, `default must refuse (got ${r.status}: ${r.body})`);
        assert.equal(JSON.parse(r.body).error.code, "dsh_compaction_refused");
        assert.equal(received.length, 0, "refused call never reaches the upstream");

        // B: structured dsh write → loud 400, file untouched, refusal stands.
        r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: true } });
        assert.equal(r.status, 400, r.body);
        assert.match(r.body, /removed/);
        assert.equal(readFileSync(cfgFile, "utf8"), '{"providers":{}}\n', "rejected write must leave the file untouched");
        r = await compactionPost();
        assert.equal(r.status, 422, "nothing can lift the guard any more");
        assert.equal(received.length, 0);

        // C: whole-file save preserves a leftover dsh key verbatim (no
        // relocation any more) — and the key stays inert.
        r = await put(port, "/__bili/config", { file: JSON.stringify({ providers: {}, dsh: { allowDshCompaction: true } }) });
        assert.equal(r.status, 200, r.body);
        assert.deepEqual(JSON.parse(readFileSync(cfgFile, "utf8")).dsh, { allowDshCompaction: true }, "leftover key preserved verbatim");
        r = await compactionPost();
        assert.equal(r.status, 422, "a preserved legacy key must stay inert");
        assert.equal(received.length, 0);

        // D: empty-body validation survives the surface shrink.
        r = await put(port, "/__bili/config", {});
        assert.equal(r.status, 400);
        assert.match(r.body, /expected providers/);
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        await closeServer(bili);
        await closeServer(mock);
        rmrf(root);
    }
});
