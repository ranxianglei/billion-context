// E2E (in-process proxy + mock upstream): proves the full chain — a model
// request binds its session id into the logger (AsyncLocalStorage), the tag
// lands in the log FILE with the stable `[sess=<id>]` grammar, and the web
// endpoint /__bili/logs exposes the discrete / context / time-window views
// plus the unfiltered full-log download over that file.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { log, closeLogger } from "../src/logger.ts";

const SID = "127.0.0.1_weblogsview_testsid";
const NOISE = "synthetic-untagged-noise-between-turns";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LogViewResp {
    path?: string; total?: number; shown?: number; omitted?: number;
    lines?: string[]; isMatch?: boolean[];
}

function okJson(): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
}

test("e2e: session requests are log-tagged; /__bili/logs serves ctx + win views", async () => {
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-weblogs-"));
    const logFile = path.join(dir, "bili.log");

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true, modelContextLimit: 200_000 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        logFile,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": SID };
        for (const turn of ["first-turn", "second-turn"]) {
            const body = JSON.stringify({
                model: "deepseek-v4-flash", max_tokens: 16,
                messages: [{ role: "user", content: `hello ${turn}` }],
            });
            const r = await fetch(url, { method: "POST", headers, body });
            assert.equal(r.status, 200);
            await r.text();
        }
        // Untagged process-level noise BETWEEN the two turns — exactly the
        // kind of line the old substring filter would have dropped forever.
        log("warn", NOISE);

        // Poll until both requests (and the noise line) are durable on disk.
        let txt = "";
        let deadline = Date.now() + 5000;
        for (;;) {
            txt = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
            if (txt.includes(NOISE) && txt.includes(`[sess=${SID}]`)) break;
            if (Date.now() > deadline) throw new Error("timeout waiting for tagged log lines:\n" + txt.slice(-1200));
            await sleep(50);
        }

        const base = `http://127.0.0.1:${proxyPort}/__bili/logs`;
        const qenc = encodeURIComponent(SID);

        // (a) discrete filter: isMatch ⇔ line contains the query.
        const d1 = (await (await fetch(`${base}?q=${qenc}&lines=200`)).json()) as LogViewResp;
        assert.ok(d1.total && d1.total >= 1, "expected at least one tagged line");
        assert.ok(typeof d1.shown === "number" && typeof d1.omitted === "number");
        assert.equal(d1.omitted, 0);
        assert.ok(Array.isArray(d1.isMatch) && d1.isMatch!.length === d1.lines!.length);
        for (let i = 0; i < d1.lines!.length; i++) {
            assert.equal(
                d1.isMatch![i],
                d1.lines![i].toLowerCase().includes(SID.toLowerCase()),
                `isMatch invariant broken at row ${i}: ${d1.lines![i]}`,
            );
        }
        const hits = new Set(d1.lines!.filter((l) => l.toLowerCase().includes(SID.toLowerCase())));

        // (b) ctx expansion: superset of the hits, same invariant.
        const d2 = (await (await fetch(`${base}?q=${qenc}&ctx=2&lines=2000`)).json()) as LogViewResp;
        assert.ok(d2.lines!.length >= d1.lines!.length, "ctx view must be at least as wide as discrete");
        for (const h of hits) assert.ok(d2.lines!.includes(h), `hit lost by ctx view: ${h}`);
        for (let i = 0; i < d2.lines!.length; i++) {
            assert.equal(d2.isMatch![i], d2.lines![i].toLowerCase().includes(SID.toLowerCase()));
        }

        // (c) time window: spans first..last hit → must surface the untagged
        //     noise line; total is query-defined so identical across modes.
        const dW = (await (await fetch(`${base}?q=${qenc}&win=3600&lines=2000`)).json()) as LogViewResp;
        assert.equal(dW.total, d1.total, "total must be mode-independent");
        const noiseRow = dW.lines!.find((l) => l.includes(NOISE) && !l.includes("[sess="));
        assert.ok(noiseRow, `window view lost the interleaved untagged line:\n${dW.lines!.join("\n").slice(-800)}`);
        for (let i = 0; i < dW.lines!.length; i++) {
            assert.equal(dW.isMatch![i], dW.lines![i].toLowerCase().includes(SID.toLowerCase()));
        }

        // (d) raw full download (all=1 bypasses the 2000 cap, ignores q-less filter only).
        const raw = await fetch(`${base}?raw=1&all=1`);
        assert.equal(raw.status, 200);
        assert.match(raw.headers.get("content-type") ?? "", /text\/plain/);
        const rawTxt = await raw.text();
        assert.ok(rawTxt.includes(`[sess=${SID}]`));
        assert.ok(rawTxt.includes(NOISE));
    } finally {
        await closeLogger();
        proxy.closeAllConnections?.();
        upstream.closeAllConnections?.();
        const closedP = new Promise<void>((res) => proxy.once("close", () => res()));
        const closedU = new Promise<void>((res) => upstream.once("close", () => res()));
        proxy.close();
        upstream.close();
        await Promise.race([Promise.all([closedP, closedU]), sleep(2000)]);
    }
});
