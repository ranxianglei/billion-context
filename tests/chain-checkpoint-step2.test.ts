import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import {
    DEFAULT_MAX_FUTURE_SKEW_MS,
    DEFAULT_RECENT_CHECKPOINT_WINDOW_MS,
    computeCheckpointDigest,
    computeRequestDigest,
    evaluateChain,
    extractChainCarriers,
    insertCheckpointCarrier,
    jcsStringify,
    parseChainCheckpoint,
    renderChainCheckpoint,
    type ChainCheckpoint,
} from "../src/chain-checkpoint.ts";

// #1395 step 2: chain-checkpoint recognition (parser, per-wire carrier
// contract, JCS digest, shadow verdicts). Synthetic fixtures first; the three
// integration tests prove ZERO forwarding behavior change through a real proxy.

const L = "\x3c";
const R = "\x3e";
const T0 = 1_758_864_000_000;
const MIN = 60 * 1000;

const GOOD_DIGEST = "sha256:" + "ab".repeat(32);
const FIELDS: Pick<ChainCheckpoint, "v" | "processor" | "issuedAt" | "requestId"> = {
    v: 1,
    processor: "bili-a",
    issuedAt: T0,
    requestId: "req-1",
};
const tag = (over: Partial<ChainCheckpoint> = {}): string =>
    renderChainCheckpoint({ ...FIELDS, digest: GOOD_DIGEST, ...over });

test("parser: accepts canonical + reordered attrs, rejects every malformed shape", () => {
    assert.deepEqual(parseChainCheckpoint(tag()), { v: 1, processor: "bili-a", issuedAt: T0, requestId: "req-1", digest: GOOD_DIGEST });
    assert.ok(parseChainCheckpoint(`${L}bili-chain digest="${GOOD_DIGEST}" request-id="r" issued-at="${T0}" processor="p" v="1"/${R}`), "attr order is irrelevant");
    assert.equal(parseChainCheckpoint(tag({ digest: undefined }) ?? "", "x") ?? null, null);
    const noDigest = tag().replace(` digest="${GOOD_DIGEST}"`, "");
    assert.equal(parseChainCheckpoint(noDigest), null, "missing attr");
    assert.equal(parseChainCheckpoint(tag().replace("/" + R, ` v="1"/${R}`)), null, "duplicate attr");
    assert.equal(parseChainCheckpoint(tag().replace("/" + R, ` extra="x"/${R}`)), null, "unknown attr");
    assert.equal(parseChainCheckpoint(tag({ digest: "sha256:" + "AB".repeat(32) })), null, "uppercase hex rejected");
    assert.equal(parseChainCheckpoint(tag({ digest: "md5:" + "ab".repeat(16) })), null, "wrong algorithm prefix");
    assert.equal(parseChainCheckpoint(tag({ digest: "sha256:" + "a".repeat(63) })), null, "wrong digest length");
    assert.equal(parseChainCheckpoint(tag({ v: 0 })), null, "v=0");
    assert.equal(parseChainCheckpoint(tag({ v: -1 })), null, "negative v");
    assert.equal(parseChainCheckpoint(tag({ issuedAt: NaN })), null, "non-numeric issued-at");
    assert.equal(parseChainCheckpoint(tag({ processor: 'a"b' })), null, "embedded quote");
    assert.equal(parseChainCheckpoint(tag() + "\nmore"), null, "trailing newline");
    assert.equal(parseChainCheckpoint(" " + tag()), null, "leading space");
    assert.equal(parseChainCheckpoint(tag().slice(0, -1)), null, "missing close");
    assert.equal(parseChainCheckpoint(L + "bili-chain v=\"1\" " + "x".repeat(600) + R), null, "length cap");
    assert.equal(parseChainCheckpoint(42), null);
    assert.equal(parseChainCheckpoint(null), null);
    assert.equal(parseChainCheckpoint(undefined), null);
});

test("jcs: key-order invariant, array order preserved, RFC 8785 number/string forms, code-point key sort", () => {
    assert.equal(
        jcsStringify(JSON.parse('{"a":1,"b":{"d":2,"c":[3,1]}}')),
        jcsStringify(JSON.parse('{"b":{"c":[3,1],"d":2},"a":1}')),
        "key order must not matter (nested)",
    );
    assert.notEqual(jcsStringify([1, 2]), jcsStringify([2, 1]), "array order matters");
    assert.equal(jcsStringify(-0), "-0");
    assert.equal(jcsStringify(1e21), "1e+21");
    assert.equal(jcsStringify(0.1), "0.1");
    assert.equal(jcsStringify('a"b\\c\nd\té'), JSON.stringify('a"b\\c\nd\té'));
    // astral vs lone-surrogate keys: code-point order (U+D801 < U+10000), NOT
    // UTF-16 unit order (0xD801 > 0xD800) — pins the [...str] spread sort.
    const obj: Record<string, number> = {};
    obj["\u{10000}"] = 2;
    obj["\uD801"] = 1;
    // V8 does not escape non-BMP characters in JSON.stringify, so build the
    // expected string from the code point itself.
    assert.equal(jcsStringify(obj), `{"\\ud801":1,"${String.fromCodePoint(0x10000)}":2}`);
});

test("carrier contract: strict whole-content match in the trailing user run only", () => {
    const mkOpenai = (last: unknown, extra: unknown[] = []) => ({
        model: "m",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: tag() },
            { role: "assistant", content: "yo" },
            ...extra,
            { role: "user", content: last },
        ],
    });
    const found = extractChainCarriers(mkOpenai(tag()), "openai");
    assert.equal(found.candidates.length, 1, "trailing whole-content carrier is recognized");
    assert.equal((found.stripped as { messages: unknown[] }).messages.length, 3, "carrier message stripped (4 total → 3)");

    assert.equal(extractChainCarriers(mkOpenai("plain"), "openai").candidates.length, 0, "mid-history tag is NOT a carrier (trailing run only)");
    assert.equal(extractChainCarriers({ model: "m", messages: [{ role: "assistant", content: tag() }] }, "openai").candidates.length, 0, "assistant content is never a carrier");
    assert.equal(extractChainCarriers(mkOpenai([{ type: "text", text: "hi" }, { type: "text", text: tag() }]), "openai").candidates.length, 0, "multi-block content is never a carrier");
    const singleBlock = extractChainCarriers(mkOpenai([{ type: "text", text: tag() }]), "openai");
    assert.equal(singleBlock.candidates.length, 1, "single text block IS the whole content");
    const malformed = extractChainCarriers(mkOpenai(L + "bili-chain broken" + R), "openai");
    assert.equal(malformed.candidates.length, 0);
    assert.equal(malformed.malformed, 1, "tag-shaped garbage in a carrier slot is counted malformed");

    const resp = {
        model: "m",
        input: [
            { type: "message", role: "user", content: "hi" },
            { type: "message", role: "assistant", content: "yo" },
            { type: "message", role: "user", content: tag() },
            { type: "compaction_trigger" },
        ],
    };
    const respFound = extractChainCarriers(resp, "responses");
    assert.equal(respFound.candidates.length, 1, "responses carrier before trailing compaction_trigger");
    const respStripped = respFound.stripped as { input: { type?: string }[] };
    assert.equal(respStripped.input.length, 3);
    assert.equal(respStripped.input[respStripped.input.length - 1].type, "compaction_trigger", "compaction_trigger stays last (#283/#209)");

    const bareStr = extractChainCarriers({ model: "m", input: tag() }, "responses");
    assert.equal(bareStr.candidates.length, 1, "bare-string input equal to the tag is a carrier");
    assert.equal((bareStr.stripped as { input: string }).input, "");

    const gOk = extractChainCarriers({ contents: [{ role: "user", parts: [{ text: tag() }] }] }, "google");
    assert.equal(gOk.candidates.length, 1);
    assert.equal(extractChainCarriers({ contents: [{ role: "user", parts: [{ text: tag() }, { text: "x" }] }] }, "google").candidates.length, 0, "two-part google content is never a carrier");
    assert.equal(extractChainCarriers({ contents: [{ role: "user", parts: [{ text: tag(), thoughtSignature: "s" }] }] }, "google").candidates.length, 0, "extra part field disqualifies");
    assert.equal(extractChainCarriers(null, "openai").candidates.length, 0);
    assert.equal(extractChainCarriers({ model: "m" }, "openai").candidates.length, 0);
});

test("digest: carrier-stripped body ≡ carrier-free body; key-order invariant; content-sensitive", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const stamped = insertCheckpointCarrier(base, "openai", tag())!;
    assert.equal(computeRequestDigest(stamped, "openai"), computeRequestDigest(base, "openai"), "removing the carrier must restore the original digest");
    const a = JSON.parse('{"model":"m","messages":[{"role":"user","content":"x"}]}');
    const b = JSON.parse('{"messages":[{"content":"x","role":"user"}],"model":"m"}');
    assert.equal(computeRequestDigest(a, "openai"), computeRequestDigest(b, "openai"));
    assert.notEqual(computeRequestDigest({ ...base, messages: [{ role: "user", content: "HELLO" }] }, "openai"), computeRequestDigest(base, "openai"));
});

test("zero-normalize round-trip: stamped body verifies as valid on every wire", () => {
    const fields = { v: 1, processor: "bili-rt", issuedAt: T0 + 1000, requestId: "req-rt" };
    for (const wire of ["openai", "anthropic"] as const) {
        const base = { model: "m", messages: [{ role: "user", content: "hello" }] };
        const digest = computeCheckpointDigest(base, wire, fields)!;
        const stamped = insertCheckpointCarrier(base, wire, renderChainCheckpoint({ ...fields, digest }))!;
        const ctx = evaluateChain(stamped, wire, { nowMs: T0 + 2000 });
        assert.equal(ctx.verdict, "valid", `${wire}: round-trip must verify`);
        assert.equal(ctx.selected?.requestId, "req-rt", wire);
    }
    const baseR = { model: "m", input: [{ type: "message", role: "user", content: "hello" }, { type: "compaction_trigger" }] };
    const dR = computeCheckpointDigest(baseR, "responses", fields)!;
    const sR = insertCheckpointCarrier(baseR, "responses", renderChainCheckpoint({ ...fields, digest: dR }))!;
    const input = (sR as { input: { type?: string }[] }).input;
    assert.equal(input[input.length - 1].type, "compaction_trigger", "stamp inserts BEFORE the trigger");
    assert.equal(input[input.length - 2]?.type === "message" ? (input[input.length - 2] as { content?: string }).content : "", renderChainCheckpoint({ ...fields, digest: dR }), "checkpoint lands in the trailing user slot");
    assert.equal(evaluateChain(sR, "responses", { nowMs: T0 + 2000 }).verdict, "valid");
});

test("zero-normalize round-trip: responses bare-string input normalizes to message array and verifies", () => {
    const fields = { v: 1, processor: "bili-rt-str", issuedAt: T0 + 1000, requestId: "req-rt-str" };
    const base = { model: "m", input: "hello" };
    const digest = computeCheckpointDigest(base, "responses", fields)!;
    const rendered = renderChainCheckpoint({ ...fields, digest });
    const stamped = insertCheckpointCarrier(base, "responses", rendered)! as { input: { type?: string; content?: unknown }[] };
    assert.ok(Array.isArray(stamped.input), "string input must be normalized to the array form");
    assert.equal(stamped.input.length, 2);
    assert.equal(stamped.input[0]!.type, "message");
    assert.equal(stamped.input[0]!.content, "hello", "original text survives as its own message");
    assert.equal(stamped.input[1]!.content, rendered, "carrier lands in the trailing user slot");
    assert.equal(evaluateChain(stamped, "responses", { nowMs: T0 + 2000 }).verdict, "valid", "stamped string-input body must verify");
    const baseEmpty = { model: "m", input: "" };
    const dE = computeCheckpointDigest(baseEmpty, "responses", fields)!;
    const sE = insertCheckpointCarrier(baseEmpty, "responses", renderChainCheckpoint({ ...fields, digest: dE }))!;
    assert.equal(evaluateChain(sE, "responses", { nowMs: T0 + 2000 }).verdict, "valid", "empty string input round-trips too");
});

test("verdict matrix: digest×timestamp quadrants, selection priority, version gating", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const stamp = (fields: typeof FIELDS, digest: string): unknown =>
        insertCheckpointCarrier(base, "openai", renderChainCheckpoint({ ...fields, digest }))!;
    const goodDigest = (fields: typeof FIELDS): string => computeCheckpointDigest(base, "openai", fields)!;
    const evalAt = (body: unknown, nowMs: number) => evaluateChain(body, "openai", { nowMs });

    assert.equal(evalAt(stamp(FIELDS, goodDigest(FIELDS)), T0 + MIN).verdict, "valid", "fresh + match");
    assert.equal(evalAt(stamp({ ...FIELDS, issuedAt: T0 - 11 * MIN }, goodDigest({ ...FIELDS, issuedAt: T0 - 11 * MIN })), T0).verdict, "stale", "match + out-of-window age");
    assert.equal(evalAt(stamp({ ...FIELDS, issuedAt: T0 + MIN }, goodDigest({ ...FIELDS, issuedAt: T0 + MIN })), T0).verdict, "valid", "match + future within skew is fresh");
    assert.equal(evalAt(stamp({ ...FIELDS, issuedAt: T0 + 3 * MIN }, goodDigest({ ...FIELDS, issuedAt: T0 + 3 * MIN })), T0).verdict, "stale", "MATCHED future beyond skew = replay/clock skew — verified identity, step 3 forwards + warns");
    assert.equal(evalAt(stamp({ ...FIELDS, issuedAt: T0 + 3 * MIN }, "sha256:" + "ee".repeat(32)), T0).verdict, "invalid", "future beyond skew with no digest match leaves nothing usable");
    assert.equal(evalAt(stamp(FIELDS, "sha256:" + "cd".repeat(32)), T0 + MIN).verdict, "recent-mismatch", "well-formed fresh, no digest match");
    assert.equal(evalAt(stamp({ ...FIELDS, issuedAt: T0 - 11 * MIN }, "sha256:" + "cd".repeat(32)), T0).verdict, "stale", "no-match stale only");

    const staleMatch = { ...FIELDS, issuedAt: T0 - 11 * MIN };
    const freshNoMatch = { ...FIELDS, issuedAt: T0 + 90_000, requestId: "r2" };
    const both = stamp(staleMatch, goodDigest(staleMatch)) as { model: string; messages: unknown[] };
    both.messages.push({ role: "user", content: renderChainCheckpoint({ ...freshNoMatch, digest: "sha256:" + "ee".repeat(32) }) });
    const pref = evalAt(both, T0);
    assert.equal(pref.verdict, "stale", "a verified digest outranks a fresher mismatched timestamp");
    assert.equal(pref.selected?.issuedAt, staleMatch.issuedAt);

    const a1 = { ...FIELDS, issuedAt: T0 + 40_000 };
    const a2 = { ...FIELDS, issuedAt: T0 + 80_000, requestId: "newer" };
    const multi = stamp(a1, goodDigest(a1)) as { model: string; messages: unknown[] };
    multi.messages.push({ role: "user", content: renderChainCheckpoint({ ...a2, digest: goodDigest(a2) }) });
    const finalBody = multi;
    const dFinal = computeRequestDigest(finalBody, "openai");
    const rebuilt = stamp(a1, dFinal) as { model: string; messages: unknown[] };
    rebuilt.messages.push({ role: "user", content: renderChainCheckpoint({ ...a2, digest: dFinal }) });
    const latest = evalAt(rebuilt, T0 + MIN);
    assert.equal(latest.verdict, "valid");
    assert.equal(latest.selected?.requestId, "newer", "latest issued-at wins within the matching-fresh class");

    const v2 = { ...FIELDS, v: 2 };
    assert.equal(evalAt(stamp(v2, goodDigest(v2)), T0 + MIN).verdict, "invalid", "unknown version alone is never trusted");
    const mixedV = stamp(v2, goodDigest(v2)) as { model: string; messages: unknown[] };
    mixedV.messages.pop();
    const mixedBody = stamp(FIELDS, goodDigest(FIELDS)) as { model: string; messages: unknown[] };
    mixedBody.messages.push({ role: "user", content: renderChainCheckpoint({ ...v2, digest: GOOD_DIGEST }) });
    assert.equal(evalAt(mixedBody, T0 + MIN).verdict, "valid", "known-version candidate decides; unknown version ignored");

    assert.equal(evalAt(base, T0).verdict, "none", "no signal at all");
    const malBody = insertCheckpointCarrier(base, "openai", L + "bili-chain nope" + R)!;
    const malCtx = evalAt(malBody, T0);
    assert.equal(malCtx.verdict, "invalid");
    assert.equal(malCtx.malformed, 1);
});

test("env overrides: BILI_CHAIN_MAX_FUTURE_SKEW_MS / BILI_CHAIN_RECENT_WINDOW_MS", () => {
    const base = { model: "m", messages: [{ role: "user", content: "h" }] };
    const bogus = "sha256:" + "cd".repeat(32);
    const futFields = { ...FIELDS, issuedAt: T0 + 20_000, requestId: "env-1" };
    const futBody = insertCheckpointCarrier(base, "openai", renderChainCheckpoint({ ...futFields, digest: bogus }))!;
    try {
        process.env.BILI_CHAIN_MAX_FUTURE_SKEW_MS = "15000";
        assert.equal(evaluateChain(futBody, "openai", { nowMs: T0 }).verdict, "invalid", "20s ahead exceeds tightened 15s skew — no usable candidate");
    } finally {
        delete process.env.BILI_CHAIN_MAX_FUTURE_SKEW_MS;
    }
    assert.equal(evaluateChain(futBody, "openai", { nowMs: T0 }).verdict, "recent-mismatch", `default ${DEFAULT_MAX_FUTURE_SKEW_MS}ms skew keeps 20s ahead fresh`);
    // 590s old: inside the default 600s window, outside a tightened 580s one.
    const pastFields = { ...FIELDS, issuedAt: T0 - 9 * MIN - 50_000, requestId: "env-2" };
    const pastBody = insertCheckpointCarrier(base, "openai", renderChainCheckpoint({ ...pastFields, digest: computeCheckpointDigest(base, "openai", pastFields)! }))!;
    try {
        process.env.BILI_CHAIN_RECENT_WINDOW_MS = String(DEFAULT_RECENT_CHECKPOINT_WINDOW_MS - 20_000);
        assert.equal(evaluateChain(pastBody, "openai", { nowMs: T0 }).verdict, "stale", "tightened window (580s) ages a 590s-old match");
    } finally {
        delete process.env.BILI_CHAIN_RECENT_WINDOW_MS;
    }
    assert.equal(evaluateChain(pastBody, "openai", { nowMs: T0 }).verdict, "valid", `default ${DEFAULT_RECENT_CHECKPOINT_WINDOW_MS}ms window keeps a 590s-old match fresh`);
});

// ---------- integration: real proxy, ZERO forwarding behavior change ----------

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const MODEL = "gpt-test";

function makeOpts(port: number, upstream: string): ProxyOptions {
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

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const srv = await startServer(makeOpts(0, llmUrl));
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

test("#1395 step 2 T1: valid checkpoint → shadow info log only; request still fully processed (no passthrough)", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const fields = { v: 1, processor: "bili-upstream-test", issuedAt: Date.now(), requestId: "req-step2-valid" };
        const sentJson = JSON.stringify(insertCheckpointCarrier(BASE_BODY, "openai", renderChainCheckpoint({ ...fields, digest: computeCheckpointDigest(BASE_BODY, "openai", fields)! }))!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step2-valid" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const shadows = logs.filter((l) => l.msg.includes("[chain-shadow]"));
        assert.equal(shadows.length, 1, `expected exactly one [chain-shadow] log, got ${shadows.length}: ${JSON.stringify(shadows)}`);
        assert.equal(shadows[0]!.level, "info");
        assert.ok(shadows[0]!.msg.includes("verdict=valid"), shadows[0]!.msg);
        assert.ok(shadows[0]!.msg.includes("request-id=req-step2-valid"), shadows[0]!.msg);
        assert.equal(captured.length, 1, "request reaches the LLM exactly once");
        assert.notEqual(captured[0]!.body, sentJson, "step 2 must NOT pass through verbatim (zero forwarding change)");
        assert.ok(captured[0]!.body.includes('"compress"'), "request must be fully processed (compress tool injected)");
    });
});

test("#1395 step 2 T2: well-formed fresh checkpoint with wrong digest → recent-mismatch warn; still processed", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const fields = { v: 1, processor: "bili-other", issuedAt: Date.now(), requestId: "req-step2-mismatch" };
        const sentJson = JSON.stringify(insertCheckpointCarrier(BASE_BODY, "openai", renderChainCheckpoint({ ...fields, digest: "sha256:" + "cd".repeat(32) }))!);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step2-mismatch" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const shadows = logs.filter((l) => l.msg.includes("[chain-shadow]"));
        assert.equal(shadows.length, 1, `expected exactly one [chain-shadow] log, got ${shadows.length}: ${JSON.stringify(shadows)}`);
        assert.equal(shadows[0]!.level, "warn");
        assert.ok(shadows[0]!.msg.includes("verdict=recent-mismatch"), shadows[0]!.msg);
        assert.equal(captured.length, 1);
        assert.notEqual(captured[0]!.body, sentJson, "no forwarding behavior change in step 2");
        assert.ok(captured[0]!.body.includes('"compress"'));
    });
});

test("#1395 step 2 T3: plain request → no [chain-shadow] log at all", async () => {
    await withRig(async ({ port, logs, captured }) => {
        const sentJson = JSON.stringify(BASE_BODY);
        const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-step2-plain" },
            body: sentJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(logs.filter((l) => l.msg.includes("[chain-shadow]")).length, 0, "no checkpoint signal, no shadow log");
        assert.equal(captured.length, 1);
        assert.ok(captured[0]!.body.includes('"compress"'));
    });
});
