import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { coreToGoogle, type BiliMessage } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import type { WireProtocol } from "../src/util.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import {
    renderChainCheckpoint,
    extractChainCarriers,
    insertCheckpointCarrier,
    computeRequestDigest,
    evaluateChain,
    stampOutbound,
} from "../src/chain-checkpoint.ts";

/** #1421 (step 3 of #1395): generation + enforcement. Pins the three per-wire
 *  stamp shapes the owner approved (google merge mandatory / anthropic merge /
 *  openai+responses append), the must-fail case (the pre-fix google append
 *  shape dies inside bili's OWN pipeline via coreToGoogle's alternation
 *  fusion), the round-trip invariant on every wire × trailing shape, and the
 *  enforcement behavior through a real proxy (valid/recent-mismatch/stale-
 *  matched forward verbatim; stale-unmatched strips + processes; every
 *  processed outbound leaves a self-verifying stamp; kill switch off). */

const L = "\x3c";
const R = "\x3e";
const T0 = 1_758_864_000_000;
const MIN = 60 * 1000;
const GOOD_DIGEST = "sha256:" + "ab".repeat(32);
const FIELDS = { v: 1, processor: "bili-a", issuedAt: T0, requestId: "req-1" };

function tag(over: Partial<typeof FIELDS> & { digest?: string } = {}): string {
    return renderChainCheckpoint({ ...FIELDS, digest: GOOD_DIGEST, ...over });
}

// ---------- stamp shapes (#1421 owner decision) ----------

test("stamp shape: anthropic merges into the trailing user message (never a second user entry)", () => {
    const t = tag();
    const s = insertCheckpointCarrier({ model: "m", messages: [{ role: "user", content: "hi" }] }, "anthropic", t)! as { messages: unknown[] };
    assert.deepEqual(s.messages[0], { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: t }] });
    const mp = insertCheckpointCarrier({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "ok" }] }] }, "anthropic", t)! as { messages: unknown[] };
    assert.deepEqual(mp.messages[0], { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "ok" }, { type: "text", text: t }] });
    const af = insertCheckpointCarrier({ model: "m", messages: [{ role: "assistant", content: "done" }] }, "anthropic", t)! as { messages: unknown[] };
    assert.equal(af.messages.length, 2);
    assert.deepEqual(af.messages[1], { role: "user", content: t });
});

test("stamp shape: google merges into the last content's parts (append breaks our own pipeline)", () => {
    const t = tag();
    const g = insertCheckpointCarrier({ contents: [{ role: "user", parts: [{ text: "hi" }, { text: "there" }] }] }, "google", t)! as { contents: unknown[] };
    assert.deepEqual(g.contents[0], { role: "user", parts: [{ text: "hi" }, { text: "there" }, { text: t }] });
    const gp = insertCheckpointCarrier({ contents: [{ role: "user" }] }, "google", t)! as { contents: unknown[] };
    assert.deepEqual(gp.contents[0], { role: "user", parts: [{ text: t }] });
    const gn = insertCheckpointCarrier({ contents: [{ parts: [{ text: "q" }] }] }, "google", t)! as { contents: unknown[] };
    assert.equal(gn.contents.length, 1);
    assert.deepEqual(gn.contents[0], { parts: [{ text: "q" }, { text: t }] });
    const gm = insertCheckpointCarrier({ contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ text: "a" }] }] }, "google", t)! as { contents: unknown[] };
    assert.equal(gm.contents.length, 3);
    assert.deepEqual(gm.contents[2], { role: "user", parts: [{ text: t }] });
});

test("stamp shape: openai/responses keep the standalone trailing user entry", () => {
    const t = tag();
    const o = insertCheckpointCarrier({ model: "m", messages: [{ role: "user", content: "hi" }] }, "openai", t)! as { messages: unknown[] };
    assert.equal(o.messages.length, 2);
    assert.deepEqual(o.messages[1], { role: "user", content: t });
    const r = insertCheckpointCarrier({ model: "m", input: [{ type: "message", role: "user", content: "hi" }, { type: "compaction_trigger" }] }, "responses", t)! as { input: unknown[] };
    assert.equal(r.input.length, 3);
    assert.deepEqual(r.input[1], { type: "message", role: "user", content: t });
    assert.deepEqual(r.input[2], { type: "compaction_trigger" });
});

test("restamp replaces the trailing carrier instead of stacking (all wires)", () => {
    const t1 = tag();
    const t2 = tag({ processor: "bili-b", requestId: "req-2" });
    const bases: [WireProtocol, unknown][] = [
        ["openai", { model: "m", messages: [{ role: "user", content: "hi" }] }],
        ["anthropic", { model: "m", messages: [{ role: "user", content: "hi" }] }],
        ["responses", { model: "m", input: [{ type: "message", role: "user", content: "hi" }] }],
        ["google", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
    ];
    for (const [wire, base] of bases) {
        const onceStamped = insertCheckpointCarrier(base, wire, t1)!;
        const twice = insertCheckpointCarrier(onceStamped, wire, t2)!;
        const cands = extractChainCarriers(twice, wire).candidates;
        assert.equal(cands.length, 1, `${wire}: restamp must not stack`);
        assert.equal(cands[0]!.processor, "bili-b");
    }
});

// ---------- recognition relaxation ----------

test("recognition: anthropic last-part / google any-part are carriers; mid-position and extra-key parts are not", () => {
    const t = tag();
    let f = extractChainCarriers({ model: "m", messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: t }] }] }, "anthropic");
    assert.equal(f.candidates.length, 1);
    assert.deepEqual(f.stripped, { model: "m", messages: [{ role: "user", content: [{ type: "image", source: {} }] }] });
    f = extractChainCarriers({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: t }, { type: "text", text: "x" }] }] }, "anthropic");
    assert.equal(f.candidates.length, 0, "anthropic: a MID-array tag part is not a carrier");
    f = extractChainCarriers({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: t, cache_control: { type: "ephemeral" } }] }] }, "anthropic");
    assert.equal(f.candidates.length, 0, "anthropic: extra keys on the part disqualify");
    f = extractChainCarriers({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: t }, { type: "text", text: "x" }] }] }, "openai");
    assert.equal(f.candidates.length, 0, "openai stays whole-content: multi-block is never a carrier");
    f = extractChainCarriers({ contents: [{ role: "user", parts: [{ text: t }, { text: "x" }] }] }, "google");
    assert.equal(f.candidates.length, 1);
    assert.deepEqual(f.stripped, { contents: [{ role: "user", parts: [{ text: "x" }] }] });
    f = extractChainCarriers({ contents: [{ role: "user", parts: [{ text: "x" }, { text: t }] }] }, "google");
    assert.equal(f.candidates.length, 1, "google: position within parts is irrelevant");
    f = extractChainCarriers({ contents: [{ role: "user", parts: [{ text: t }] }] }, "google");
    assert.equal(f.candidates.length, 1);
    assert.deepEqual(f.stripped, { contents: [] }, "emptied content entry is dropped");
    f = extractChainCarriers({ contents: [{ role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: t }] }] }, "google");
    assert.equal(f.candidates.length, 1);
    assert.deepEqual(f.stripped, { contents: [{ role: "model", parts: [{ text: "a" }] }] });
    f = extractChainCarriers({ contents: [{ role: "user", parts: [{ text: t, thoughtSignature: "s" }] }] }, "google");
    assert.equal(f.candidates.length, 0, "google: extra field on the part disqualifies");
    f = extractChainCarriers({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: L + "bili-chain broken" + R }] }] }, "anthropic");
    assert.equal(f.malformed, 1);
});

// ---------- must-fail: the pre-fix shape inside our own pipeline ----------

test("must-fail: the pre-#1421 google append shape loses the carrier through bili's own coreToGoogle", () => {
    // bili rebuilds google bodies via coreToGoogle on every processed request;
    // it enforces Gemini's strict alternation by FUSING consecutive same-side
    // runs into one content. A standalone appended user content (the old stamp
    // shape) therefore arrives fused into the preceding user content's parts —
    // where the step-2 whole-part rule (exactly one plain-text part) cannot see it.
    const q = "what is up";
    const t = tag();
    const fused = coreToGoogle([
        { id: "m1", role: "user", contentType: "text", text: q },
        { id: "m2", role: "user", contentType: "text", text: t },
    ] as BiliMessage[]);
    assert.deepEqual(fused, [{ role: "user", parts: [{ text: q }, { text: t }] }], "kernel fuses the same-side run");
    const wholePartOnly = (fused as { role?: string; parts: unknown[] }[])
        .filter((c) => c.role === "user" && Array.isArray(c.parts) && c.parts.length === 1 && Object.keys(c.parts[0] as object).length === 1)
        .length;
    assert.equal(wholePartOnly, 0, "the step-2 whole-part rule would have lost the checkpoint here");
    assert.equal(extractChainCarriers({ contents: fused }, "google").candidates.length, 1, "the #1421 any-part rule recovers it");
});

test("must-fail twin: hop-2 nudge merge pushes the google tag off the end — any-part still recognizes", () => {
    const stamped = insertCheckpointCarrier({ contents: [{ role: "user", parts: [{ text: "q" }] }] }, "google", tag())! as { contents: { role?: string; parts: { text: string }[] }[] };
    const last = stamped.contents[stamped.contents.length - 1]!;
    if ((last.role ?? "user") !== "model") last.parts.push({ text: "nudge-text" });
    assert.equal(extractChainCarriers(stamped, "google").candidates.length, 1, "tag survives the nudge merge");
});

// ---------- round-trip invariant ----------

test("round-trip: stampOutbound → evaluateChain verdict=valid on every wire × trailing shape", () => {
    const bases: [WireProtocol, unknown][] = [
        ["openai", { model: "m", messages: [{ role: "user", content: "hi" }] }],
        ["openai", { model: "m", messages: [{ role: "assistant", content: "a" }, { role: "user", content: [{ type: "text", text: "hi" }] }] }],
        ["anthropic", { model: "m", messages: [{ role: "user", content: "hi" }] }],
        ["anthropic", { model: "m", messages: [{ role: "assistant", content: "a" }] }],
        ["anthropic", { model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }] }],
        ["responses", { model: "m", input: "hi" }],
        ["responses", { model: "m", input: [{ type: "message", role: "user", content: "hi" }] }],
        ["responses", { model: "m", input: [{ type: "message", role: "user", content: "hi" }, { type: "compaction_trigger" }] }],
        ["google", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }],
        ["google", { contents: [{ role: "user", parts: [{ text: "hi" }, { text: "more" }] }] }],
        ["google", { contents: [{ role: "model", parts: [{ text: "a" }] }] }],
    ];
    for (const [wire, base] of bases) {
        const stamped = stampOutbound(base, wire, "proc-1", T0 + MIN)!;
        assert.ok(stamped, `${wire}: stamp produced a body`);
        const ctx = evaluateChain(stamped, wire, { nowMs: T0 + 2 * MIN });
        assert.equal(ctx.verdict, "valid", `${wire} ${JSON.stringify(base)}`);
        assert.equal(ctx.selectedMatched, true);
        assert.equal(ctx.selected!.requestId.length, 8);
        assert.equal(ctx.selected!.digest, computeRequestDigest(stamped, wire), `${wire}: embedded digest verifies against the stamped body`);
        const twice = stampOutbound(stamped, wire, "proc-1", T0 + 2 * MIN)!;
        const ctx2 = evaluateChain(twice, wire, { nowMs: T0 + 3 * MIN });
        assert.equal(ctx2.verdict, "valid", `${wire} restamp`);
        assert.equal(extractChainCarriers(twice, wire).candidates.length, 1, `${wire}: restamp must not stack`);
        assert.equal(ctx2.selected!.digest, ctx.selected!.digest, `${wire}: digest stable across restamp`);
    }
});

// ---------- integration: real proxy enforcement ----------

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string, overrides: Partial<ProxyOptions> = {}): ProxyOptions {
    return {
        port,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
        ...overrides,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            if ((req.url ?? "").includes(":generateContent")) {
                res.end(JSON.stringify({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

interface Rig {
    port: number;
    logs: { level: string; msg: string }[];
    captured: Captured[];
}

async function withRig(fn: (rig: Rig) => Promise<void>, overrides: Partial<ProxyOptions> = {}): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const srv = await startServer(makeOpts(0, llmUrl, overrides));
    await listen(srv);
    try {
        await fn({ port: (srv.address() as { port: number }).port, logs, captured });
    } finally {
        setLogCapture(null);
        srv.closeAllConnections?.();
        await close(srv);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
}

const BASE_BODY = {
    model: MODEL,
    stream: false,
    messages: [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: "hello world" },
    ],
};

test("#1421 E1: valid checkpoint → forwarded byte-identical, pipeline skipped", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const sentJson = JSON.stringify(stampOutbound(BASE_BODY, "openai", "upstream-bili", Date.now() - 5_000)!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-valid" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const chainLogs = logs.filter((l) => l.msg.includes("[chain]"));
        assert.equal(chainLogs.length, 1, JSON.stringify(chainLogs));
        assert.equal(chainLogs[0]!.level, "info");
        assert.ok(chainLogs[0]!.msg.includes("verdict=valid"));
        assert.ok(chainLogs[0]!.msg.includes("forwarding verbatim"));
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, sentJson, "byte-identical verbatim forward");
        assert.ok(!captured[0]!.body.includes('"compress"'), "nothing injected");
    });
});

test("#1421 E2: recent-mismatch → interop: forwarded byte-identical + warn", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const stamped = stampOutbound(BASE_BODY, "openai", "other-bili", Date.now() - 5_000)!;
        const sentJson = JSON.stringify(stamped).replace(/sha256:[0-9a-f]{64}/, "sha256:" + "cd".repeat(32));
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-mismatch" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const chainLogs = logs.filter((l) => l.msg.includes("[chain]"));
        assert.equal(chainLogs.length, 1, JSON.stringify(chainLogs));
        assert.equal(chainLogs[0]!.level, "warn");
        assert.ok(chainLogs[0]!.msg.includes("verdict=recent-mismatch"));
        assert.ok(chainLogs[0]!.msg.includes("forwarding verbatim"));
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, sentJson, "byte-identical interop forward");
    });
});

test("#1421 E3: stale-unmatched → stripped, processed normally, re-stamped on egress", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const staleTagged = insertCheckpointCarrier(BASE_BODY, "openai", renderChainCheckpoint({ v: 1, processor: "old-bili", issuedAt: Date.now() - 11 * MIN, requestId: "r-old", digest: "sha256:" + "cd".repeat(32) }))!;
        const sentJson = JSON.stringify(staleTagged);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-stale" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const chainLogs = logs.filter((l) => l.msg.includes("[chain]"));
        assert.equal(chainLogs.length, 1, JSON.stringify(chainLogs));
        assert.ok(chainLogs[0]!.msg.includes("verdict=stale"), chainLogs[0]!.msg);
        assert.ok(chainLogs[0]!.msg.includes("processing normally"));
        assert.equal(captured.length, 1);
        assert.ok(captured[0]!.body.includes('"compress"'), "processed normally");
        const outParsed = JSON.parse(captured[0]!.body);
        const outCtx = evaluateChain(outParsed, "openai");
        assert.equal(outCtx.verdict, "valid", "outbound carries this instance's fresh self-verifying stamp");
        assert.notEqual(outCtx.selected?.processor, "old-bili");
        assert.equal(extractChainCarriers(outParsed, "openai").candidates.length, 1, "stale carrier stripped, not stacked");
    });
});

test("#1421 E4: plain request → processed AND outbound carries a self-verifying stamp", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const sentJson = JSON.stringify(BASE_BODY);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-plain" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(logs.filter((l) => l.msg.includes("[chain]")).length, 0, "no inbound checkpoint, no [chain] log");
        assert.equal(captured.length, 1);
        assert.ok(captured[0]!.body.includes('"compress"'));
        assert.ok(captured[0]!.body.includes(L + "bili-chain "), "outbound stamped");
        const outParsed = JSON.parse(captured[0]!.body);
        const outCtx = evaluateChain(outParsed, "openai");
        assert.equal(outCtx.verdict, "valid", "self-verifying stamp");
        assert.equal(outCtx.selected?.digest, computeRequestDigest(outParsed, "openai"));
    });
});

test("#1421 E5: kill switch disables both enforcement and outbound stamping", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const sentJson = JSON.stringify(stampOutbound(BASE_BODY, "openai", "upstream-bili", Date.now() - 5_000)!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-off" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(logs.filter((l) => l.msg.includes("[chain]")).length, 0, "no detection at all");
        assert.equal(captured.length, 1);
        assert.ok(captured[0]!.body.includes('"compress"'), "still processes despite the valid checkpoint");
        assert.ok(captured[0]!.body.split(L + "bili-chain ").length - 1 <= 1, "no fresh outbound stamp added");
    }, { chainContentDetection: false });
});

test("#1421 E7: side request (max_tokens<=200) bypasses the kernel and is NOT stamped", async () => {
    await withRig(async ({ port, captured }) => {
        const sentJson = JSON.stringify({ model: MODEL, max_tokens: 100, stream: false, messages: [{ role: "user", content: "title me" }] });
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-side" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.ok(!captured[0]!.body.includes(L + "bili-chain "), "no kernel pass → no processing claim");
    });
});

test("#1421 E6: google wire — plain request leaves a MERGED stamp (one user content); valid checkpoint forwards byte-identical", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const url = `http://127.0.0.1:${port}/v1beta/models/gemini-test:generateContent`;
        const gBody = { contents: [{ role: "user", parts: [{ text: "hello world" }] }] };
        const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-google" },
            body: JSON.stringify(gBody),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        const out = JSON.parse(captured[0]!.body) as { contents: { role?: string; parts: { text: string }[] }[] };
        assert.equal(out.contents.length, 1, "no appended second user content (alternation-safe merged stamp)");
        assert.equal(out.contents[0]!.role, "user");
        const parts = out.contents[0]!.parts;
        const tagParts = parts.filter((p) => typeof p.text === "string" && p.text.startsWith(L + "bili-chain "));
        assert.equal(tagParts.length, 1);
        assert.equal(parts[parts.length - 1].text, tagParts[0]!.text, "tag is the trailing part of the single user content");
        assert.equal(evaluateChain(out, "google").verdict, "valid");

        const sent2 = JSON.stringify(stampOutbound(gBody, "google", "upstream-bili", Date.now() - 5_000)!);
        const resp2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step3-google2" },
            body: sent2,
        });
        assert.equal(resp2.status, 200);
        await resp2.text();
        assert.equal(captured.length, 2);
        assert.equal(captured[1]!.body, sent2, "byte-identical verbatim forward");
        assert.ok(logs.some((l) => l.level === "info" && l.msg.includes("verdict=valid")));
    });
});
