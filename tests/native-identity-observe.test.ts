import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { closeServers } from "./server-close-guard.ts";
import { NIDV_EXT_KEY, digest8, extractNativeIdentity, observeNativeIdentity, type NativeIdInput } from "../src/server/native-identity.ts";

// #5573 M1 (L1): native-identity observation layer. Unit pins: profile
// fixtures (positive + negative per client), the stability matrix, the
// compaction-prefix adversarial cases, the PII red line (digests only), the
// event FIFO/budget caps, and restart continuity. Hermetic pins: the rollout
// gate (off ⇒ nothing), byte-stable A/B (on ⇒ ZERO diff at the upstream even
// for known clients), the WARN escalation on compaction hits, and the
// decision-independence pin (x-conversation-id alone still resolves via
// prefix affinity until #5526 lands).

// Ext namespaces only exist on the unified store (#2671); the fastpath pf:state
// pattern this module follows reads/writes them there. Pin "full" for the whole
// file so persistence assertions are deterministic (bounded-storage.test.ts pattern).
const prevUnified = process.env.BILI_STORAGE_UNIFIED;
process.env.BILI_STORAGE_UNIFIED = "full";
test.after(() => {
    if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = prevUnified;
});

const WB_HEADERS: Record<string, string> = {
    "x-conversation-id": "conv-wb-1",
    "x-session-id": "acct-1",
    "x-conversation-request-id": "req-7",
    "x-conversation-message-id": "msguuid",
    "x-compaction": "auto",
    "x-context-compacted": "1",
    "x-codebuddy-request": "1",
    "x-ide-name": "WorkBuddy",
    "x-ide-type": "WorkBuddy",
    "x-ide-version": "5.9.3",
};

function tmpStore(): SessionStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nidv-unit-"));
    // enabled (default) is required: the unified sidecar — and with it the ext
    // namespaces this module persists into — only opens for live instances.
    return new SessionStore({ dir: path.join(dir, "sessions") });
}

function runObs(store: SessionStore | null, input: NativeIdInput): { lines: string[]; warns: string[] } {
    const out: { lines: string[]; warns: string[] } = { lines: [], warns: [] };
    observeNativeIdentity(input, store, (l, m) => {
        out.lines.push(m);
        if (l === "warn") out.warns.push(m);
    });
    return out;
}

test("profile wb: full family extracts every field", () => {
    const ex = extractNativeIdentity({ headers: WB_HEADERS });
    assert.equal(ex?.client, "wb");
    assert.equal(ex?.sessH, digest8("conv-wb-1"));
    assert.equal(ex?.turnH, digest8("req-7"));
    assert.equal(ex?.msgidH, digest8("msguuid"));
    assert.equal(ex?.edge, "auto");
    assert.equal(ex?.level, true);
    assert.ok(ex?.noteParts.some((p) => p === "fp:x-ide-version=5.9.3"));
});

test("no identity evidence → null (unclassified traffic is not recorded)", () => {
    assert.equal(extractNativeIdentity({ headers: {} }), null);
    assert.equal(extractNativeIdentity({ headers: { "content-type": "application/json", "user-agent": "curl/8" } }), null);
});

test("array-valued and empty headers count as absent", () => {
    assert.equal(
        extractNativeIdentity({ headers: { "x-conversation-id": ["a", "b"], "x-request-id": "   " } }),
        null,
    );
});

test("profile codex: installation-id match, body signals, rotation, preface in USER element", () => {
    const body = JSON.stringify({
        model: "gpt-x",
        previous_response_id: "rs_abc123",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "Another language model started to solve this problem. Its work follows." }] },
            { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
            { id: "ctc_1", type: "function_call", name: "f", call_id: "call_1", arguments: "{}" },
        ],
    });
    const ex = extractNativeIdentity({
        headers: { "x-codex-installation-id": "inst-42", "session-id": "sess-cx" },
        body,
        protocol: "responses",
        path: "/v1/responses",
    });
    assert.equal(ex?.client, "codex");
    assert.equal(ex?.sessH, digest8("sess-cx"));
    assert.equal(ex?.prevRespH, digest8("rs_abc123"));
    const counts = Object.fromEntries((ex?.counts ?? []).map((c) => [c.label, c.n]));
    assert.equal(counts["msg_"], 1);
    assert.equal(counts["ctc_"], 1);
    assert.equal(ex?.prefix?.role, "user");
    assert.equal(ex?.prefix?.elemIdx, 1);
    const r = runObs(tmpStore(), { headers: { "x-codex-installation-id": "inst-42", "session-id": "sess-cx" }, body, protocol: "responses" });
    assert.ok(r.warns.length >= 1, "preface in a user element escalates to WARN");
    assert.ok(r.lines[0].includes("evt=compaction(preface@elem1)"));
});

test("profile codex adversarial: preface inside an ASSISTANT element is NOT a compaction event", () => {
    const body = JSON.stringify({
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Quoting the transcript: Another language model started to solve this problem ..." }] },
        ],
    });
    const ex = extractNativeIdentity({ headers: { "x-codex-installation-id": "i" }, body, protocol: "responses" });
    assert.equal(ex?.prefix?.role, "assistant");
    const r = runObs(null, { headers: { "x-codex-installation-id": "i" }, body, protocol: "responses" });
    assert.ok(r.warns.length === 0, "mid-history assistant occurrence must not fire the incident class");
    assert.ok(r.lines[0].includes("prefix@elem2/assistant"), "recorded as an honest observation instead");
});

test("profile codex secondary match: request-id ∧ responses protocol; wrong protocol stays unclassified", () => {
    const ex = extractNativeIdentity({ headers: { "x-client-request-id": "r-9" }, protocol: "responses" });
    assert.equal(ex?.client, "codex");
    assert.equal(extractNativeIdentity({ headers: { "x-client-request-id": "r-9" }, protocol: "openai" }), null);
});

test("profile cc: dual-channel cross-check ok / mismatch / malformed-swallowed", () => {
    const hdrs = { "x-claude-code-session-id": "cc-sess-1" };
    const ok = extractNativeIdentity({ headers: hdrs, body: '{"metadata":{"user_id":{"session_id":"cc-sess-1"}},"messages":[{"role":"user","content":"hi"}]}' });
    assert.equal(ok?.dual, "ok");
    const bad = extractNativeIdentity({ headers: hdrs, body: '{"metadata":{"user_id":{"session_id":"cc-OTHER"}},"messages":[]}' });
    assert.equal(bad?.dual, "mismatch");
    const rBad = runObs(null, { headers: hdrs, body: '{"metadata":{"user_id":{"session_id":"cc-OTHER"}},"messages":[]}' });
    assert.ok(rBad.warns.some((w) => w.includes("dual_mismatch")));
    // Malformed metadata shapes degrade to "absent" — swallowed, never a crash, never a false mismatch.
    for (const mal of ['{"metadata":"garbage","messages":[]}', '{"metadata":{"user_id":123},"messages":[]}', '{"messages":[]}']) {
        const m = extractNativeIdentity({ headers: hdrs, body: mal });
        assert.equal(m?.dual, "absent", mal);
        assert.equal(runObs(null, { headers: hdrs, body: mal }).warns.length, 0, mal);
    }
});

test("profile opencode: ses_ shape gate, assertive zero-counts, drift event, fork marker", () => {
    const clean = extractNativeIdentity({ headers: { "x-session-affinity": "ses_abc" }, body: '{"messages":[{"role":"user","content":"hi"}]}' });
    assert.equal(clean?.client, "opencode");
    assert.equal(clean?.sessH, digest8("ses_abc"));
    assert.deepEqual(clean?.counts.map((c) => c.n), [0, 0, 0]);
    assert.equal(runObs(null, { headers: { "x-session-affinity": "ses_abc" }, body: '{"messages":[{"role":"user","content":"hi"}]}' }).warns.length, 0);
    // Shape gate: a non-ses_ affinity value matches the profile but yields NO session id.
    const shaped = extractNativeIdentity({ headers: { "x-session-affinity": "not-ses" } });
    assert.equal(shaped?.client, "opencode");
    assert.equal(shaped?.sessH, undefined);
    // Wire-shape drift: any prt_/ses_/msg_ token on the outbound wire is an anomaly.
    const drifted = runObs(null, { headers: { "x-session-affinity": "ses_abc" }, body: '{"messages":[{"role":"user","content":"see prt_123"}]}' });
    assert.ok(drifted.warns.some((w) => w.includes("shape_assert_fail(prt_=1)")));
    // Fork marker.
    const forked = runObs(null, { headers: { "x-session-affinity": "ses_child", "x-parent-session-id": "ses_parent" } });
    assert.ok(forked.lines[0].includes("fork=yes"));
    assert.ok(forked.lines[0].includes("evt=fork(parent-sess)"));
});

test("profile gemini: protocol-only match + state-snapshot preface", () => {
    const body = '{"contents":[{"role":"user","parts":[{"text":"<state_snapshot>\\nwhat we know so far"}]}]}';
    const ex = extractNativeIdentity({ headers: {}, body, protocol: "google" });
    assert.equal(ex?.client, "gemini");
    assert.equal(ex?.prefix?.role, "user");
    assert.equal(runObs(null, { headers: {}, body, protocol: "google" }).warns.length, 1);
});

test("plugin lane: agent stamp labels the client, msgIds envelope drives the stats", () => {
    const store = tmpStore();
    const first = runObs(store, { key: "lane-conv-1", headers: {}, agent: "dsh", msgIds: ["m1", "m2", "m1"] });
    assert.ok(first.lines[0].startsWith("nidv: client=dsh "));
    assert.ok(first.lines[0].includes("msgΔ=+3"));
    const second = runObs(store, { key: "lane-conv-1", headers: {}, agent: "dsh", msgIds: ["m2", "m3"] });
    assert.ok(second.lines[0].includes("msgΔ=+2"));
    const rec = JSON.parse(String(store.getSessionExt("lane-conv-1", NIDV_EXT_KEY))) as { ids: { msg?: { n: number; distinct: number; stable: string } } };
    assert.equal(rec.ids.msg?.n, 5);
    assert.equal(rec.ids.msg?.distinct, 3);
    assert.equal(rec.ids.msg?.stable, "yes", "m2 repeated across turns = host reuses ids (retry-stable evidence)");
});

test("stability matrix: session repeat→yes, change→no + id_change, restart continuity", () => {
    const store = tmpStore();
    const base = { key: "fixed", headers: { "x-conversation-id": "conv-A" } };
    runObs(store, base);
    let rec = JSON.parse(String(store.getSessionExt("fixed", NIDV_EXT_KEY))) as { ids: { sess?: { h: string; stable: string } } };
    assert.equal(rec.ids.sess?.stable, "unknown", "first sighting is undecided");
    runObs(store, base);
    rec = JSON.parse(String(store.getSessionExt("fixed", NIDV_EXT_KEY))) as typeof rec;
    assert.equal(rec.ids.sess?.stable, "yes");
    const r = runObs(store, { key: "fixed", headers: { "x-conversation-id": "conv-B" } });
    assert.ok(r.lines[0].includes("id_change(sess)"));
    rec = JSON.parse(String(store.getSessionExt("fixed", NIDV_EXT_KEY))) as typeof rec;
    assert.equal(rec.ids.sess?.stable, "no");
    assert.equal(rec.ids.sess?.h, digest8("conv-B"));
    // Restart continuity: a preloaded prior record continues seamlessly.
    const store2 = tmpStore();
    const prior = {
        v: 1, client: "wb", firstSeen: 1000, lastSeen: 2000, reqs: 5,
        ids: { sess: { h: digest8("conv-A"), stable: "unknown" as const } }, events: [],
    };
    store2.setSessionExt("fixed", NIDV_EXT_KEY, JSON.stringify(prior));
    runObs(store2, base);
    const cont = JSON.parse(String(store2.getSessionExt("fixed", NIDV_EXT_KEY))) as { firstSeen: number; reqs: number; ids: { sess?: { stable: string } } };
    assert.equal(cont.firstSeen, 1000, "firstSeen survives the restart");
    assert.equal(cont.reqs, 6);
    assert.equal(cont.ids.sess?.stable, "yes");
});

test("msg stability: ≥8 all-distinct turns → no", () => {
    const store = tmpStore();
    for (let i = 0; i < 9; i += 1) {
        runObs(store, { key: "fixed", headers: {}, agent: "dsh", msgIds: [`id-${String(i)}`] });
    }
    const rec = JSON.parse(String(store.getSessionExt("fixed", NIDV_EXT_KEY))) as { ids: { msg?: { n: number; stable: string } } };
    assert.equal(rec.ids.msg?.n, 9);
    assert.equal(rec.ids.msg?.stable, "no");
});

test("profile_flip event + FIFO cap + 4KB budget", () => {
    const store = tmpStore();
    for (let i = 0; i < 40; i += 1) {
        runObs(store, { key: "fixed", headers: {}, agent: i % 2 === 0 ? "dsh" : "omp", msgIds: [`flip-${String(i)}`] });
    }
    const raw = String(store.getSessionExt("fixed", NIDV_EXT_KEY));
    assert.ok(raw.length <= 4096, `ext record fits the budget (${raw.length})`);
    const rec = JSON.parse(raw) as { events: { k: string }[]; client: string };
    assert.ok(rec.events.length <= 32);
    assert.ok(rec.events.some((e) => e.k === "profile_flip"));
    assert.equal(rec.client, "omp");
});

test("PII red line: raw id values never persist or log — sha1-8 digests only", () => {
    const store = tmpStore();
    const r = runObs(store, { headers: WB_HEADERS, body: '{"messages":[{"role":"user","content":"hello"}]}' });
    const raw = String(store.getSessionExt(`n:${digest8("conv-wb-1")}`, NIDV_EXT_KEY));
    for (const secret of ["conv-wb-1", "msguuid", "req-7", "acct-1"]) {
        assert.ok(!raw.includes(secret), `ext must not contain ${secret}`);
        assert.ok(!r.lines[0].includes(secret), `log line must not contain ${secret}`);
    }
    assert.ok(r.lines[0].includes(`${digest8("conv-wb-1")}\u2026`), "line carries the digest + ellipsis form");
    assert.ok(raw.includes(digest8("conv-wb-1")), "ext carries the digest");
});

test("explicit legacy storage opt-out degrades to log-line-only (no crash, no record)", () => {
    // Absent env resolves to "full" (#3818), so the legacy path needs the
    // explicit spelling.
    const saved = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    try {
        const dir = mkdtempSync(path.join(os.tmpdir(), "nidv-legacy-"));
        const legacyStore = new SessionStore({ dir: path.join(dir, "sessions") });
        assert.equal(legacyStore.replicasAvailable(), false);
        const r = runObs(legacyStore, { headers: WB_HEADERS });
        assert.equal(r.lines.length, 1, "observation still logs");
        assert.ok(r.lines[0].startsWith("nidv: client=wb "), r.lines[0]);
        let threw = false;
        try {
            legacyStore.getSessionExt(`n:${digest8("conv-wb-1")}`, NIDV_EXT_KEY);
        } catch {
            threw = true;
        }
        assert.equal(threw, true, "legacy-only ext access still fails fast — the module must never have reached it");
    } finally {
        if (saved === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = saved;
    }
});

interface Capture { raw: string; headerKeys: string[] }

function makeUpstream(sink: Capture[]) {
    return http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            sink.push({ raw: data, headerKeys: Object.keys(req.headers).map((k) => k.toLowerCase()) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 1, model: "model-test",
                choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
            }));
        });
    });
}

async function makeHarness(tag: string) {
    _resetStoreForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    const root = mkdtempSync(path.join(os.tmpdir(), `natid-${tag}-`));
    for (const k of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[k] = root;
    const store = new SessionStore({ dir: path.join(root, "sessions") });
    _setStoreForTest(store);
    const captured: Capture[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uaddr = upstream.address();
    assert(uaddr && typeof uaddr === "object");
    const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true, debug: true, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    return { root, store, captured, upstream, proxy, origin: `http://127.0.0.1:${paddr.port}` };
}

async function postChat(origin: string, headers: Record<string, string>): Promise<void> {
    const body = JSON.stringify({
        model: "model-test", max_tokens: 64, stream: false,
        messages: [
            { role: "system", content: "You are TestBuddy." },
            { role: "user", content: "hello" },
        ],
    });
    const res = await fetch(origin + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
    });
    assert.equal(res.status, 200);
    await res.text();
}

test("rollout gate OFF (default): zero nidv output, zero wire diff", async () => {
    const h = await makeHarness("off");
    const lines: string[] = [];
    setLogCapture((_l, m) => lines.push(m));
    try {
        await postChat(h.origin, { "x-acp-session": "s-bare" });
        await postChat(h.origin, { "x-acp-session": "s-wb", ...WB_HEADERS });
        assert.equal(h.captured.length, 2);
        assert.equal(h.captured[1].raw, h.captured[0].raw, "wire bytes identical");
        assert.equal(lines.filter((l) => l.startsWith("nidv:")).length, 0, "feature off ⇒ no observation output");
        assert.equal(h.store.getSessionExt(`n:${digest8("conv-wb-1")}`, NIDV_EXT_KEY), undefined);
    } finally {
        setLogCapture(null);
        await closeServers([h.proxy, h.upstream], "natid-off");
    }
});

test("rollout gate ON: byte-stable for known clients, WARN on compaction hit, ext record written", async () => {
    const ENV = "BILI_ROLLOUT_NATIVE_IDENTITY_OBSERVATION";
    const saved = process.env[ENV];
    process.env[ENV] = "1";
    const h = await makeHarness("on");
    const lines: string[] = [];
    const warns: string[] = [];
    setLogCapture((l, m) => {
        lines.push(m);
        if (l === "warn") warns.push(m);
    });
    try {
        await postChat(h.origin, { "x-acp-session": "s-bare" });
        await postChat(h.origin, { "x-acp-session": "s-wb", ...WB_HEADERS });
        assert.equal(h.captured.length, 2);
        assert.equal(h.captured[1].raw, h.captured[0].raw, "ZERO diff at the upstream even for a known client");
        const nidv = lines.filter((l) => l.startsWith("nidv:"));
        assert.equal(nidv.length, 1, "only the WorkBuddy request is classified; the bare one stays silent");
        assert.ok(nidv[0].includes("client=wb"), nidv[0]);
        assert.ok(nidv[0].includes(`${digest8("conv-wb-1")}\u2026`), nidv[0]);
        assert.ok(nidv[0].includes("evt=compaction(hdr=auto)"), nidv[0]);
        assert.ok(warns.includes(nidv[0]), "compaction hit escalates the line to WARN");
        const rec = JSON.parse(String(h.store.getSessionExt(`n:${digest8("conv-wb-1")}`, NIDV_EXT_KEY))) as { v: number; client: string; reqs: number };
        assert.equal(rec.v, 1);
        assert.equal(rec.client, "wb");
        assert.equal(rec.reqs, 1);
    } finally {
        setLogCapture(null);
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        await closeServers([h.proxy, h.upstream], "natid-on");
    }
});

test("decision independence: x-conversation-id alone is observed but NOT an identity source pre-#5526", async () => {
    const ENV = "BILI_ROLLOUT_NATIVE_IDENTITY_OBSERVATION";
    const saved = process.env[ENV];
    process.env[ENV] = "1";
    const h = await makeHarness("decis");
    const lines: string[] = [];
    setLogCapture((_l, m) => lines.push(m));
    try {
        await postChat(h.origin, { "x-conversation-id": "conv-only-1" });
        assert.ok(lines.some((l) => l.startsWith("nidv:") && l.includes(`${digest8("conv-only-1")}\u2026`)), "family was observed");
        assert.ok(lines.some((l) => /\[prefix-affinity\] new session pfa-/.test(l)), "identity resolved via prefix affinity, not via the observed header");
    } finally {
        setLogCapture(null);
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
        await closeServers([h.proxy, h.upstream], "natid-decis");
    }
});

test("latency smoke: 1MB codex-shaped body, extraction p99 stays cheap (CI-portable bound)", async () => {
    const item = { id: "msg_lat", type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(200) }] };
    const itemCount = Math.ceil(1_000_000 / Buffer.byteLength(JSON.stringify(item)));
    const bigBody = JSON.stringify({
        model: "gpt-x",
        previous_response_id: "rs_big",
        input: Array.from({ length: itemCount }, () => item),
    });
    assert.ok(Buffer.byteLength(bigBody) >= 1_000_000);
    const input: NativeIdInput = {
        headers: { "x-codex-installation-id": "inst", "session-id": "sess-lat" },
        body: bigBody,
        protocol: "responses",
    };
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
        const t0 = process.hrtime.bigint();
        extractNativeIdentity(input);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.min(samples.length - 1, Math.ceil(0.99 * samples.length) - 1)];
    console.log(`[nidv latency smoke] 1MB body p99=${p99.toFixed(3)}ms median=${samples[samples.length >> 1].toFixed(3)}ms`);
    assert.ok(p99 < 20, `p99 ${p99.toFixed(3)}ms exceeds the CI-portable bound (guards against accidental parse-class regressions; local dog-machine numbers land in the PR description)`);
});
