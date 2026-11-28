// #7857 review (v0.1.217): the #7398 deferred-parse gate must not break
// conversation identity. For a multi-MiB OpenAI body on the pf handshake the
// full JSON.parse is skipped and `parsed` is synthesized with
// messages = null marker (src/server/fastpath-scan.ts synthesizeTopLevel).
// Without a client conversation header, conversationSignalOpenai
// (kernel/src/wire/openai.ts) falls back to a first-user-message fingerprint —
// which the synthesized body CANNOT produce: it yields hashId("default"), one
// shared key for every such client = cross-conversation compression state
// (a regression vs the legacy full parse, which fingerprinted real content).
// The gate therefore requires a conversation header OR a prompt_cache_key
// (scanned top-level, promoted over the fingerprint by
// preferPromptCacheKeyIdentity); otherwise it keeps the legacy parse.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

// Well above any plausible estimate of a ~1 MiB body so preflight never folds.
const WINDOW = 4_000_000;
const MODEL = "deferred-identity-7857";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

// ~1 MiB+ chat body: first user message carries the conversation's seed
// (the legacy fingerprint seed) plus padding to cross the 1 MiB deferral
// threshold.
function firstUser(seed: string): string { return `seed-${seed} ${"x".repeat(1_050_000)}`; }
function bigBody(seed: string, extra?: Record<string, unknown>): string {
    return JSON.stringify({
        model: MODEL,
        stream: false,
        max_tokens: 4096,
        messages: [
            { role: "user", content: firstUser(seed) },
        ],
        ...extra,
    });
}

function sessionIds(base: string, expectIncludes?: string): Promise<string[]> {
    return fetch(`${base}/__bili/sessions`, { signal: AbortSignal.timeout(10_000) })
        .then((resp) => {
            assert.equal(resp.status, 200);
            return (resp.json()) as Promise<{ sessions?: Array<Record<string, unknown>> }>;
        })
        .then((j) =>
            (j.sessions ?? [])
                .map((s) => String(s.id ?? s.sessionId ?? ""))
                .filter((s) => (expectIncludes ? s.includes(expectIncludes) : s !== "")),
        );
}

// The web list hides empty STUBS (requests<=1 + no context tokens/blocks)
// and the unified index lags the live registry by one debounced flush, so
// poll briefly for the expected shape instead of racing the flush.
async function pollSessionIds(base: string, expectIncludes: string | undefined, want: (ids: string[]) => boolean, label: string): Promise<string[]> {
    for (let i = 0; i < 50; i++) {
        const ids = await sessionIds(base, expectIncludes);
        if (want(ids)) return ids;
        await new Promise((r) => setTimeout(r, 100));
    }
    const final = await sessionIds(base, expectIncludes);
    assert.fail(`${label}: expected session shape not reached (final: ${JSON.stringify(final)})`);
}

test("#7857 deferred-parse gate keeps conversation identity distinct without a header/pck (header/pck lanes still defer safely)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deferred-identity-7857-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    setLogCapture((_lvl, _m) => { /* log capture only; assertions are id-based */ });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            req.on("data", () => undefined);
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: {},
            modelContextLimit: WINDOW, kernelConfig: defaultConfig(WINDOW),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        // pf handshake header (x-bili-pf-count) + openai + >= 1 MiB +
        // pluginFullResendWatermark GA = the deferral gate.
        const post = (body: string, headers: Record<string, string>): Promise<{ status: number; text: string }> =>
            fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-pf-count": "1", ...headers },
                body,
                signal: AbortSignal.timeout(60_000),
            }).then(async (r) => ({ status: r.status, text: await r.text() }));
        const postOk = async (p: Promise<{ status: number; text: string }>, label: string): Promise<void> => {
            const r = await p;
            assert.equal(r.status, 200, `${label} (got ${r.status}: ${r.text.slice(0, 300)})`);
        };

        // 1. Two header-less, pck-less conversations (distinct first-user
        //    messages) must land on DISTINCT session keys. Before the fix
        //    both were hashId("default") — one shared compression state.
        // A small follow-up turn per conversation (BYTE-IDENTICAL first user
        // message, so the fingerprint key matches) keeps both off the
        // empty-stub filter of the web session list.
        const followUpBody = (seed: string, extra?: Record<string, unknown>): string =>
            JSON.stringify({
                model: MODEL, stream: false, max_tokens: 4096,
                messages: [
                    { role: "user", content: firstUser(seed) },
                    { role: "assistant", content: "ok" },
                    { role: "user", content: `again-${seed}` },
                ],
                ...extra,
            });
        await postOk(post(bigBody("alpha"), {}), "alpha turn");
        await postOk(post(followUpBody("alpha"), {}), "alpha follow-up");
        await postOk(post(bigBody("beta"), {}), "beta turn");
        await postOk(post(followUpBody("beta"), {}), "beta follow-up");
        const ids1 = await pollSessionIds(base, undefined, (ids) => ids.length >= 2, "distinct fingerprint conversations");
        assert.ok(ids1.length >= 2, `the two conversations are distinct sessions (got ${ids1.length}: ${JSON.stringify(ids1)})`);

        // 2. The header lane still defers safely: two requests under the same
        //    conversation header share ONE session under its header id.
        await postOk(post(bigBody("gama"), { "x-acp-session": "hdr-conv-1" }), "gama turn");
        await postOk(post(bigBody("gama"), { "x-acp-session": "hdr-conv-1" }), "gama turn 2");
        const hdr = await pollSessionIds(base, "hdr-conv-1", (ids) => ids.includes("hdr-conv-1"), "header conversation");
        assert.ok(hdr.includes("hdr-conv-1"), `header conversation is present under its header id (got ${JSON.stringify(hdr)})`);

        // 3. The pck lane: distinct prompt_cache_keys stay distinct even
        //    without a header (pck promotion keeps the identity safe).
        await postOk(post(bigBody("pck-a", { prompt_cache_key: "pck-conv-a" }), {}), "pck-a turn");
        await postOk(post(followUpBody("pck-a", { prompt_cache_key: "pck-conv-a" }), {}), "pck-a follow-up");
        await postOk(post(bigBody("pck-b", { prompt_cache_key: "pck-conv-b" }), {}), "pck-b turn");
        await postOk(post(followUpBody("pck-b", { prompt_cache_key: "pck-conv-b" }), {}), "pck-b follow-up");
        const all = await pollSessionIds(base, undefined, (ids) => ids.length >= ids1.length + 3, "pck conversations");
        assert.ok(all.length >= ids1.length + 3, `header + two pck conversations each added a distinct session (was ${ids1.length}, now ${all.length}: ${JSON.stringify(all)})`);
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => { if (srv) srv.close(() => r()); else r(); });
        await new Promise<void>((r) => { if (upstream) upstream.close(() => r()); else r(); });
    }
});
