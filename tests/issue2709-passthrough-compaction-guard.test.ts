// #2709: the passthrough lane (x-bili-passthrough, #1117) relays byte-untouched
// with "no session, no injection, no guard" — which made it the one lane dsh's
// agentless background compaction could still LAND through: the takeover gate
// refuses attribution for agentless callers while the settings overlay has
// already routed the URL to /bili/, so the native patch stamps the request and
// it relays verbatim BELOW the #1835 pipeline guard (field report on the
// anthropic lane: 49 compaction starts, 45 refused through the pipeline,
// 4 landed through this lane, each landing destroying the compression
// substrate and later tripping #1001 as "unannounced").
//
// These tests pin the lane-local guard added for #2709:
//   1. marker-shaped passthrough POST → 422 refusal, upstream receives nothing;
//   2. ordinary passthrough POST (title-gen shape, marker string only mentioned
//      mid-text) → byte-identical verbatim relay (no false positive);
//   3. gzip-encoded marker body → still refused (decode-then-sniff path);
//   4. legacy allowDshCompaction opt-in (file/env) → STILL refused (#3666 removed it);
//   5. unparseable body → verbatim relay (fail-open);
//   6. GET passthrough (e.g. /models) → untouched (method gate).
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX, dshPassthroughGuardStats } from "../src/server/dsh-compaction-guard.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const INSTRUCTION = DSH_COMPACTION_INSTRUCTION_PREFIX +
    " Summarize the conversation so far, retaining key decisions and open tasks.";

interface Captured {
    url: string;
    body: string;
    method: string;
}

async function startHarness(): Promise<{ proxyPort: number; upstreamPort: number; captured: Captured[]; close(): Promise<void> }> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8"), method: req.method ?? "" });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl_2709",
                object: "chat.completion",
                created: 1,
                model: "gpt-test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session",
        log: false,
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as AddressInfo).port,
        upstreamPort,
        captured,
        async close() {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function compactionBody(): string {
    // rc.2 shape: full-region replay with the instruction as the FINAL user
    // message (#2193 — message count must not gate detection).
    const filler = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `earlier turn ${i} of the shadowed region` }));
    return JSON.stringify({ model: "gpt-test", messages: [...filler, { role: "user", content: INSTRUCTION }] });
}

test("#2709: passthrough compaction call is refused 422, never forwarded", async () => {
    const before = dshPassthroughGuardStats.refusals;
    const h = await startHarness();
    try {
        const body = compactionBody();
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body,
        });
        assert.equal(resp.status, 422);
        const text = await resp.text();
        assert.match(text, /dsh_compaction_refused/);
        // the refusal must state the unconditional contract like the pipeline guard (#3666)
        assert.match(text, /unconditional/);
        // upstream saw NOTHING — the call must not land
        assert.equal(h.captured.length, 0);
        // process-level count (no session ledger on this lane)
        assert.equal(dshPassthroughGuardStats.refusals, before + 1);
    } finally {
        await h.close();
    }
});

test("#2709: ordinary passthrough traffic relays byte-identical (no false positive, marker mentioned mid-text)", async () => {
    const h = await startHarness();
    try {
        const body = JSON.stringify({ model: "gpt-test", max_tokens: 64, messages: [
            { role: "user", content: "Generate a short title for this conversation" },
            { role: "assistant", content: `fun fact: the string "${DSH_COMPACTION_INSTRUCTION_PREFIX.slice(0, 20)}..." appears in our docs` },
        ] });
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body,
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1);
        assert.equal(h.captured[0].body, body);
    } finally {
        await h.close();
    }
});

test("#2709: gzip-encoded compaction body is still refused (decode path)", async () => {
    const h = await startHarness();
    try {
        const gz = gzipSync(Buffer.from(compactionBody(), "utf8"));
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "content-encoding": "gzip", "x-bili-passthrough": "1" },
            body: gz,
        });
        assert.equal(resp.status, 422);
        assert.equal(h.captured.length, 0);
    } finally {
        await h.close();
    }
});

test("#2709/#3666: the removed allowDshCompaction opt-in no longer relays (legacy env ignored)", async () => {
    process.env.BILI_ALLOW_DSH_COMPACTION = "1";
    try {
        const h = await startHarness();
        try {
            const body = compactionBody();
            const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
                body,
            });
            assert.equal(resp.status, 422, "legacy env opt-in is ignored — refusal stands");
            assert.equal(h.captured.length, 0, "still nothing reaches upstream");
        } finally {
            await h.close();
        }
    } finally {
        delete process.env.BILI_ALLOW_DSH_COMPACTION;
    }
});

test("#2709: unparseable passthrough body relays verbatim (fail-open)", async () => {
    const h = await startHarness();
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-passthrough": "1" },
            body: `not-json but contains ${DSH_COMPACTION_INSTRUCTION_PREFIX.slice(0, 48)} raw`,
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1);
    } finally {
        await h.close();
    }
});

test("#2709: GET passthrough is untouched (method gate)", async () => {
    const h = await startHarness();
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/models`, {
            method: "GET",
            headers: { "x-bili-passthrough": "1" },
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1);
        assert.equal(h.captured[0].method, "GET");
    } finally {
        await h.close();
    }
});
