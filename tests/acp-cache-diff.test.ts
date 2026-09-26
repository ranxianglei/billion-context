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
import { compareWires, parseUsageLog, renderJson, renderText, runDiff } from "../src/acp-cache-diff.ts";

// #1266: `bili acp-cache diff <dump-dir>` — synthetic dump pairs covering the
// three classification shapes (pure-append / mid-stream-rewrite /
// prefix-stable-miss), legacy filename handling, usage-log correlation, and
// the INCOMING-filename fix (session id now embedded).

const M1 = { role: "user", content: "hello there" };
const M2 = { role: "assistant", content: "hi!" };
const M3 = { role: "user", content: "follow-up question" };
const M1X = { role: "user", content: "REWRITTEN history" };

function chatBody(model: string, msgs: unknown[]): string { return JSON.stringify({ model, messages: msgs }); }

function tmpdir(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function writeDump(dir: string, ts: number, sid: string | null, kind: "REQ" | "INCOMING", body: string, headers: Record<string, string> = {}, legacy = false): void {
    const name = kind === "INCOMING" && legacy ? `${ts}-INCOMING.txt` : `${ts}-${sid}-${kind}.txt`;
    const hdrs = ["content-type: application/json", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    fs.writeFileSync(path.join(dir, name), `POST /v1/chat/completions\n${hdrs.join("\n")}\n\n${body}`);
}

interface TwoReq { aIn: string; bIn: string; aOut: string; bOut: string; }

function twoRequestSession(dir: string, sid: string, tA: number, tB: number, bodies: TwoReq, opts?: { legacy?: boolean }): void {
    writeDump(dir, tA, sid, "INCOMING", bodies.aIn, {}, opts?.legacy);
    writeDump(dir, tA + 1, sid, "REQ", bodies.aOut);
    writeDump(dir, tB, sid, "INCOMING", bodies.bIn, {}, opts?.legacy);
    writeDump(dir, tB + 1, sid, "REQ", bodies.bOut);
}

const T_A = Date.parse("2026-09-24T14:32:04.500Z");
const T_B = Date.parse("2026-09-24T14:32:11.000Z");

test("compareWires: strict byte prefix is append(strict)", () => {
    const r = compareWires(Buffer.from('{"a":1'), Buffer.from('{"a":12}'));
    assert.equal(r.rel, "append");
    assert.equal(r.append?.kind, "strict");
});

test("compareWires: healthy message-array append is append(json-tail), not a rewrite (#1266)", () => {
    const a = Buffer.from(chatBody("gpt-x", [M1, M2]));
    const b = Buffer.from(chatBody("gpt-x", [M1, M2, M3]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "append");
    assert.equal(r.append?.kind, "json-tail");
    assert.equal(r.append?.countA, 2);
    assert.equal(r.append?.countB, 3);
});

test("compareWires: rewritten shared element is a mid-stream diverge", () => {
    const a = Buffer.from(chatBody("gpt-x", [M1, M2, M3]));
    const b = Buffer.from(chatBody("gpt-x", [M1X, M2, M3]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "diverge");
    assert.equal(r.preArray, false);
    assert.ok(r.byteOffset > 0);
});

test("compareWires: field change before the message array is a preArray diverge", () => {
    const a = Buffer.from(chatBody("gpt-x", [M1]));
    const b = Buffer.from(chatBody("gpt-y", [M1]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "diverge");
    assert.equal(r.preArray, true);
});

test("compareWires: truncating the message list is a diverge, not an append", () => {
    const a = Buffer.from(chatBody("gpt-x", [M1, M2, M3]));
    const b = Buffer.from(chatBody("gpt-x", [M1, M2]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "diverge");
});

test("runDiff: healthy array-append pair classifies pure-append (json-tail), usage unavailable noted", () => {
    const dir = tmpdir("acp-diff-pure-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        const report = runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 1);
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "pure-append");
        assert.equal(p.outgoingAppend?.kind, "json-tail");
        assert.equal(p.incomingAppend?.kind, "json-tail");
        assert.equal(p.usageAvailable, false);
        assert.ok(p.notes.some((n) => n.includes("[acp-usage]")), p.notes.join(";"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: incoming append + outgoing mid-stream drift attributes proxy (#1249 shape)", () => {
    const dir = tmpdir("acp-diff-proxy-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1, M2]), bIn: chatBody("gpt-x", [M1, M2, M3]),
            aOut: chatBody("gpt-x", [M1, M2]), bOut: chatBody("gpt-x", [M1X, M2, M3]),
        });
        const report = runDiff(dir, { noLog: true });
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "mid-stream-rewrite");
        assert.equal(p.attribution, "proxy");
        assert.equal(p.incoming, "append");
        assert.equal(p.divergence?.messageIndex, 0);
        assert.equal(p.divergence?.roleType, "user");
        assert.ok(p.divergence!.offset > 0);
        assert.ok(p.notes.some((n) => n.includes("#1249")), p.notes.join(";"));
        assert.ok(report.worst.some((w) => w.session === "ses_a" && w.pair.category === "mid-stream-rewrite"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: client-side rewrite forwarded verbatim attributes client", () => {
    const dir = tmpdir("acp-diff-client-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1, M2]), bIn: chatBody("gpt-x", [M1X, M2, M3]),
            aOut: chatBody("gpt-x", [M1, M2]), bOut: chatBody("gpt-x", [M1X, M2, M3]),
        });
        const report = runDiff(dir, { noLog: true });
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "mid-stream-rewrite");
        assert.equal(p.attribution, "client");
        assert.equal(p.divergence?.messageIndex, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: stable outgoing prefix + collapsed cached tokens classifies prefix-stable-miss", () => {
    const dir = tmpdir("acp-diff-miss-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        fs.writeFileSync(path.join(dir, "bili.log"), [
            "2026-09-24T14:32:05.123Z [info] [ses_a] [acp-usage] round 1 input=100000 cached=95000 (cache hit 95%)",
            "2026-09-24T14:32:12.456Z [info] [ses_a] [acp-usage] round 1 input=104000 cached=1000 (cache hit 1%)",
            "2026-09-24T14:32:12.999Z [info] unrelated noise line",
        ].join("\n") + "\n");
        const report = runDiff(dir);
        assert.equal(report.logSource, path.join(dir, "bili.log"));
        assert.equal(report.usageSamples, 2);
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "prefix-stable-miss");
        assert.equal(p.outgoing, "append");
        assert.equal(p.usage?.inputA, 100000);
        assert.equal(p.usage?.cachedB, 1000);
        assert.equal(p.usage?.missedPrefix, 99000);
        assert.equal(p.usage?.hitPctB, 1);
        assert.ok(report.worst.some((w) => w.session === "ses_a" && w.pair.category === "prefix-stable-miss"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: dense request cadence (<2s apart, compress-loop regime) still aligns usage — a later request must not steal its predecessor's response line", () => {
    // Regression: the old alignUsage window (+2000ms in the WRONG direction)
    // let request B's dump claim response A's usage line whenever B followed A
    // by < 2s. Request A then lost its usage data and the miss went
    // undetected (pure-append + "no [acp-usage] data") precisely in the dense
    // compress-loop cadence this tool exists to diagnose.
    const dir = tmpdir("acp-diff-dense-");
    try {
        const tA = Date.parse("2026-09-24T14:32:04.500Z");
        const tB = tA + 1500; // 1.5s apart
        twoRequestSession(dir, "ses_dense", tA, tB, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        fs.writeFileSync(path.join(dir, "bili.log"), [
            "2026-09-24T14:32:05.000Z [info] [ses_dense] [acp-usage] round 1 input=100000 cached=95000 (cache hit 95%)",
            "2026-09-24T14:32:06.000Z [info] [ses_dense] [acp-usage] round 1 input=104000 cached=1000 (cache hit 1%)",
        ].join("\n") + "\n");
        const report = runDiff(dir);
        assert.equal(report.usageSamples, 2);
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.usageAvailable, true, "request A must keep its own response's usage line");
        assert.equal(p.category, "prefix-stable-miss");
        assert.equal(p.usage?.inputA, 100000);
        assert.equal(p.usage?.cachedB, 1000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: healthy usage (cached ≈ previous input) stays pure-append", () => {
    const dir = tmpdir("acp-diff-healthy-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        fs.writeFileSync(path.join(dir, "bili.log"), [
            "2026-09-24T14:32:05.123Z [info] [ses_a] [acp-usage] round 1 input=100000 cached=95000 (cache hit 95%)",
            "2026-09-24T14:32:12.456Z [info] [ses_a] [acp-usage] round 1 input=104000 cached=99500 (cache hit 95%)",
        ].join("\n") + "\n");
        const report = runDiff(dir);
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "pure-append");
        assert.equal(p.usage?.missedPrefix, 500);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: legacy INCOMING filenames (no session id) attribute by timestamp proximity", () => {
    const dir = tmpdir("acp-diff-legacy-");
    try {
        twoRequestSession(dir, "ses_c", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        }, { legacy: true });
        const report = runDiff(dir, { noLog: true });
        const s = report.sessions.find((x) => x.sid === "ses_c");
        assert.ok(s, "session should be found via REQ dumps");
        assert.equal(s!.legacyIncoming, 2);
        const p = s!.pairs[0]!;
        assert.equal(p.incoming, "append");
        assert.ok(p.notes.some((n) => n.includes("legacy")), p.notes.join(";"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: model change between requests is noted", () => {
    const dir = tmpdir("acp-diff-model-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-y", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-y", [M1, M2]),
        });
        const report = runDiff(dir, { noLog: true });
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "mid-stream-rewrite");
        assert.ok(p.notes.some((n) => n.includes("model changed gpt-x→gpt-y")), p.notes.join(";"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("runDiff: --session filters sessions; empty dir throws a guidance error", () => {
    const dir = tmpdir("acp-diff-filter-");
    try {
        twoRequestSession(dir, "ses_a", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        twoRequestSession(dir, "ses_b", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        const all = runDiff(dir, { noLog: true });
        assert.equal(all.sessions.length, 2);
        const filtered = runDiff(dir, { noLog: true, session: "ses_b" });
        assert.equal(filtered.sessions.length, 1);
        assert.equal(filtered.sessions[0]!.sid, "ses_b");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const empty = tmpdir("acp-diff-empty-");
    try {
        assert.throws(() => runDiff(empty, { noLog: true }), /no ACP_DUMP_BODY dumps/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("renderJson/renderText: machine output parses and text highlights worst offenders", () => {
    const dir = tmpdir("acp-diff-render-");
    try {
        twoRequestSession(dir, "ses_ok", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1]), bIn: chatBody("gpt-x", [M1, M2]),
            aOut: chatBody("gpt-x", [M1]), bOut: chatBody("gpt-x", [M1, M2]),
        });
        twoRequestSession(dir, "ses_bad", T_A, T_B, {
            aIn: chatBody("gpt-x", [M1, M2]), bIn: chatBody("gpt-x", [M1, M2, M3]),
            aOut: chatBody("gpt-x", [M1, M2]), bOut: chatBody("gpt-x", [M1X, M2, M3]),
        });
        const report = runDiff(dir, { noLog: true });
        const parsed = JSON.parse(renderJson(report)) as { totalPairs: number; byCategory: Record<string, number>; worst: unknown[] };
        assert.equal(parsed.totalPairs, 2);
        assert.equal(Object.values(parsed.byCategory).reduce((n, v) => n + v, 0), 2);
        assert.equal(parsed.byCategory["mid-stream-rewrite"], 1);
        assert.ok(parsed.worst.length >= 1 && parsed.worst.length <= 5);
        const text = renderText(report);
        assert.ok(text.includes("worst offenders:"), text);
        assert.ok(text.includes("ses_bad #1"), text);
        assert.ok(text.includes("MID-STREAM-REWRITE(proxy)"), text);
        assert.ok(text.includes("PURE-APPEND"), text);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("parseUsageLog: loop + plugin variants, sanitized sids, malformed lines skipped", () => {
    const dir = tmpdir("acp-diff-log-");
    try {
        const file = path.join(dir, "bili.log");
        fs.writeFileSync(file, [
            "2026-09-24T14:32:05.123Z [info] [weird/id] [acp-usage] round 1 input=100 cached=50 (cache hit 50%)",
            "2026-09-24T14:32:06.000Z [info] [weird/id] [plugin] [acp-usage] input=200 cached=180 (cache hit 90%)",
            "2026-09-24T14:32:07.000Z [info] [other] [plugin] [acp-usage] input=300 cached=n/a",
            "2026-09-24T14:32:08.000Z [warn] [weird/id] something else entirely",
        ].join("\n") + "\n");
        const map = parseUsageLog(file);
        assert.deepEqual(map.get("weird_id"), [
            { ts: Date.parse("2026-09-24T14:32:05.123Z"), input: 100, cached: 50 },
            { ts: Date.parse("2026-09-24T14:32:06.000Z"), input: 200, cached: 180 },
        ]);
        assert.ok(!map.has("other"), "cached=n/a line must be skipped");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
        mitm: { enabled: false, domains: [] },
    };
}

test("server: INCOMING dump filename carries the bound session id (#1266)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-inc-name-"));
    const prev = { xdg: process.env.XDG_STATE_HOME, body: process.env.ACP_DUMP_BODY };
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let proxy: http.Server | undefined;
    let upstream: http.Server | undefined;
    try {
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        upstream = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;
        const opts = baseOpts();
        opts.routes = { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } };
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const proxyPort = (proxy.address() as { port: number }).port;
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "acp-diff-h1" },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "INC-NAME-MARKER" }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        const rawDir = path.join(tmpRoot, "billion-context", "raw");
        const incFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith("-INCOMING.txt"));
        assert.equal(incFiles.length, 1, incFiles.join(","));
        assert.match(incFiles[0]!, /^\d+-acp-diff-h1-INCOMING\.txt$/);
        assert.ok(!/^\d+-INCOMING\.txt$/.test(incFiles[0]!), "old session-less format must be gone");
        const content = fs.readFileSync(path.join(rawDir, incFiles[0]!), "utf8");
        assert.ok(content.includes("INC-NAME-MARKER"), "INCOMING dump should still carry the client wire bytes");
    } finally {
        if (prev.xdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev.xdg;
        if (prev.body === undefined) delete process.env.ACP_DUMP_BODY;
        else process.env.ACP_DUMP_BODY = prev.body;
        if (proxy) await new Promise<void>((resolve, reject) => proxy!.close((e) => (e ? reject(e) : resolve())));
        if (upstream) await new Promise<void>((resolve, reject) => upstream!.close((e) => (e ? reject(e) : resolve())));
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
