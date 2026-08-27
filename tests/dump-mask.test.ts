import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/** #276 (Part B of #255): body dumps (dumps/req-*.json, raw/*-REQ.txt,
 *  raw/*-RES.txt, raw/*-INCOMING.txt) write the full plaintext request body and
 *  must (a) be OFF by default even under --debug, and (b) when enabled via
 *  ACP_DUMP_BODY=1, carry no credentials (authorization/x-api-key/cookie) and
 *  no non-public host (private relay / self-hosted / 127.0.0.1). */

const SECRET_BEARER = "sk-dump-bearer-AAA111";
const SECRET_APIKEY = "sk-dump-apikey-BBB222";
const SECRET_COOKIE = "dump-cookie-CCC333";
const BODY_MARKER = "dump-body-marker-XYZ789";

const DUMP_FILE_RE = /req-.*\.json$|-(REQ|RES|INCOMING)\.txt$/;

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(p));
        else out.push(p);
    }
    return out;
}

function baseOpts(debug: boolean): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

interface Env {
    xdg: string | undefined;
    body: string | undefined;
}

function saveEnv(): Env {
    return { xdg: process.env.XDG_STATE_HOME, body: process.env.ACP_DUMP_BODY };
}

function restoreEnv(prev: Env): void {
    if (prev.xdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.xdg;
    if (prev.body === undefined) delete process.env.ACP_DUMP_BODY;
    else process.env.ACP_DUMP_BODY = prev.body;
}

async function startHarness(debug: boolean, tmpRoot: string): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `session=${SECRET_COOKIE}` });
        res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts = baseOpts(debug);
    opts.routes = { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

async function sendRequest(proxyPort: number, upstreamPort: number): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-acp-session": "dump-mask-1",
            authorization: `Bearer ${SECRET_BEARER}`,
            "x-api-key": SECRET_APIKEY,
            cookie: `session=${SECRET_COOKIE}`,
        },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: BODY_MARKER }] }),
    });
    assert.equal(resp.status, 200);
    await resp.text();
}

test("body dumps are OFF by default even with --debug (#276)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dump-off-"));
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    delete process.env.ACP_DUMP_BODY;
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(true, tmpRoot);
        await sendRequest(h.proxyPort, h.upstreamPort);
        const dumpFiles = listFiles(path.join(tmpRoot, "billion-context")).filter((f) => DUMP_FILE_RE.test(f));
        assert.equal(dumpFiles.length, 0, `expected no body dumps by default, got: ${dumpFiles.join(", ")}`);
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("ACP_DUMP_BODY=1: dumps written, no credentials, no non-public host (#276)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dump-on-"));
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(true, tmpRoot);
        await sendRequest(h.proxyPort, h.upstreamPort);
        const files = listFiles(path.join(tmpRoot, "billion-context"));
        const dumpFiles = files.filter((f) => DUMP_FILE_RE.test(f));
        assert.ok(dumpFiles.some((f) => /req-.*\.json$/.test(f)), `missing req-*.json dump: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /-REQ\.txt$/.test(f)), `missing *-REQ.txt dump: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /-RES\.txt$/.test(f)), `missing *-RES.txt dump: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /-INCOMING\.txt$/.test(f)), `missing *-INCOMING.txt dump: ${dumpFiles.join(", ")}`);

        const all = dumpFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
        assert.ok(!all.includes(SECRET_BEARER), `bearer token leaked into dump:\n${all}`);
        assert.ok(!all.includes(SECRET_APIKEY), `x-api-key leaked into dump:\n${all}`);
        assert.ok(!all.includes(SECRET_COOKIE), `cookie value leaked into dump:\n${all}`);
        assert.ok(!all.includes(`127.0.0.1:${h.upstreamPort}`), `non-public upstream host leaked into dump:\n${all}`);
        assert.ok(!all.includes(`127.0.0.1:${h.proxyPort}`), `non-public proxy host leaked into dump:\n${all}`);
        assert.ok(all.includes("<private-host>"), `expected <private-host> placeholder in dumps:\n${all}`);

        const reqJson = dumpFiles.filter((f) => /req-.*\.json$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
        assert.ok(reqJson.includes(BODY_MARKER), "req JSON dump should still contain the request body");
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("ACP_DUMP_BODY=1 works without --debug (dumps decoupled from verbose logging) (#276)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dump-nodebug-"));
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(false, tmpRoot);
        await sendRequest(h.proxyPort, h.upstreamPort);
        const dumpFiles = listFiles(path.join(tmpRoot, "billion-context")).filter((f) => DUMP_FILE_RE.test(f));
        assert.ok(dumpFiles.some((f) => /-REQ\.txt$/.test(f)), `raw REQ dump missing without --debug: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /-RES\.txt$/.test(f)), `raw RES dump missing without --debug: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /-INCOMING\.txt$/.test(f)), `INCOMING dump missing without --debug: ${dumpFiles.join(", ")}`);
        assert.ok(dumpFiles.some((f) => /req-.*\.json$/.test(f)), `req JSON dump missing without --debug: ${dumpFiles.join(", ")}`);
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
