import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";

// #3978 (persistence half): preflight compression of a massively over-window
// context runs for minutes; clients with a hard wall timeout (~40s) disconnect
// mid-marathon, and their retries arrive under NEW session ids where
// resume-inheritance (#1486) can continue only if the parent's partial blocks
// are loadable from disk. On master a CLEAN client abort already persists the
// committed folds — the post-loop rebuild (src/server.ts:3554 runPrepare →
// markDirty) runs BEFORE the fail-fast return (:3607) — but a HARD process
// death mid-marathon (crash / OOM / restart at this payload scale) skips every
// post-loop path: pre-fix only the request-start prepare write (zero blocks)
// had landed, so every retry re-compressed from zero: a permanent
// unavailability loop. Fix under test: each committed fold marks the session
// dirty as it lands (commitFold in src/preflight.ts), so whatever rounds
// finished are durable within the persist debounce no matter how the request
// ends. Pinned end-to-end: T1 guards the clean-abort ordering (a regression
// that moves the fail-fast return ahead of the rebuild goes red); T2 =
// negative control (no fold committed ⇒ nothing fold-like persisted, gate
// discipline #3617); T3 = a SIGKILLed child proxy mid-marathon leaves durable
// folds that a new-id retry on a fresh instance inherits instead of starting
// fresh. Inheritance needs TWO durable artifacts: the session record
// (per-fold save) AND the parent's affinity-chain entry in the machine-shared
// state-dir snapshot (stateDir()/prefix-affinity.json) — findResumeParent's
// candidate source (#1486/#499), written by its own 500ms-debounced
// single-shot persist. T3 waits for both before the kill. Sizing:
// conversation(40) ≈ 48k tokens vs a 12k window — one batch round removes at
// most MAX_PREFLIGHT_SUMMARY_BATCH × CHUNK_FRACTION × window ≈ 28.8k (#2682),
// so ≥2 rounds are guaranteed and the death always lands mid-marathon.

const SUMMARY_TEXT =
    "PREFLIGHT BATCH SUMMARY: the segment covered iterative debugging of a proxy pipeline. " +
    "Decisions: persist per-fold so a dead marathon leaves durable progress behind. " +
    "Files touched: src/preflight.ts:2174, src/persist.ts:2294. Outcome: folded and verified.";
const SUMMARY_MARK = "PREFLIGHT BATCH SUMMARY";
const ABORT_LINE = /preflight aborted .*not forwarding/;

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function conversation(n: number, tag: string): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${tag} Message ${i}. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function startMainUpstream(): Promise<{ server: http.Server; url: string }> {
    return new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
}

/** External-summary upstream whose every request costs `delayMs` of wall time —
 *  the stand-in for a real 25-44s summarization round. */
function startSummaryUpstream(delayMs: number): Promise<{ server: http.Server; url: string; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                setTimeout(() => {
                    n += 1;
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
                }, delayMs);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls: () => n }));
    });
}

const PROXY_OPTS = (mainUrl: string, sumUrl: string, context: number): ProxyOptions => ({
    port: 0,
    host: "127.0.0.1",
    upstream: mainUrl,
    routes: { [mainUrl]: { models: { "claude-small": { context } } } },
    modelContextLimit: 400_000,
    kernelConfig: defaultConfig(400_000, { compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
    compress: {
        injectTool: true,
        injectNudge: true,
        externalSummary: { enabled: true, targets: ["sum/sm"] },
    },
    namedProviders: { sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_ISSUE3978_SUM_KEY", models: { sm: {} } } },
    promptCache: { routing: "auto" },
    sessionHeader: "x-acp-session",
    log: true,
    debug: false,
    passthrough: false,
    compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    autoUpdate: false,
    mitm: { enabled: false, domains: [] },
});

async function startProxy(mainUrl: string, sumUrl: string, context: number, dir: string): Promise<{ proxy: http.Server; store: SessionStore }> {
    const store = new SessionStore({ enabled: true, dir, debounceMs: 50 });
    _setStoreForTest(store);
    setRegistryForTest({});
    process.env.E2E_ISSUE3978_SUM_KEY = "k";
    const proxy = await startServer(PROXY_OPTS(mainUrl, sumUrl, context));
    await once(proxy, "listening");
    return { proxy, store };
}

function activeBlocks(sessionId: string): number {
    const s = listSessions().find((x) => x.id === sessionId);
    return (s?.state.blocks ?? []).filter((b) => b.active).length;
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function postTurn(port: number, mainUrl: string, sessionId: string, msgs: Array<{ role: string; content: string }>, signal?: AbortSignal): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/bili/${mainUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: msgs }),
        signal,
    });
}

async function closeServer(server: http.Server): Promise<void> {
    server.close();
    server.closeIdleConnections?.();
    await once(server, "close");
}

/** Fire a turn without awaiting it; cancel any body the server manages to send. */
function fireAndForget(p: Promise<Response>): void {
    void p.then((r) => { void r.body?.cancel().catch(() => undefined); }).catch(() => undefined);
}

/** Source of the T3 child proxy: a REAL separate process running the same
 *  hermetic setup over the shared store dir. Only a true process death can
 *  skip the post-loop rebuild that a clean client abort triggers, so the
 *  death scenario cannot be faked in-process. Prints `READY {json}` once up,
 *  then `[blocks] N` whenever t3978-p's active block count changes. */
function childProxySource(srcBase: string, dir: string): string {
    return `
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import * as pth from "node:path";
import { startServer } from "${srcBase}server.ts";
import { SessionStore, _setStoreForTest } from "${srcBase}persist.ts";
import { _setForTest as setRegistryForTest } from "${srcBase}registry.ts";
import { listSessions } from "${srcBase}session.ts";
import { stateDir } from "${srcBase}paths.ts";
import { scheduleAffinityPersist } from "${srcBase}affinity-persist.ts";
import { defaultConfig } from "acp-kernel";

const SUMMARY_TEXT = ${JSON.stringify(SUMMARY_TEXT)};
const dir = ${JSON.stringify(dir)};

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function main(): Promise<void> {
    const mainServer = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
            "event: message_start\\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } }) + "\\n\\n" +
            "event: content_block_start\\ndata: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\\n\\n" +
            "event: content_block_delta\\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) + "\\n\\n" +
            "event: content_block_stop\\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\\n\\n" +
            "event: message_delta\\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) + "\\n\\n" +
            "event: message_stop\\ndata: " + JSON.stringify({ type: "message_stop" }) + "\\n\\n"
        );
    });
    const mainPort = await listen(mainServer);
    const sumServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { content: SUMMARY_TEXT }, finish_reason: "stop" }] }));
            }, 1000);
        });
    });
    const sumPort = await listen(sumServer);
    const mainUrl = "http://127.0.0.1:" + mainPort;
    const sumUrl = "http://127.0.0.1:" + sumPort;

    const store = new SessionStore({ enabled: true, dir, debounceMs: 50 });
    _setStoreForTest(store);
    setRegistryForTest({});
    process.env.E2E_ISSUE3978_SUM_KEY = "k";
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: mainUrl,
        routes: { [mainUrl]: { models: { "claude-small": { context: 12_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000, { compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: { injectTool: true, injectNudge: true, externalSummary: { enabled: true, targets: ["sum/sm"] } },
        namedProviders: { sum: { baseUrl: sumUrl, api: "openai", apiKeyEnv: "E2E_ISSUE3978_SUM_KEY", models: { sm: {} } } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    });
    await once(proxy, "listening");
    console.log("READY " + JSON.stringify({ port: (proxy.address() as { port: number }).port, mainUrl }));
    let last = -1;
    let durableReported = false;
    let affinityReported = false;
    let lastAffinityNudge = 0;
    setInterval(() => {
        const s = listSessions().find((x) => x.id === "t3978-p");
        const n = ((s && s.state.blocks) || []).filter((b) => b.active).length;
        if (n !== last) { last = n; console.log("[blocks] " + n); }
        // In-memory blocks are not durable. Envelopes are codec-framed at rest
        // (BILIENC1), so the test process cannot scan the file for the summary
        // mark itself; report durability through this store's own codec-aware
        // DISK read — the same reader path a fresh instance takes — and stop
        // polling once it has been observed.
        if (!durableReported && n >= 1) {
            const rec = store.loadSync("t3978-p");
            const dn = ((rec && rec.state.blocks) || []).filter((b) => b.active).length;
            if (dn >= 1) { durableReported = true; console.log("[durable] " + dn); }
        }
        // Second artifact: findResumeParent (#1486) matches the retry against
        // the parent's AFFINITY CHAIN entry, which a fresh instance hydrates
        // from stateDir()/prefix-affinity.json at boot — NOT from the session
        // record above. That snapshot rides its own 500ms-debounced single-shot
        // persist, whose write can lose a rename race on this machine-shared
        // file (writeSnapshot catches and gives up, nothing re-arms it) — so
        // verify the FILE carries t3978-p before reporting, and re-arm the
        // persist while it does not.
        if (!affinityReported) {
            try {
                const snap = JSON.parse(readFileSync(pth.join(stateDir(), "prefix-affinity.json"), "utf8"));
                const hit = Array.isArray(snap.entries) && snap.entries.some(
                    (e) => e && e.sessionId === "t3978-p" && typeof e.depth === "number" && typeof e.tailHash === "string" && Array.isArray(e.itemHashes));
                if (hit) { affinityReported = true; console.log("[affinity] ok"); }
                else if (Date.now() - lastAffinityNudge > 1000) { lastAffinityNudge = Date.now(); scheduleAffinityPersist(); }
            } catch { /* snapshot not on disk yet — keep polling */ }
        }
    }, 50);
}

main().catch((e) => { console.error("CHILD FAILED", e); process.exit(1); });
`;
}

test("#3978 T1: a client disconnect mid-preflight leaves the committed folds durable (rebuild-before-failfast ordering)", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const dir = mkdtempSync(path.join(tmpdir(), "issue3978-t1-"));
    const main = await startMainUpstream();
    const sum = await startSummaryUpstream(1000);
    const { proxy, store } = await startProxy(main.url, sum.url, 12_000, dir);
    try {
        const ac = new AbortController();
        fireAndForget(postTurn((proxy.address() as { port: number }).port, main.url, "t3978-a", conversation(40, "t3978a"), ac.signal));
        await waitFor(() => activeBlocks("t3978-a") >= 1, 60_000, "the first fold to commit");
        ac.abort();
        await waitFor(() => logs.some((l) => ABORT_LINE.test(l)), 30_000, "the abort fail-fast (preflight aborted … not forwarding)");
        // No explicit flush (#3978): the durable write must come from the
        // post-loop rebuild's own markDirty (src/server.ts:3554) riding the
        // store debounce — flushAllSessions() would mask a missing dirty-mark.
        await sleep(500);
        const loaded = store.loadSync("t3978-a");
        assert.ok(loaded, "the parent session must be loadable from disk after the client disconnected mid-preflight");
        const blocks = loaded.state.blocks ?? [];
        assert.ok(blocks.some((b) => b.active), `at least one active block must have persisted (got ${blocks.length} block(s))`);
        assert.ok(JSON.stringify(blocks).includes(SUMMARY_MARK), "the persisted block must carry the summary content");
    } finally {
        setLogCapture(null);
        delete process.env.E2E_ISSUE3978_SUM_KEY;
        await closeServer(proxy);
        await closeServer(main.server);
        await closeServer(sum.server);
    }
});

test("#3978 T2: a disconnect before any fold commits persists no fold state (negative control)", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const dir = mkdtempSync(path.join(tmpdir(), "issue3978-t2-"));
    const main = await startMainUpstream();
    // 15s per summary call: no response can land before the 150ms abort, so
    // ZERO folds can commit — yet the request still enters the preflight loop.
    const sum = await startSummaryUpstream(15_000);
    const { proxy, store } = await startProxy(main.url, sum.url, 12_000, dir);
    try {
        const ac = new AbortController();
        fireAndForget(postTurn((proxy.address() as { port: number }).port, main.url, "t3978-c", conversation(40, "t3978c"), ac.signal));
        await sleep(150);
        ac.abort();
        await waitFor(() => logs.some((l) => ABORT_LINE.test(l)), 30_000, "the abort fail-fast (preflight aborted … not forwarding)");
        // Same no-explicit-flush discipline as T1 (#3978).
        await sleep(500);
        const loaded = store.loadSync("t3978-c");
        const blocks = loaded?.state.blocks ?? [];
        assert.equal(
            blocks.filter((b) => JSON.stringify(b).includes(SUMMARY_MARK)).length,
            0,
            "no fold may be recorded when none was committed",
        );
    } finally {
        setLogCapture(null);
        delete process.env.E2E_ISSUE3978_SUM_KEY;
        await closeServer(proxy);
        await closeServer(main.server);
        await closeServer(sum.server);
    }
});

test("#3978 T3: a hard process death mid-preflight still leaves durable folds a new-id retry inherits", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const dir = mkdtempSync(path.join(tmpdir(), "issue3978-t3-"));
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    // Bare specifiers (acp-kernel) must resolve for the child script living in
    // the tmp dir: link the repo's node_modules beside it; `--import tsx`
    // resolves against cwd, so spawn from the repo root.
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    // Explicit ESM marker beside the child script: on CI the tmp dir sits OUTSIDE
    // the repo tree, so no package.json is found walking up and Node defaults the
    // .ts child to CJS — its bare `import "acp-kernel"` then resolves under the
    // `require` condition, which acp-kernel's exports map lacks → instant death
    // with ERR_PACKAGE_PATH_NOT_EXPORTED (observed on all three CI legs #3978).
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }) + "\n");
    // .ts (not .mjs): tsx transforms .ts but loads .mjs as plain JS.
    const childScript = path.join(dir, "child-proxy.ts");
    // Trailing slash: pathToFileURL omits it for directories, and the child's
    // imports concatenate file names onto this base.
    writeFileSync(childScript, childProxySource(`${pathToFileURL(path.join(repoRoot, "src")).href}/`, dir));
    const child = spawn(process.execPath, ["--import", "tsx", childScript], {
        cwd: repoRoot,
        env: { ...process.env, E2E_ISSUE3978_SUM_KEY: "k" },
        // stderr captured in-memory, not inherited: CI shard logs interleave
        // concurrent test files, so an unattributable child crash would be
        // undiagnosable; its tail is surfaced in the failure message below.
        stdio: ["ignore", "pipe", "pipe"],
    });
    let errTail = "";
    child.stderr?.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-8192); });
    const msgs = conversation(40, "t3978p");
    let blocksSeen = 0;
    let durableSeen = 0;
    let affinitySeen = false;
    let readyRes: ((v: { port: number; mainUrl: string }) => void) | null = null;
    const readyP = new Promise<{ port: number; mainUrl: string }>((r) => { readyRes = r; });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            const mReady = line.match(/^READY (.*)$/);
            if (mReady) { readyRes?.(JSON.parse(mReady[1])); continue; }
            const mBlocks = line.match(/^\[blocks\] (\d+)$/);
            if (mBlocks) blocksSeen = Math.max(blocksSeen, Number(mBlocks[1]));
            const mDurable = line.match(/^\[durable\] (\d+)$/);
            if (mDurable) durableSeen = Math.max(durableSeen, Number(mDurable[1]));
            if (/^\[affinity\] ok$/.test(line)) affinitySeen = true;
        }
    });
    let i2: Awaited<ReturnType<typeof startProxy>> | null = null;
    let main2: Awaited<ReturnType<typeof startMainUpstream>> | null = null;
    let sum2: Awaited<ReturnType<typeof startSummaryUpstream>> | null = null;
    try {
        // 180s, not 60s: the child cold-transforms the whole src tree via tsx,
        // which exceeds 60s under parallel-shard load (observed ubu22-1/win22-1
        // at head 9be2ec603); diedP fails fast if the child crashes before READY.
        const diedP = new Promise<null>((r) => { child.on("exit", () => r(null)); });
        const ready = await Promise.race([readyP, diedP, sleep(180_000).then(() => null)]);
        assert.ok(ready, `the child proxy must become ready (child stderr tail:\n${errTail.trim() || "(empty)"})`);
        fireAndForget(postTurn(ready.port, ready.mainUrl, "t3978-p", msgs));
        await waitFor(() => blocksSeen >= 1, 60_000, "the child's first committed fold");
        // Wait for the durable artifact itself, not a guessed settle time: the
        // per-fold markDirty rides the store's trailing debounce (debounceMs=50),
        // and under loaded CI runners a fixed sleep can expire before the
        // debounced write lands (observed windows 22-1 at head 5722ac70c: the
        // retry found NO parent record at all). `[durable] N` means the CHILD'S
        // OWN store.loadSync — a codec-aware disk read through the same reader
        // path a fresh instance takes — already sees N active blocks, i.e. the
        // write #3978 promises has landed; the death then cannot race it.
        const tDurable = Date.now();
        while (durableSeen < 1) {
            if (Date.now() - tDurable > 60_000) throw new Error(
                `timeout waiting for the per-fold save to land on disk (child stderr tail:\n${errTail.trim() || "(empty)"}\nstore dir listing: ${(() => { try { return JSON.stringify(readdirSync(dir)); } catch (e) { return String(e); } })()})`);
            await sleep(50);
        }
        // Second artifact (#1486/#499): the parent's affinity-chain entry in
        // the machine-shared state-dir snapshot — findResumeParent's candidate
        // source, which a fresh instance hydrates at boot. The record above is
        // useless for inheritance without it (win22-1 @ a46fd0d1a: [durable]
        // observed, then resume lines empty and the retry recompressed from
        // zero). The child proves the FILE carries the entry before reporting.
        const tAffinity = Date.now();
        while (!affinitySeen) {
            if (Date.now() - tAffinity > 60_000) throw new Error(
                `timeout waiting for the parent's affinity chain to land in the state-dir prefix-affinity.json snapshot (child stderr tail:\n${errTail.trim() || "(empty)"})`);
            await sleep(50);
        }
        child.kill("SIGKILL");
        await once(child, "exit");
        // A fresh boot over the SAME store dir — the retry arrives under a NEW
        // client-provided session id, exactly like the reporter's client.
        main2 = await startMainUpstream();
        sum2 = await startSummaryUpstream(1000);
        i2 = await startProxy(main2.url, sum2.url, 12_000, dir);
        // The retry replays the FULL parent history plus one new turn: a
        // byte-exact EQUAL-depth replay under a different id is a duplicate
        // conversation by design (#1486), not a resume — only a strictly
        // deeper history matches findResumeParent.
        const r = await postTurn((i2.proxy.address() as { port: number }).port, main2.url, "t3978-q", [...msgs, { role: "user", content: "t3978p continue after the aborted attempt" }]);
        assert.equal(r.status, 200, "the retry attempt must converge to a forward");
        void r.body?.cancel().catch(() => undefined);
        // On failure, distinguish "no parent record on disk" from "record
        // present but not adopted" without re-running the whole scenario.
        const dirListing = (() => { try { return JSON.stringify(readdirSync(dir)); } catch (e) { return String(e); } })();
        const tail = logs.filter((l) => l.includes("t3978-q"));
        const resumeLines = tail.filter((l) => l.includes("[resume-inheritance]"));
        const inheritLine = resumeLines.find((l) => l.includes("inherited"));
        assert.ok(inheritLine, `instance 2 must resume the persisted parent (resume lines: ${JSON.stringify(resumeLines)}; affinity chain seen before kill: ${affinitySeen}; store dir at retry time: ${dirListing}; child stderr tail:\n${errTail.trim().slice(-2000) || "(empty)"})`);
        const bm = inheritLine.match(/(\d+) block\(s\)/);
        assert.ok(bm && Number(bm[1]) >= 1, `at least one block must have been adopted (${inheritLine})`);
        assert.ok(!tail.some((l) => l.includes("parent session is not loadable")), "the pre-fix 'starting fresh' degrade must not fire");
        assert.ok(activeBlocks("t3978-q") >= 1, "the adopted blocks must be live in the retry session");
    } finally {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        if (i2) await closeServer(i2.proxy);
        if (main2) await closeServer(main2.server);
        if (sum2) await closeServer(sum2.server);
        setLogCapture(null);
        delete process.env.E2E_ISSUE3978_SUM_KEY;
    }
});
