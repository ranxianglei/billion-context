// #4952: ZCode's background project_memory_extract loop copies the parent
// conversation's history, appends temporary tool messages to a local snapshot,
// and reuses the parent's provider/runtime identity — stamping x-session-id =
// the parent's conversation id PLUS an explicit attribution builder
// (x-zcode-query-source: project_memory_extract) and a per-run x-query-id.
//
// Keying that loop onto the parent's verbatim id merges two histories onto ONE
// mutable compression session: the worker overwrites the parent's usage
// baseline / message snapshot / ref allocation / orphan-cleanup counters, and
// when the parent resumes WITHOUT the worker-only messages the worker's blocks
// are orphaned and reaped. The fix splits the worker onto a STABLE per-run
// child lane <parent>|zmem:<query-id>: detection is explicit-attribution-only
// (never prompt wording, never arbitrary "other" requests), the raw parent key
// stays owned by the main session, and upstream cache affinity keeps consuming
// the RAW client-provided value. Same failure domain as the Claude Code
// subagent split (#970/#4769) but on the OpenAI-compatible wire with an
// explicit operation marker instead of a system-text heuristic.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { zcodeMemoryExtractChildKey } from "../src/session-id.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { peekSession, getSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-4o-mini";
const MAIN_SYSTEM = "You are ZCode, a coding assistant for this repository.";

const childKeyOf = (conv: string, qid: string): string => `${conv}|zmem:${qid}`;

// ---- unit: zcodeMemoryExtractChildKey is explicit-attribution-only ----

test("zcodeMemoryExtractChildKey: positive detection needs source + query-id + parent", () => {
    const h = {
        "x-zcode-query-source": "project_memory_extract",
        "x-query-id": "run-abc",
        "x-session-id": "parent-xyz",
    };
    assert.deepEqual(zcodeMemoryExtractChildKey(h), { parent: "parent-xyz", queryId: "run-abc" });
});

test("zcodeMemoryExtractChildKey: x-zcode-session-type is NOT required (source+qid+parent suffice)", () => {
    const h = {
        "x-zcode-query-source": "project_memory_extract",
        "x-query-id": "run-abc",
        "x-session-id": "parent-xyz",
        "x-zcode-session-type": "background",
    };
    assert.deepEqual(zcodeMemoryExtractChildKey(h), { parent: "parent-xyz", queryId: "run-abc" });
});

test("zcodeMemoryExtractChildKey: a different source value is NOT the worker lane (case-sensitive, exact)", () => {
    // Trailing/leading whitespace is trimmed (RFC 7230 OWS) — covered by the
    // "values are trimmed" test below — so only genuinely different values are
    // expected to reject here.
    for (const source of ["other", "title_gen", "PROJECT_MEMORY_EXTRACT", "Project_Memory_Extract", ""]) {
        const h = { "x-zcode-query-source": source, "x-query-id": "q", "x-session-id": "p" };
        assert.equal(zcodeMemoryExtractChildKey(h), undefined, `source=${JSON.stringify(source)}`);
    }
});

test("zcodeMemoryExtractChildKey: missing/empty query-id → no split", () => {
    for (const qid of [undefined, "", "   "]) {
        const h: Record<string, string | string[] | undefined> = {
            "x-zcode-query-source": "project_memory_extract",
            "x-session-id": "p",
        };
        if (qid !== undefined) h["x-query-id"] = qid;
        assert.equal(zcodeMemoryExtractChildKey(h), undefined, `qid=${JSON.stringify(qid)}`);
    }
});

test("zcodeMemoryExtractChildKey: missing client-provided parent id → no split", () => {
    // No x-session-id (or any recognized conversation header) → no way to bind
    // the child to a known parent → status quo preserved.
    assert.equal(zcodeMemoryExtractChildKey({ "x-zcode-query-source": "project_memory_extract", "x-query-id": "q" }), undefined);
    assert.equal(zcodeMemoryExtractChildKey({}), undefined);
});

test("zcodeMemoryExtractChildKey: array-form header is a malformed signal → no split (string-only, like the dsh lane)", () => {
    // Real HTTP delivers these single-valued headers as strings; only set-cookie
    // arrives as an array. An array here is malformed — reject it rather than
    // guess an element (same "array form is not the lane shape" contract as
    // dshPersonaFingerprintApplies).
    assert.equal(zcodeMemoryExtractChildKey({ "x-zcode-query-source": ["project_memory_extract"], "x-query-id": "q", "x-session-id": "p" }), undefined);
    assert.equal(zcodeMemoryExtractChildKey({ "x-zcode-query-source": "project_memory_extract", "x-query-id": ["q"], "x-session-id": "p" }), undefined);
    assert.equal(zcodeMemoryExtractChildKey({ "x-zcode-query-source": "project_memory_extract", "x-query-id": "q", "x-session-id": ["p"] }), undefined);
});

test("zcodeMemoryExtractChildKey: values are trimmed", () => {
    assert.deepEqual(
        zcodeMemoryExtractChildKey({ "x-zcode-query-source": "  project_memory_extract  ", "x-query-id": "  q1  ", "x-session-id": "  p  " }),
        { parent: "p", queryId: "q1" },
    );
});

test("zcodeMemoryExtractChildKey: stable within a run, distinct across runs (never per-request)", () => {
    const base = { "x-zcode-query-source": "project_memory_extract", "x-session-id": "p" };
    const a1 = zcodeMemoryExtractChildKey({ ...base, "x-query-id": "run-1" });
    const a2 = zcodeMemoryExtractChildKey({ ...base, "x-query-id": "run-1" });
    const b = zcodeMemoryExtractChildKey({ ...base, "x-query-id": "run-2" });
    assert.deepEqual(a1, a2, "same query-id → identical child binding (stable identity)");
    assert.notDeepEqual(a1, b, "different query-id → different child binding (separate extraction runs)");
});

// ---- e2e: the worker isolates onto <parent>|zmem:<qid>; main session untouched ----

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; seenUpstreamSessionIds: string[] };

function startRig(): Promise<Rig> {
    const seenUpstreamSessionIds: string[] = [];
    const upstream = http.createServer((req, res) => {
        const sid = req.headers["x-session-id"];
        if (typeof sid === "string") seenUpstreamSessionIds.push(sid);
        else if (Array.isArray(sid) && typeof sid[0] === "string") seenUpstreamSessionIds.push(sid[0]);
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    return new Promise((resolve) => {
        upstream.listen(0, "127.0.0.1", async () => {
            const upstreamPort = (upstream.address() as { port: number }).port;
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
            _resetSessionsForTest();
            _resetPluginStateForTest();
            resetSessionOrderForTest();
            const proxy = await startServer({
                port: 0,
                host: "127.0.0.1",
                upstream: "http://127.0.0.1",
                routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
                modelContextLimit: 200_000,
                kernelConfig: defaultConfig(200_000),
                compress: { injectTool: true, injectNudge: false },
                promptCache: { routing: "auto" },
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
            resolve({ proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream, seenUpstreamSessionIds });
        });
    });
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

// A main-conversation history (system + n alternating turns), each turn large
// enough to be a real message but far below any compression threshold.
const mainMsgs = (n: number): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn-${i + 1}-` + "z".repeat(400),
    }));

// The worker's view = the parent's copied history PLUS temporary tool messages
// (an assistant Read tool_call and its tool result) that exist ONLY in the
// worker's local snapshot.
const workerMsgs = (n: number, marker: string): { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[] => [
    ...mainMsgs(n),
    { role: "assistant", content: null as unknown as string, tool_calls: [{ id: `call_${marker}`, type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "src/main.ts" }) } }] },
    { role: "tool", tool_call_id: `call_${marker}`, name: "Read", content: `// ${marker} file contents\nexport const x = 1;` },
];

const READ_TOOL = { type: "function", function: { name: "Read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } };

test("e2e openai #4952: project_memory_extract worker isolates onto <parent>|zmem:<qid>; main session byte-for-byte untouched", async () => {
    const rig = await startRig();
    const CONV = "zmem-parent";
    const QID = "run-1";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        // Proxy mode: NO x-bili-plugin. The client conversation id rides x-session-id.
        const mainHeaders: Record<string, string> = { "content-type": "application/json", "x-session-id": CONV };
        const workerHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-session-id": CONV,
            "x-zcode-query-source": "project_memory_extract",
            "x-query-id": QID,
        };

        // Phase 1 — main turn claims the RAW key.
        const r1 = await fetch(url, { method: "POST", headers: mainHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(4)] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const main = peekSession(CONV);
        assert.ok(main, "main session exists under the raw conversation key");
        const mainReqBefore = main.stats.requests;
        const mainRefBefore = Object.keys(main.state.messageRefs.byRaw).length;
        assert.ok(mainRefBefore >= 4, "refs assigned to the main history");

        // Phase 2 — worker request: SAME x-session-id + attribution, carrying the
        // parent history copy + two temporary tool messages.
        const r2 = await fetch(url, { method: "POST", headers: workerHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...workerMsgs(4, "w1")] }) });
        assert.equal(r2.status, 200);
        await r2.text();
        const child = peekSession(childKeyOf(CONV, QID));
        assert.ok(child, "worker minted its OWN lane <parent>|zmem:<qid>");
        assert.ok(child.stats.requests >= 1, "worker request counted on its own lane");
        assert.ok(Object.keys(child.state.messageRefs.byRaw).length >= 6, "worker refs (incl. the temp tool round) live on its own lane");

        // THE reap precondition is gone: the main session's request count and ref
        // set are EXACTLY as before the worker ran — none of the worker-only
        // messages ever entered the main ledger, so there is nothing to orphan
        // when the main conversation resumes without them.
        const mainAfterWorker = getSession(CONV);
        assert.equal(mainAfterWorker.stats.requests, mainReqBefore, "main request count UNCHANGED by worker traffic");
        assert.equal(Object.keys(mainAfterWorker.state.messageRefs.byRaw).length, mainRefBefore, "main ref set UNCHANGED — worker temp messages never entered the main ledger");

        // Phase 3 — a second interleaved worker round, SAME run (same query-id):
        // stable child identity, still one lane, main still untouched.
        const r3 = await fetch(url, { method: "POST", headers: workerHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...workerMsgs(4, "w2")] }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.ok(peekSession(childKeyOf(CONV, QID)), "second round of the SAME run lands on the SAME lane (stable per-run identity)");
        assert.equal(getSession(CONV).stats.requests, mainReqBefore, "main request count STILL unchanged after the second worker round");

        // Phase 4 — a SEPARATE extraction run (different query-id) mints a
        // DIFFERENT lane and does not pollute the first run's lane.
        const otherRunHeaders = { ...workerHeaders, "x-query-id": "run-2" };
        const r4 = await fetch(url, { method: "POST", headers: otherRunHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...workerMsgs(4, "w3")] }) });
        assert.equal(r4.status, 200);
        await r4.text();
        const child2 = peekSession(childKeyOf(CONV, "run-2"));
        assert.ok(child2, "a separate extraction run minted its own distinct lane");
        assert.notEqual(child2?.id, child?.id, "different query-id → different session");
        assert.equal(peekSession(childKeyOf(CONV, QID))?.stats.requests, 2, "first run's lane not polluted by the second run");

        // Phase 5 — main conversation RESUMES without the worker-only messages
        // (the incident's trigger): it rides the raw key normally, and because
        // the worker never shared its state there is no orphan-reap surface.
        const r5 = await fetch(url, { method: "POST", headers: mainHeaders, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(4)] }) });
        assert.equal(r5.status, 200);
        await r5.text();
        assert.ok(getSession(CONV).stats.requests > mainReqBefore, "resumed main turn is counted on the main session");
        assert.equal(Object.keys(getSession(CONV).state.messageRefs.byRaw).length, mainRefBefore, "resume added no NEW main refs — worker-only ids were never part of the main ledger");

        // Upstream cache affinity: the internal fork must NEVER leak upstream.
        // The worker forwards the RAW client-provided x-session-id (cache pool
        // continuity), never the internal <parent>|zmem:<qid> child key.
        assert.ok(!rig.seenUpstreamSessionIds.includes(childKeyOf(CONV, QID)), "internal child key was never forwarded upstream");
        assert.ok(rig.seenUpstreamSessionIds.includes(CONV), "raw parent x-session-id kept flowing upstream (affinity unchanged)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e openai #4952 negative control: a request under the parent id WITHOUT attribution stays on the raw key (status quo)", async () => {
    const rig = await startRig();
    const CONV = "zmem-negctl";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        // Carries a query-id-ish header but NOT the project_memory_extract source —
        // detection is explicit-attribution-only, so this must stay verbatim-keyed.
        const headers: Record<string, string> = { "content-type": "application/json", "x-session-id": CONV, "x-zcode-query-source": "other", "x-query-id": "run-x" };
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools: [READ_TOOL], messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(3)] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(peekSession(CONV), "non-worker request resolved onto the raw conversation key");
        assert.equal(peekSession(childKeyOf(CONV, "run-x")), undefined, "NO child lane minted for a non-project_memory_extract request");
    } finally {
        await closeRig(rig);
    }
});

test("e2e openai #4952: explicit attribution outranks the #388 body-shape side heuristic (no-tools low-budget sub-call still forks)", async () => {
    const rig = await startRig();
    const CONV = "zmem-notools";
    const QID = "run-nt";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        // No tools + tiny output budget → isSideRequest() would classify this by
        // BODY SHAPE alone. The explicit project_memory_extract attribution is
        // authoritative lane evidence and must win, so the sub-call lands on the
        // child lane instead of being routed back onto the shared parent state.
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "x-session-id": CONV,
            "x-zcode-query-source": "project_memory_extract",
            "x-query-id": QID,
        };
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64, messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "Summarize the project memory." }] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(peekSession(childKeyOf(CONV, QID)), "no-tools low-budget worker sub-call still minted the child lane (attribution outranks the #388 body-shape heuristic)");
    } finally {
        await closeRig(rig);
    }
});
