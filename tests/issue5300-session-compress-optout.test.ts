// #5300: per-session compression opt-out — POST/GET /__bili/session/<id>/compress
// gates ONE session onto the pipeline's verbatim-forward tail (no fold, no
// nudge, no injection, no preflight, no marker) while every other session on
// the same model keeps compressing. Exact id match only; the flag lives in
// session.metadata so it survives restarts. Both directions asserted (#3617):
// disable AND re-enable, plus the plugin-lane compress-tool refusal.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { peekSession, _resetSessionsForTest } from "../src/session.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

interface Captured {
    url: string;
    body: string;
}

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: Captured[];
    store: SessionStore;
    storeEnabled: boolean;
    close(): Promise<void>;
}

async function startHarness(storeDir?: string): Promise<Harness> {
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl_5300",
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
    // Real file-backed persistence only for the restart-simulation test below.
    const storeEnabled = storeDir !== undefined;
    const store = storeEnabled
        ? new SessionStore({ dir: storeDir, enabled: true, debounceMs: 0 })
        : new SessionStore({ enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress: { injectTool: true, injectNudge: false },
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
        store,
        storeEnabled,
        async close() {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            if (storeEnabled) store.closeQuietly();
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function baseUrl(h: Harness): string {
    return `http://127.0.0.1:${h.proxyPort}`;
}

async function modelRequest(h: Harness, sessionId: string, extraHeaders: Record<string, string> = {}): Promise<number> {
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
    const resp = await fetch(`${baseUrl(h)}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId, ...extraHeaders },
        body,
    });
    await resp.text();
    return resp.status;
}

async function injectedToolNames(h: Harness, index: number): Promise<string[]> {
    const sent = JSON.parse(h.captured[index].body) as { tools?: Array<{ function?: { name?: string } }> };
    return (sent.tools ?? []).map((t) => t.function?.name).filter((n): n is string => typeof n === "string");
}

async function setCompression(h: Harness, id: string, enabled: boolean): Promise<{ status: number; json: { ok: boolean; compression?: { enabled: boolean }; error?: string } }> {
    const resp = await fetch(`${baseUrl(h)}/__bili/session/${encodeURIComponent(id)}/compress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
    return { status: resp.status, json: (await resp.json()) as never };
}

async function getCompression(h: Harness, id: string): Promise<{ status: number; json: { ok: boolean; compression?: { enabled: boolean }; resident?: boolean; error?: string } }> {
    const resp = await fetch(`${baseUrl(h)}/__bili/session/${encodeURIComponent(id)}/compress`);
    return { status: resp.status, json: (await resp.json()) as never };
}

test("#5300: baseline — a non-excluded session rides the pipeline (compress tool injected)", async () => {
    const h = await startHarness();
    try {
        assert.equal(await modelRequest(h, "sess-5300-base"), 200);
        assert.equal(h.captured.length, 1);
        assert.ok((await injectedToolNames(h, 0)).includes("compress"), "unexcluded request rides the pipeline (ACP surface injected)");
    } finally {
        await h.close();
    }
});

test("#5300: disable — the excluded session forwards byte-identical, read-back reports disabled", async () => {
    const h = await startHarness();
    try {
        assert.equal(await modelRequest(h, "sess-5300-excl"), 200);
        assert.ok((await injectedToolNames(h, 0)).includes("compress"), "pre-disable: pipeline active");

        const off = await setCompression(h, "sess-5300-excl", false);
        assert.equal(off.status, 200);
        assert.deepEqual(off.json.compression, { enabled: false });

        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
        const resp = await fetch(`${baseUrl(h)}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sess-5300-excl" },
            body,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(h.captured.length, 2);
        // the point of the feature: NOTHING is rewritten — no injection, no
        // re-serialization, no marker; the bytes out equal the bytes in
        assert.equal(h.captured[1].body, body);

        const got = await getCompression(h, "sess-5300-excl");
        assert.equal(got.status, 200);
        assert.deepEqual(got.json.compression, { enabled: false });
        assert.equal(got.json.resident, true);

        // sibling session on the same model is untouched
        assert.equal(await modelRequest(h, "sess-5300-sibling"), 200);
        assert.ok((await injectedToolNames(h, 2)).includes("compress"), "sibling session keeps compressing");
    } finally {
        await h.close();
    }
});

test("#5300: re-enable — injection returns for the same session (cycle closes both ways)", async () => {
    const h = await startHarness();
    try {
        assert.equal(await modelRequest(h, "sess-5300-cycle"), 200);
        assert.equal((await setCompression(h, "sess-5300-cycle", false)).status, 200);
        const on = await setCompression(h, "sess-5300-cycle", true);
        assert.equal(on.status, 200);
        assert.deepEqual(on.json.compression, { enabled: true });

        assert.equal(await modelRequest(h, "sess-5300-cycle"), 200);
        assert.ok((await injectedToolNames(h, 1)).includes("compress"), "re-enabled session rides the pipeline again");

        const got = await getCompression(h, "sess-5300-cycle");
        assert.deepEqual(got.json.compression, { enabled: true });
    } finally {
        await h.close();
    }
});

test("#5300: unknown session ids — POST and GET both 404 (exact-match discipline)", async () => {
    const h = await startHarness();
    try {
        const post = await setCompression(h, "sess-5300-ghost", false);
        assert.equal(post.status, 404);
        assert.equal(post.json.ok, false);
        const get = await getCompression(h, "sess-5300-ghost");
        assert.equal(get.status, 404);
        assert.equal(get.json.ok, false);
    } finally {
        await h.close();
    }
});

test("#5300: malformed bodies rejected with 400, state untouched", async () => {
    const h = await startHarness();
    try {
        assert.equal(await modelRequest(h, "sess-5300-malformed"), 200);
        const bad = await fetch(`${baseUrl(h)}/__bili/session/sess-5300-malformed/compress`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: "nope" }),
        });
        assert.equal(bad.status, 400);
        (await bad.text());
        const notJson = await fetch(`${baseUrl(h)}/__bili/session/sess-5300-malformed/compress`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "not-json-at-all",
        });
        assert.equal(notJson.status, 400);
        (await notJson.text());
        // the failed writes must not have flipped the flag
        const got = await getCompression(h, "sess-5300-malformed");
        assert.deepEqual(got.json.compression, { enabled: true });
    } finally {
        await h.close();
    }
});

test("#5300: plugin lane — compress tool call refused loudly on an excluded session, not on the control", async () => {
    const h = await startHarness();
    try {
        // bind two plugin-lane sessions (dsh shape: x-bili-plugin + conversation header)
        assert.equal(await modelRequest(h, "conv-5300-excl", { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-5300-excl" }), 200);
        assert.equal(await modelRequest(h, "conv-5300-ctl", { "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-5300-ctl" }), 200);

        assert.equal((await setCompression(h, "conv-5300-excl", false)).status, 200);

        const refused = await fetch(`${baseUrl(h)}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "conv-5300-excl", tool: "compress" }),
        });
        assert.equal(refused.status, 409);
        const rj = (await refused.json()) as { ok: boolean; code?: string; error?: string };
        assert.equal(rj.ok, false);
        assert.equal(rj.code, "COMPRESSION_DISABLED");
        assert.ok(typeof rj.error === "string" && rj.error.length > 0, "refusal carries an actionable error message");

        // negative row: the control session's compress call is NOT our refusal
        const control = await fetch(`${baseUrl(h)}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: "conv-5300-ctl", tool: "compress" }),
        });
        await control.text();
        assert.notEqual(control.status, 409);
    } finally {
        await h.close();
    }
});

test("#5300: the flag survives a restart — persisted with the record, re-armed from disk", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-5300-persist-"));
    try {
        // Phase 1 (live instance): bind the session, disable compression, pin it to disk.
        _resetSessionsForTest();
        const h1 = await startHarness(dir);
        try {
            assert.equal(await modelRequest(h1, "sess-5300-restart"), 200);
            assert.equal((await setCompression(h1, "sess-5300-restart", false)).status, 200);
            const live = peekSession("sess-5300-restart");
            assert.ok(live, "session resident after its first model request");
            await h1.store.writeNow(live);
            const got1 = await getCompression(h1, "sess-5300-restart");
            assert.deepEqual(got1.json.compression, { enabled: false });
            assert.equal(got1.json.resident, true);
        } finally {
            await h1.close();
        }

        // Phase 2 (process-death stand-in): empty resident pool, fresh store over the same dir.
        // The flag must come back THROUGH THE FILE — a serialization change that thins
        // metadata would silently re-enable compression and break both assertions below.
        _resetSessionsForTest();
        const h2 = await startHarness(dir);
        try {
            const got2 = await getCompression(h2, "sess-5300-restart");
            assert.equal(got2.status, 200);
            assert.deepEqual(got2.json.compression, { enabled: false });
            const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
            const resp = await fetch(`${baseUrl(h2)}/bili/http://127.0.0.1:${h2.upstreamPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "sess-5300-restart" },
                body,
            });
            assert.equal(resp.status, 200);
            await resp.text();
            assert.equal(h2.captured[0].body, body, "restarted instance still forwards the excluded session verbatim");
        } finally {
            await h2.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
