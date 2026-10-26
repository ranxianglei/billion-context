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
import { BILI_PLUGIN_BYPASS_HEADER } from "../src/util.ts";
import { rmrf } from "./tmp-rm.ts";

/** #2421: diagnostics.dumpBody wrote dumps/req-*.json only for STRING wire
 *  bodies (`typeof wireBody === "string"` gate in forward()), so every
 *  passthrough/side lane that forwards a Buffer (x-bili-plugin-bypass #920,
 *  #1117 mark, #1284 relay, #1884 escape, final fallback) left only the
 *  raw/-unknown- trace and no structured dump. Buffer bodies whose UTF-8
 *  content is valid JSON must now get the same dumps/ view; non-JSON bodies
 *  stay skipped (the string lane never dumped those either). */

const BODY_MARKER = "dump-buffer-marker-QQQ42";
const NON_JSON_MARKER = "not-json-marker-ZZZ99";

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

function baseOpts(): ProxyOptions {
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

async function startHarness(tmpRoot: string): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts = baseOpts();
    opts.routes = { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

test("#2421: Buffer passthrough lane (x-bili-plugin-bypass) gets a dumps/req-*.json when dumpBody is on", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2421-json-"));
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(tmpRoot);
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                [BILI_PLUGIN_BYPASS_HEADER]: "1",
            },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: BODY_MARKER }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const files = listFiles(path.join(tmpRoot, "billion-context"));
        const jsonDumps = files.filter((f) => /req-\d+-unknown\.json$/.test(f));
        assert.equal(jsonDumps.length, 1, `expected exactly one dumps/req-*-unknown.json for the Buffer passthrough, got: ${files.filter((f) => f.includes("dumps")).join(", ") || "(none)"}`);
        assert.ok(fs.readFileSync(jsonDumps[0], "utf8").includes(BODY_MARKER), "dump should contain the forwarded body");
        // raw/ trace keeps working alongside (same -unknown- session fallback).
        assert.ok(files.some((f) => /-unknown-\d+-REQ\.txt$/.test(f) || /-unknown-REQ\.txt$/.test(f)), `expected a raw/*-unknown-*-REQ.txt trace: ${files.filter((f) => f.includes("raw")).join(", ") || "(none)"}`);
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        rmrf(tmpRoot);
    }
});

test("#2421: non-JSON Buffer body stays skipped by dumps/ (valid-JSON-only contract preserved)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2421-nonjson-"));
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(tmpRoot);
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "text/plain",
                [BILI_PLUGIN_BYPASS_HEADER]: "1",
            },
            body: `plain payload ${NON_JSON_MARKER}`,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const files = listFiles(path.join(tmpRoot, "billion-context"));
        const jsonDumps = files.filter((f) => /req-.*\.json$/.test(f));
        assert.equal(jsonDumps.length, 0, `non-JSON body must not produce a dumps/ entry: ${jsonDumps.join(", ")}`);
        assert.ok(!files.some((f) => fs.readFileSync(f, "utf8").includes(NON_JSON_MARKER) && /req-.*\.json$/.test(f)), "non-JSON body leaked into a dumps/ JSON file");
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        rmrf(tmpRoot);
    }
});
