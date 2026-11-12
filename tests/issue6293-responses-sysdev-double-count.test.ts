import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { responsesToCore } from "acp-kernel/wire";
import { estimateWireOverhead } from "../src/server/budget.ts";
import { estimateCoreMessages } from "../src/preflight.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// #6293: estimateWireOverhead walked EVERY role=system/developer item in the
// Responses input[] (and every system message in the OpenAI messages[]), but
// the kernel projections hoist only the LEADING run out of the counted core
// view — mid-history sys/dev items land in projection.msgs (#4166) and are
// billed by estimateCoreMessages. core + overhead therefore carried the same
// bytes twice; on cold-start requests with no usage baseline the inflated
// sum tripped spurious preflight compression on payloads that fit the window.
//
// Fix: the overhead side counts EXACTLY the projection's hoisted set
// (responsesToCore().systemParts / openaiToCore().systemText) — one codec,
// one definition of what leaves the core view. Projection failure keeps the
// legacy all-sys/dev walk (fail-closed overcount: the call sites degrade to
// an empty core on the same failure, so nothing goes unbilled).
//
// Pins below: mid-history mass excluded from overhead (positive direction),
// head/instructions mass STILL counted (#829 guard, negative direction),
// projection-failure fallback intact, and the end-to-end trigger: a fitting
// cold-start request must forward in ONE upstream call with its history
// untouched.
process.env.NODE_ENV = "test";
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-r6293-"));
test.after(() => rmrf(testRoot));

const NO_TOOLS = defaultCountTokens(JSON.stringify([])); // "[]" — the zero-tools term

test("#6293: responses mid-history sys/dev stays out of overhead; head + instructions stay in", () => {
    const H = "head developer prompt ".repeat(500);      // leading run → systemParts
    const M = "mid-history developer notice ".repeat(2000); // mid-history → core (#4166)
    const U = "user question ".repeat(400);
    const A = "assistant answer ".repeat(400);
    const U2 = "follow-up question ";
    const body = JSON.stringify({
        input: [
            { role: "developer", content: H },
            { role: "user", content: U },
            { role: "assistant", content: A },
            { role: "developer", content: M },
            { role: "user", content: U2 },
        ],
    });
    const oh = estimateWireOverhead("responses", body);
    // Exactly the hoisted run — NOT H+M. Pre-fix this was tokens(H) + tokens(M).
    assert.equal(oh, defaultCountTokens(H) + NO_TOOLS, `overhead must carry only the leading sys/dev run (got ${oh})`);
    // The mid-history mass lives in the core view, so the union bills it once.
    const core = estimateCoreMessages(responsesToCore(JSON.parse(body)).msgs);
    assert.ok(core >= defaultCountTokens(M), `mid-history sys/dev must be billed by the core side (core=${core}, M=${defaultCountTokens(M)})`);
});

test("#6293: responses instructions + leading developer together, mid excluded (#829 kept)", () => {
    const I = "top-level instructions ".repeat(500);
    const H = "leading developer block ".repeat(500);
    const M = "positioned reminder ".repeat(1500);
    const body = JSON.stringify({
        instructions: I,
        input: [
            { role: "developer", content: H },
            { role: "user", content: "q" },
            { role: "developer", content: M },
        ],
    });
    const oh = estimateWireOverhead("responses", body);
    // systemParts = [instructions, leading dev], joined "\n" by the estimator.
    assert.equal(oh, defaultCountTokens(`${I}\n${H}`) + NO_TOOLS, `instructions + head dev counted once each (got ${oh})`);
});

test("#6293: responses string input + instructions unchanged", () => {
    const I = "instructions payload ".repeat(300);
    const oh = estimateWireOverhead("responses", JSON.stringify({ instructions: I, input: "just a string" }));
    assert.equal(oh, defaultCountTokens(I) + NO_TOOLS, `string-input shortcut keeps counting instructions (got ${oh})`);
});

test("#6293: responses projection failure → legacy all-sys/dev walk (fail-closed, no crash)", () => {
    const M = "fallback reminder ".repeat(800);
    // A null item makes responsesToCore throw (normalizeEasyInputItem reads
    // item.type); the legacy walk must still bill the developer item. Pre-fix
    // code crashed here outright (null.role in the filter).
    const body = JSON.stringify({ input: [null, { role: "developer", content: M }] });
    const oh = estimateWireOverhead("responses", body);
    assert.equal(oh, defaultCountTokens(M) + NO_TOOLS, `fallback walk bills the sys/dev item (got ${oh})`);
});

test("#6293: openai mid-history system stays out of overhead; leading prefix stays in", () => {
    const S = "leading system prompt ".repeat(500);
    const M = "mid-history system note ".repeat(2000);
    const body = JSON.stringify({
        messages: [
            { role: "system", content: S },
            { role: "user", content: "u".repeat(1600) },
            { role: "assistant", content: "a".repeat(1600) },
            { role: "system", content: M },
            { role: "user", content: "v" },
        ],
    });
    const oh = estimateWireOverhead("openai", body);
    assert.equal(oh, defaultCountTokens(S) + NO_TOOLS, `only the leading contiguous prefix is overhead (got ${oh})`);
});

test("#6293: openai top-level system field AND leading message both counted", () => {
    const T = "top-level system field ".repeat(300);
    const S = "leading system message ".repeat(300);
    const body = JSON.stringify({ system: T, messages: [{ role: "system", content: S }, { role: "user", content: "u" }] });
    const oh = estimateWireOverhead("openai", body);
    assert.equal(oh, defaultCountTokens(`${T}\n${S}`) + NO_TOOLS, `both shapes summed (got ${oh})`);
});

test("#6293: openai structured-content leading system now counted (was silently dropped)", () => {
    const P = "structured system part ".repeat(400);
    const body = JSON.stringify({
        messages: [
            { role: "system", content: [{ type: "text", text: P }] },
            { role: "user", content: "u" },
        ],
    });
    const oh = estimateWireOverhead("openai", body);
    assert.equal(oh, defaultCountTokens(P) + NO_TOOLS, `projected stringContent covers parts (got ${oh})`);
});

// ---------------------------------------------------------------------------
// End-to-end: the user-visible symptom — a cold-start Responses request whose
// TRUE size fits the window must not trip preflight compression because the
// estimator double-billed its mid-history developer item. Sized against the
// session's actual judging limit (reservedContextLimit) read live after a
// warm-up turn, so the fixture discriminates regardless of headroom defaults.
// ---------------------------------------------------------------------------

type Item = Record<string, unknown>;

async function closeServer(srv?: http.Server): Promise<void> {
    if (!srv) return;
    srv.close();
    srv.closeIdleConnections?.();
    await once(srv, "close").catch(() => {});
}

interface Harness {
    url: string;
    upstreamCalls: { count(): number };
    getLastInput: () => Item[] | string | undefined;
    close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    let seq = 0;
    const calls: number[] = [];
    let lastInput: Item[] | string | undefined;
    upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Item;
            lastInput = Array.isArray(body.input) ? body.input : typeof body.input === "string" ? body.input : undefined;
            calls.push(++seq);
            const completed: Item = {
                id: `resp_${seq}`,
                object: "response",
                status: "completed",
                model: "gpt-test",
                output: [{
                    id: `msg_o_${seq}`,
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [{ type: "output_text", text: `ok ${seq}` }],
                }],
            };
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: completed.id, object: "response", status: "in_progress", output: [] } })}\n\n`);
            res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const options: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    proxy = await startServer(options);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
        upstreamCalls: { count: () => calls.length },
        getLastInput: () => lastInput,
        close: async () => {
            await closeServer(proxy);
            await closeServer(upstream);
        },
    };
}

// Plugin-mode headers (x-bili-plugin): the report's environment is a DSH
// native plugin host, and plugin mode suppresses bili's tool/nudge injection
// (KDD #7) — closest faithful shape of the field repro.
async function postTurn(url: string, conv: string, input: Item[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "omp-plugin/0.0.1",
            "x-bili-plugin-conversation": conv,
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input }),
    });
    const raw = await res.text();
    assert.ok(res.ok, `request failed HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return raw;
}

// Same wire shape, no ok-assertion — for turns where a preflight refusal is a
// LEGITIMATE outcome (the control below).
async function postTurnRaw(url: string, conv: string, input: Item[]): Promise<{ ok: boolean; status: number; raw: string }> {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "omp-plugin/0.0.1",
            "x-bili-plugin-conversation": conv,
        },
        body: JSON.stringify({ model: "gpt-test", stream: true, input }),
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, raw };
}

function findSession(conv: string) {
    const sess = listSessions().find((s) => s.id === conv || s.id.startsWith(`${conv}|`));
    assert.ok(sess, `session for conversation ${conv} not found (have: ${listSessions().map((s) => s.id).join(", ")})`);
    return sess;
}

async function coldStartConv(h: Harness, conv: string): Promise<number> {
    // Warm-up turn: establishes the session and its judging limit
    // (window − output-headroom reservation). The fake upstream reports no
    // usage, so later turns are judged purely on local estimates — exactly
    // the cold-start regime of the report (no usage baseline yet).
    await postTurn(h.url, conv, [{ role: "user", content: "warmup" }]);
    const limit = findSession(conv).metadata.reservedContextLimit;
    assert.ok(typeof limit === "number" && limit > 0, `judging limit must be known (got ${String(limit)})`);
    return limit;
}

test("#6293: fitting cold-start request forwards once — no spurious preflight compression", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "e2e-"));
    try {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
        _resetSessionsForTest();
        setRegistryForTest({});
        _setStoreForTest(new SessionStore({ enabled: false }));

        const h = await startHarness();
        const conv = "conv-6293-e2e";
        try {
            const L = await coldStartConv(h, conv);

            // ASCII so defaultCountTokens is chars/4. Sizes relative to the
            // live judging limit: the FIXED total (core already carries the
            // mid-history mass; overhead adds only the hoisted head) sits
            // under the limit with room for bili's own standing outbound
            // additions; the LEGACY double-counted total (head + mid mass in
            // BOTH terms) sits far over it — the fixture discriminates.
            const H = "head developer prompt ".repeat(Math.ceil(L * 0.05 * 4 / 24));
            const M = "mid-history developer notice ".repeat(Math.ceil(L * 0.45 * 4 / 30));
            const U = "user context paragraph ".repeat(Math.ceil(L * 0.17 * 4 / 24));
            const A = "assistant context paragraph ".repeat(Math.ceil(L * 0.17 * 4 / 28));
            const U2 = "next question please continue ";
            const input: Item[] = [
                { role: "developer", content: H },
                { role: "user", content: U },
                { role: "assistant", content: A },
                { role: "developer", content: M },
                { role: "user", content: U2 },
            ];
            const bodyObj = { model: "gpt-test", stream: true, input };
            const coreTok = estimateCoreMessages(responsesToCore(bodyObj as never).msgs);
            const fixedEst = coreTok + estimateWireOverhead("responses", bodyObj);
            const legacyEst = coreTok + defaultCountTokens(`${H}\n${M}`) + NO_TOOLS;
            assert.ok(fixedEst < L * 0.9, `fixture must fit under the judging limit after the fix (est=${fixedEst}, limit=${L})`);
            assert.ok(legacyEst > L * 1.1, `fixture must have tripped the pre-fix double-counted estimate (legacy=${legacyEst}, limit=${L})`);

            const before = h.upstreamCalls.count();
            const raw = await postTurn(h.url, conv, input);
            assert.ok(raw.includes("data:"), `not an SSE reply: ${raw.slice(0, 120)}`);
            assert.equal(h.upstreamCalls.count() - before, 1, `exactly ONE upstream call for the big turn — preflight must not fire (calls=${h.upstreamCalls.count() - before})`);
            const sent = h.getLastInput();
            assert.ok(Array.isArray(sent), `upstream saw the array input (got ${typeof sent})`);
            assert.equal((sent as Item[]).length, input.length, `history forwarded intact — nothing folded (sent ${(sent as Item[]).length}, expected ${input.length})`);
            assert.equal((sent as Item[])[3]?.role, "developer", "mid-history developer item preserved at position");
            // The proxy stamps re-sent history with an ACP tag line (KDD #2) —
            // strip that single prefix line, then the item text must be M verbatim.
            const sent3 = (sent as Item[])[3]?.content as string;
            const stripped = sent3.replace(
                /^\x3cacp tokens="[^"]*" type="[^"]*" time="[^"]*"\x3em\d+\x3c\/acp\x3e\n/,
                "",
            );
            assert.equal(stripped, M, "mid-history developer item text byte-intact (minus the ACP tag line)");
        } finally {
            await h.close();
        }
    } finally {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        rmrf(root);
    }
});

// Control: proves the preflight trigger path is ALIVE in this harness shape —
// a genuinely over-window cold-start request DOES fold (extra upstream calls
// for the summary rounds) before forwarding. Without this, the single-call
// assertion above could pass vacuously if some gate skipped preflight outright.
test("#6293 control: an over-window cold-start request still triggers preflight compression", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "control-"));
    try {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
        _resetSessionsForTest();
        setRegistryForTest({});
        _setStoreForTest(new SessionStore({ enabled: false }));

        const h = await startHarness();
        const conv = "conv-6293-control";
        try {
            const L = await coldStartConv(h, conv);
            // Six foldable user/assistant pairs at ~15% of the limit each —
            // ~180% of the window in pure conversation text, no sys/dev mass:
            // its TRUE size is over-window even after the fix, so preflight
            // MUST engage. Engagement shows up as either summary round(s) plus
            // forward (≥2 upstream calls, HTTP 200) or a preflight refusal
            // (413/502). A silent passthrough — exactly ONE call and HTTP 200
            // — would mean some gate skipped preflight outright and the main
            // test above proves nothing.
            const P = 0.15 * L * 4;
            const pairs: Item[] = [];
            for (let i = 0; i < 6; i++) {
                pairs.push({ role: "user", content: `user paragraph ${i} `.repeat(Math.ceil(P / 18)) });
                pairs.push({ role: "assistant", content: `assistant paragraph ${i} `.repeat(Math.ceil(P / 22)) });
            }
            const before = h.upstreamCalls.count();
            const turn = await postTurnRaw(h.url, conv, pairs);
            const delta = h.upstreamCalls.count() - before;
            const engaged = delta >= 2 || !turn.ok;
            assert.ok(engaged, `preflight must engage on a genuinely over-window payload (upstream calls=${delta}, HTTP ${turn.status}) — got a single-call passthrough`);
            if (!turn.ok) {
                assert.ok(turn.status === 413 || turn.status === 502, `a refused over-window turn must be a preflight refusal, got HTTP ${turn.status}: ${turn.raw.slice(0, 200)}`);
            } else {
                assert.ok(delta >= 2, `an accepted over-window turn must have folded first (upstream calls=${delta}: summary round(s) + forward)`);
            }
        } finally {
            await h.close();
        }
    } finally {
        for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) delete process.env[key];
        rmrf(root);
    }
});
