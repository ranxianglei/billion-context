import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { DUMP_PLAINTEXT_BANNER, stripDumpBanner } from "../src/dump-banner.js";
import { runDiff } from "../src/acp-cache-diff.ts";
import { rmrf } from "./tmp-rm.ts";

// #4482: opt-in body dumps land on disk as full plaintext conversation bodies
// (credentials included) with zero warning. These tests pin the standing
// warning banner on the real writer paths (raw/*-INCOMING.txt, raw/*-REQ.txt,
// dumps/req-*.json) and prove bili acp-cache diff still classifies pre-banner
// (old-format) dumps identically to bannered ones — including mixed dirs.

const M1 = { role: "user", content: "hello there" };
const M2 = { role: "assistant", content: "hi!" };
const BODY_MARKER = "dump-banner-marker-QQQ42";

function chatBody(model: string, msgs: unknown[]): string { return JSON.stringify({ model, messages: msgs }); }
function tmpdir(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("#4482: banner text is pinned and the analyze-dumps.mjs copy stays in sync", () => {
    assert.equal(DUMP_PLAINTEXT_BANNER, "PLAINTEXT DUMP — full conversation body, may contain credentials; scrub before sharing");
    // parseDumpFile treats head lines as potential "k: v" headers; a ": " in
    // the banner would silently pollute every parsed dump's header map.
    assert.ok(!DUMP_PLAINTEXT_BANNER.includes(": "), "banner must stay free of ': '");
    const toolSrc = fs.readFileSync(fileURLToPath(new URL("../tools/analyze-dumps.mjs", import.meta.url)), "utf8");
    assert.ok(toolSrc.includes(`const PLAINTEXT_BANNER = "${DUMP_PLAINTEXT_BANNER}";`), "tools/analyze-dumps.mjs banner literal drifted from src/dump-banner.ts");
});

test("#4482: stripDumpBanner drops LF/CRLF banner lines, leaves everything else intact", () => {
    assert.equal(stripDumpBanner(`${DUMP_PLAINTEXT_BANNER}\n{"a":1}`), '{"a":1}');
    assert.equal(stripDumpBanner(`${DUMP_PLAINTEXT_BANNER}\r\n{"a":1}`), '{"a":1}');
    assert.equal(stripDumpBanner('{"a":1}'), '{"a":1}');
    assert.equal(stripDumpBanner(`${DUMP_PLAINTEXT_BANNER} extra\n{"a":1}`), `${DUMP_PLAINTEXT_BANNER} extra\n{"a":1}`);
});

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(p));
        else out.push(p);
    }
    return out;
}

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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
}

interface Env {
    xdg: string | undefined;
    body: string | undefined;
}

function saveEnv(): Env {
    return { xdg: process.env.XDG_STATE_HOME, body: process.env.ACP_DUMP_BODY };
}

function restoreEnv(prev: Env): void {
    if (prev.xdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.xdg;
    if (prev.body === undefined) delete process.env.ACP_DUMP_BODY;
    else process.env.ACP_DUMP_BODY = prev.body;
}

async function startHarness(tmpRoot: string): Promise<{ proxy: http.Server; upstream: http.Server; proxyPort: number; upstreamPort: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts = baseOpts();
    opts.routes = { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, upstream, proxyPort, upstreamPort };
}

test("#4482: real writers lead INCOMING/REQ/JSON dumps with the banner, body intact", async () => {
    const tmpRoot = tmpdir("bili-4482-writers-");
    const prev = saveEnv();
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.ACP_DUMP_BODY = "1";
    let h: Awaited<ReturnType<typeof startHarness>> | undefined;
    try {
        h = await startHarness(tmpRoot);
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: BODY_MARKER }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const files = listFiles(path.join(tmpRoot, "billion-context"));
        const incoming = files.filter((f) => f.endsWith("-INCOMING.txt"));
        assert.equal(incoming.length, 1, `expected exactly one INCOMING dump, got: ${files.join(", ") || "(none)"}`);
        const reqTxt = files.filter((f) => f.endsWith("-REQ.txt"));
        assert.equal(reqTxt.length, 1, `expected exactly one REQ dump, got: ${files.join(", ") || "(none)"}`);
        const jsonDumps = files.filter((f) => /req-\d+-.+\.json$/.test(f));
        assert.equal(jsonDumps.length, 1, `expected exactly one dumps/req-*.json, got: ${files.filter((f) => f.includes("dumps")).join(", ") || "(none)"}`);

        for (const f of [...incoming, ...reqTxt]) {
            const text = fs.readFileSync(f, "utf8");
            assert.ok(text.startsWith(`${DUMP_PLAINTEXT_BANNER}\n`), `${path.basename(f)} must lead with the plaintext warning banner`);
            assert.ok(text.includes(BODY_MARKER), `${path.basename(f)} must still carry the exact body bytes`);
        }
        const jsonText = fs.readFileSync(jsonDumps[0], "utf8");
        assert.ok(jsonText.startsWith(`${DUMP_PLAINTEXT_BANNER}\n`), "dumps/req-*.json must lead with the plaintext warning banner");
        const parsed = JSON.parse(stripDumpBanner(jsonText)) as { messages: Array<{ content?: unknown }> };
        assert.ok(parsed.messages.some((m) => String(m.content).includes(BODY_MARKER)), "body after the banner must parse and carry the marker");
    } finally {
        restoreEnv(prev);
        if (h) { await close(h.proxy); await close(h.upstream); }
        rmrf(tmpRoot);
    }
});

const T_A = Date.parse("2026-10-24T08:00:00.000Z");
const T_B = Date.parse("2026-10-24T08:00:05.000Z");

function writeSession(dir: string, sid: string, banner: boolean): void {
    const w = (ts: number, kind: "INCOMING" | "REQ", body: string): void => {
        const head = ["POST /v1/chat/completions", "content-type: application/json"].join("\n");
        fs.writeFileSync(path.join(dir, `${ts}-${sid}-${kind}.txt`), `${banner ? `${DUMP_PLAINTEXT_BANNER}\n` : ""}${head}\n\n${body}`);
    };
    w(T_A, "INCOMING", chatBody("gpt-x", [M1]));
    w(T_A + 1, "REQ", chatBody("gpt-x", [M1]));
    w(T_B, "INCOMING", chatBody("gpt-x", [M1, M2]));
    w(T_B + 1, "REQ", chatBody("gpt-x", [M1, M2]));
}

function pairShape(p: { category: string; attribution: string | null; outgoingAppend: { kind: string } | null; incomingAppend: { kind: string } | null; outgoingExtra: number; incomingExtra: number | null; modelA: string | null; modelB: string | null; divergence: { offset: number } | null }): Record<string, unknown> {
    return {
        category: p.category,
        attribution: p.attribution,
        outgoingAppend: p.outgoingAppend?.kind ?? null,
        incomingAppend: p.incomingAppend?.kind ?? null,
        outgoingExtra: p.outgoingExtra,
        incomingExtra: p.incomingExtra,
        modelA: p.modelA,
        modelB: p.modelB,
        divergenceOffset: p.divergence?.offset ?? null,
    };
}

test("#4482: runDiff classifies bannered dumps identically to pre-banner ones (old dumps stay readable)", () => {
    const oldDir = tmpdir("bili-4482-oldfmt-");
    const newDir = tmpdir("bili-4482-newfmt-");
    try {
        writeSession(oldDir, "ses_old", false);
        writeSession(newDir, "ses_new", true);
        const rOld = runDiff(oldDir, { noLog: true });
        const rNew = runDiff(newDir, { noLog: true });
        assert.equal(rOld.totalPairs, 1);
        assert.equal(rNew.totalPairs, 1);
        const shapeOld = pairShape(rOld.sessions[0]!.pairs[0]!);
        const shapeNew = pairShape(rNew.sessions[0]!.pairs[0]!);
        assert.deepEqual(shapeNew, shapeOld, "banner must not change classification, extras, models or divergence offsets");
        assert.equal(shapeOld.category, "pure-append");
        assert.equal(shapeOld.modelA, "gpt-x");
        assert.equal(shapeOld.modelB, "gpt-x");
    } finally { rmrf(oldDir); rmrf(newDir); }
});

test("#4482: runDiff handles a mixed dir (pre-banner + bannered dumps side by side)", () => {
    const dir = tmpdir("bili-4482-mixed-");
    try {
        writeSession(dir, "ses_old", false);
        writeSession(dir, "ses_new", true);
        const report = runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 2);
        for (const s of report.sessions) {
            for (const p of s.pairs) {
                assert.equal(p.category, "pure-append", `session ${s.sid} must classify pure-append regardless of banner presence`);
                assert.equal(p.modelA, "gpt-x");
                assert.equal(p.modelB, "gpt-x");
            }
        }
    } finally { rmrf(dir); }
});
