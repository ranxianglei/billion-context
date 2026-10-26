import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2879: pfa-* anonymous ledgers were unattributable after the fact — hashed
// file names, ONE shared "prefix-affinity" label for every ledger, and a mint
// log line with no client fingerprint (#2847 misread four parallel ledgers as
// twin files of one session). Pinned here with genuine anonymous clients
// (no identity headers — prefix affinity mints pfa-* sessions, same hermetic
// shape as tests/issue2033-anonymous-anchor.test.ts):
//   A. the MINT request's fingerprint lands on metadata.anonymousPrefixAffinity
//      .producer (ua / header names / first-user-message preview / remote) and
//      the ledger gets a UNIQUE "prefix-affinity <tail8>" label;
//   B. two distinct anonymous conversations mint two sessions with DISTINCT
//      labels (the shared-label misread is gone);
//   C. producer is first-writer-wins — later turns with a different UA/headers
//      never clobber the mint fingerprint;
//   D. an x-bili-plugin marker WITHOUT a usable conversation identity records
//      pluginAgent — the host-extension stamp-failure signature.

const hermeticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2879-anonprov-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = hermeticRoot;
test.after(() => fs.rmSync(hermeticRoot, { recursive: true, force: true }));

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

const WINDOW = 120_000;
type Msg = { role: string; content: unknown };

function makeRelay() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    });
    return server;
}

async function startHarness() {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay();
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const upstreamPort = (relay.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    // NO identity headers by default — genuine anonymous client (#309 lane).
    const post = (messages: Msg[], extraHeaders: Record<string, string> = {}) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "bc-test-client/1.0", ...extraHeaders },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages }),
    });
    const anonSessions = (): Session[] => listSessions().filter((s) => s.id.startsWith("pfa-") && s.metadata.anonymousPrefixAffinity);
    const close = async () => {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => relay.close(() => r()));
    };
    return { logs, post, anonSessions, close };
}

test("#2879 A: mint captures producer provenance + unique label (e2e)", async () => {
    const h = await startHarness();
    try {
        const base: Msg[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "PROVENANCE SENTINEL ALPHA: refactor the billing module for issue 2879" },
            { role: "assistant", content: "Understood, starting the refactor." },
        ];
        const r1 = await h.post(base, { "x-test-marker": "v1" });
        assert.equal(r1.status, 200, "anonymous turn succeeds");
        await r1.text();
        const [s] = h.anonSessions();
        assert.ok(s, "a pfa-* session was minted");
        const stamp = s!.metadata.anonymousPrefixAffinity as { tailHash: string; producer?: Record<string, unknown> };
        assert.ok(stamp.producer, "producer provenance stamped at mint");
        assert.equal(stamp.producer.ua, "bc-test-client/1.0");
        const headerNames = stamp.producer.headers as string[];
        for (const expected of ["user-agent", "content-type", "x-test-marker"]) {
            assert.ok(headerNames.includes(expected), `header name list carries ${expected} (${headerNames.join(",")})`);
        }
        assert.equal(typeof stamp.producer.firstMsg, "string");
        assert.ok(String(stamp.producer.firstMsg).startsWith("PROVENANCE SENTINEL ALPHA"), `first user message preview captured (${stamp.producer.firstMsg})`);
        assert.equal(typeof stamp.producer.remote, "string");
        assert.ok((stamp.producer.remote as string).length > 0);
        assert.ok(typeof stamp.producer.at === "number");
        assert.equal(stamp.producer.pluginAgent, undefined, "no plugin marker sent → no pluginAgent");
        // The shared-label misread fix: unique per-ledger label, stable tail fragment.
        assert.equal(s!.meta.label, `prefix-affinity ${stamp.tailHash.slice(0, 8)}`, "label is the unique prefix-affinity <tail8> form");
        const mintLog = h.logs.find((l) => l.includes(`new anonymous session ${s!.id}`));
        assert.ok(mintLog, "mint log line present");
        assert.ok(mintLog!.includes('ua="bc-test-client/1.0"'), `mint log carries ua (${mintLog})`);
        assert.ok(mintLog!.includes('plugin=-'), "mint log carries plugin slot (no marker sent)");
        assert.ok(mintLog!.includes("PROVENANCE SENTINEL ALPHA"), "mint log carries first-message preview");
    } finally {
        await h.close();
    }
});

test("#2879 B: distinct anonymous conversations get distinct labels (e2e)", async () => {
    const h = await startHarness();
    try {
        const convA: Msg[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "SENTINEL BRAVO: first conversation, analyze the network traces" },
        ];
        const convB: Msg[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "SENTINEL CHARLIE: second conversation, draft the release notes" },
        ];
        const rA = await h.post(convA);
        assert.equal(rA.status, 200);
        await rA.text();
        const rB = await h.post(convB);
        assert.equal(rB.status, 200);
        await rB.text();
        const sessions = h.anonSessions();
        assert.equal(sessions.length, 2, `two distinct pfa-* sessions minted (got ${sessions.length})`);
        const labels = sessions.map((s) => s.meta.label);
        assert.notEqual(labels[0], labels[1], `labels differ (${labels.join(" | ")})`);
        for (const label of labels) assert.ok(label?.startsWith("prefix-affinity "), `label keeps the family prefix (${label})`);
        const previews = sessions.map((s) => (s.metadata.anonymousPrefixAffinity as { producer?: { firstMsg?: string } }).producer?.firstMsg ?? "");
        assert.ok(previews.some((p) => p.startsWith("SENTINEL BRAVO")), "conv-A preview attributed to its own ledger");
        assert.ok(previews.some((p) => p.startsWith("SENTINEL CHARLIE")), "conv-B preview attributed to its own ledger");
    } finally {
        await h.close();
    }
});

test("#2879 C: producer is first-writer-wins across turns (e2e)", async () => {
    const h = await startHarness();
    try {
        const base: Msg[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "SENTINEL DELTA: long running task, step one" },
            { role: "assistant", content: "Step one done." },
        ];
        const r1 = await h.post(base, { "x-test-marker": "v1" });
        assert.equal(r1.status, 200);
        await r1.text();
        const turn2: Msg[] = [...base, { role: "user", content: "step two?" }];
        const r2 = await h.post(turn2, { "user-agent": "bc-other-client/9.9", "x-later-header": "late" });
        assert.equal(r2.status, 200);
        await r2.text();
        const [s] = h.anonSessions();
        const producer = (s!.metadata.anonymousPrefixAffinity as { producer?: Record<string, unknown> }).producer!;
        assert.equal(producer.ua, "bc-test-client/1.0", "mint UA survives a later turn with a different UA");
        const headerNames = producer.headers as string[];
        assert.ok(headerNames.includes("x-test-marker"), "mint header list preserved");
        assert.ok(!headerNames.includes("x-later-header"), "later-turn headers do not leak into the mint fingerprint");
        assert.ok(String(producer.firstMsg).startsWith("SENTINEL DELTA"), "first-message preview stays the mint conversation's");
    } finally {
        await h.close();
    }
});

test("#2879 D: x-bili-plugin marker without conversation identity records pluginAgent (e2e)", async () => {
    const h = await startHarness();
    try {
        const msgs: Msg[] = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "SENTINEL ECHO: extension loaded but stamp failed" },
        ];
        const r1 = await h.post(msgs, { "x-bili-plugin": "pi" });
        assert.equal(r1.status, 200);
        await r1.text();
        const [s] = h.anonSessions();
        assert.ok(s, "anonymous resolution still applies (marker alone is not a conversation identity)");
        const producer = (s!.metadata.anonymousPrefixAffinity as { producer?: Record<string, unknown> }).producer!;
        assert.equal(producer.pluginAgent, "pi", "plugin lane recorded — the stamp-failure signature");
    } finally {
        await h.close();
    }
});
