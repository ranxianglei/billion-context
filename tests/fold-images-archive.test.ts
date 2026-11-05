import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions } from "../src/session.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// A real 1x1 PNG — small, decodable, byte-comparable against what spills to disk.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

type Captured = { url: string; body: Buffer };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// #2607: archivable media folds BY DEFAULT — its pixels must therefore be
// archived by mNNNNN ref on EVERY session, or a
// fold destroys them unrecoverably. Two passes: entry-time (messages that
// already have refs) and post-prepare (messages whose ref was assigned during
// this turn's prepare — e.g. a freshly-sent image). No wire-side stripping
// happens at all: until a fold fires, the forwarded body keeps the image part.
test("default config archives inbound images by ref without stripping", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const stateRoot = join(tmpdir(), `bili-fold-img-${process.pid}-${Date.now()}`);
    mkdirSync(stateRoot, { recursive: true });
    process.env.XDG_STATE_HOME = stateRoot;
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", body: Buffer.concat(chunks) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "resp_test", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const img = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", detail: "high" };
    const msg = (id: string, content: unknown[]) => ({ type: "message", id, status: "completed", role: "user", content });
    const dir = join(stateRoot, "billion-context", "retrieve", "img", "fold-archive-1");
    try {
        // Turn 1: a single image message. It has NO ref at entry time, so only
        // the post-prepare refresh can archive it — if the spill file exists
        // after this request, both the always-on gate and the post-prepare
        // pass are proven.
        const r1 = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "fold-archive-1", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: false, input: [msg("a1", [{ type: "input_text", text: "look" }, img])] }),
        });
        assert.equal(r1.status, 200);
        await r1.arrayBuffer();
        const files1 = readdirSync(dir);
        assert.equal(files1.length, 1);
        assert.match(files1[0], /^m\d+-[0-9a-f]{8}\.png$/);
        // No wire-side strip: the forwarded body still carries the image part.
        assert.ok(JSON.stringify(JSON.parse(captured[0].body.toString("utf8")).input).includes('"input_image"'));

        // Turn 2: the client re-sends history plus one text message. The
        // entry-time pass now sees the archived message's ref; skip-if-exists
        // keeps exactly one file (no duplicates from the second indexing).
        const r2 = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { authorization: "Bearer k", "session-id": "fold-archive-1", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: false, input: [msg("a1", [{ type: "input_text", text: "look" }, img]), msg("a2", [{ type: "input_text", text: "more" }])] }),
        });
        assert.equal(r2.status, 200);
        await r2.arrayBuffer();
        const files2 = readdirSync(dir);
        assert.deepEqual(files2, files1);
    } finally {
        delete process.env.XDG_STATE_HOME;
        rmSync(stateRoot, { recursive: true, force: true });
        await close(proxy);
        await close(upstream);
    }
});

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session with screenshots. Key decisions: archive-then-fold. Files touched: src/a.ts:10. Outcome: fixed and verified by tests.";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// The closed loop #2607 promises: a fold removes the
// pixels from the wire (they live on disk, keyed by the mNNNNN ref that rides
// the summary placeholder) — and decompress({ imageRef }) walks the REAL
// always-on index of a REAL post-fold session to hand them back. Everything
// upstream of this test proves pieces; this one proves the whole round trip:
// wire fold → placeholder ref → spilled file → decompress → identical bytes.
test("default fold → decompress({ imageRef }) restores the archived pixels end to end", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const stateRoot = join(tmpdir(), `bili-fold-restore-${process.pid}-${Date.now()}`);
    mkdirSync(stateRoot, { recursive: true });
    process.env.XDG_STATE_HOME = stateRoot;
    const summaryBodies: unknown[] = [];
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw) as { stream?: boolean };
            if (parsed.stream === false) {
                summaryBodies.push(parsed);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: SUMMARY_TEXT }));
                return;
            }
            forwards.push(raw);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(1000));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const img = { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}`, detail: "high" };
    const msg = (role: "user" | "assistant", content: unknown[]) => ({ type: "message", role, content });
    try {
        // Text-only opener: nothing for the first-user pin to hold, so a fold
        // must remove EVERY image byte from the wire (not all but one).
        const input: unknown[] = [
            msg("user", [{ type: "input_text", text: "session opener" }]),
            msg("assistant", [{ type: "output_text", text: "Message 0 of the long conversation." }]),
            msg("user", [{ type: "input_text", text: "here is the failing screen" }, img]),
        ];
        for (let i = 1; i < 12; i++) {
            input.push(msg(i % 2 === 0 ? "user" : "assistant", [{ type: i % 2 === 0 ? "input_text" : "output_text", text: `Message ${i} of the long conversation. ${"filler_content_".repeat(200)}` }]));
        }
        const r = await fetch(`${base}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5", stream: true, session_id: "fold-restore-1", instructions: "You are the test coding agent.", input }),
        });
        assert.equal(r.status, 200, "oversized multimodal session still succeeds");
        await r.text();

        assert.ok(summaryBodies.length >= 1, `preflight summarization ran (got ${summaryBodies.length})`);
        const all = summaryBodies.map((b) => JSON.stringify(b)).join("\n");
        // The summary input renders the folded image as its ref-carrying placeholder.
        const refMatch = all.match(/\[image: png 1x1 · (m\d{5})\]/);
        assert.ok(refMatch, `summary input carries the ref-carrying placeholder: ${all.slice(0, 400)}`);
        const ref = refMatch[1]!;
        assert.ok(!all.includes(PNG_B64.slice(0, 24)), "no image bytes leak into the summarize request");
        for (const fwd of forwards) {
            assert.ok(!fwd.includes(PNG_B64.slice(0, 24)), "no image bytes leak into any forward (text-only opener = nothing pinned)");
            assert.ok(fwd.includes(SUMMARY_TEXT), "the rebuilt payload carries the preflight summary");
        }

        // The always-on archive indexed the image by ref on the LIVE session.
        const session = listSessions().find((x) => x.meta.label === "fold-restore-1");
        assert.ok(session, "session exists");
        const indexed = session!.incomingImageIndex?.get(ref);
        assert.ok(indexed && indexed.length >= 1, `incomingImageIndex has ${ref}`);

        // decompress({ imageRef }) locates the spilled file and returns its path.
        const out = resolveDecompress({ imageRef: ref }, { core: createCore(), config: defaultConfig(10_000), messages: [], session: session!, log: () => {} });
        assert.equal(out.outcome, "success", `restore succeeded: ${out.text}`);
        assert.match(out.text, new RegExp(`\\[Restored 1 image\\(s\\) for ${ref}:`));
        const pathMatch = out.text.match(/\n  (\S+\.png)/);
        assert.ok(pathMatch, `restored path in receipt: ${out.text}`);
        // Byte-exact: the spilled pixels ARE the pixels the client sent.
        assert.equal(readFileSync(pathMatch[1]!).compare(PNG_BYTES), 0, "restored file is byte-identical to the original image");
    } finally {
        delete process.env.XDG_STATE_HOME;
        rmSync(stateRoot, { recursive: true, force: true });
        await close(proxy);
        await close(upstream);
    }
});

// #2607 on the Google wire: inlineData pixels ride `contents[].parts` — a fold
// must drop them from every REBUILT body while the client keeps re-sending
// them each turn, spill them by ref, and decompress({ imageRef }) must restore
// the bytes from the google session's index. The existing google e2e suite is
// all-text; this closes that lane for media.
type GooglePart = { text?: string; inlineData?: { mimeType: string; data: string }; functionCall?: { id?: string; name: string; args?: unknown } };

function readText(res: Response): Promise<string> {
    return res.text().then((raw) => {
        let text = "";
        for (const block of raw.split("\n\n")) {
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
                const ev = JSON.parse(line.slice(5).trim()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
                for (const cand of ev.candidates ?? []) for (const p of cand.content?.parts ?? []) if (typeof p.text === "string") text += p.text;
            } catch { /* ignore malformed frames */ }
        }
        return text;
    });
}

function googleFrame(parts: GooglePart[], finishReason: string | undefined, usage: Record<string, number>): string {
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    return `data: ${JSON.stringify({ candidates: [candidate], modelVersion: "gemini-test", usageMetadata: usage })}\n\n`;
}

const G_USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 1050 };

test("google wire: inlineData folds out of rebuilt contents, spills by ref, decompress restores the pixels", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const stateRoot = join(tmpdir(), `bili-fold-google-${process.pid}-${Date.now()}`);
    mkdirSync(stateRoot, { recursive: true });
    process.env.XDG_STATE_HOME = stateRoot;
    const bodies: string[] = [];
    let demanded = false;
    let shapeProblems = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            bodies.push(body);
            // light Gemini contract check on every rebuilt body: alternation + non-empty parts
            try {
                const parsed = JSON.parse(body) as { contents?: { role: string; parts: unknown[] }[] };
                let prev = "";
                for (const c of parsed.contents ?? []) {
                    if ((c.role === "user" || c.role === "model") && c.role !== prev) prev = c.role;
                    else shapeProblems++;
                    if (!Array.isArray(c.parts) || c.parts.length === 0) shapeProblems++;
                }
            } catch { shapeProblems++; }
            const refIds = [...body.matchAll(/<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g)].map((m) => m[1]!);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            // Demand only once the history runs well past the kernel's
            // soft-protected zone (defaultConfig: last 5 messages + last 5000
            // tokens + last user message). With ~1.4K-token fillers that zone
            // reaches back ~5 messages; demanding with an endpoint inside it
            // gets the tail EXCLUDED from the range (receipt: "Excluded 5
            // protected message(s) … recent/last-user zone") and the image
            // message stays visible. 20 refs and endId = len-8 keep the range
            // clear of the zone and the turn-3 image deep inside it.
            if (!demanded && Buffer.byteLength(body) > 8192 && refIds.length >= 20) {
                demanded = true;
                res.write(googleFrame([{ functionCall: { id: "fc_c1", name: "compress", args: { content: [{ startId: refIds[1]!, endId: refIds[refIds.length - 8]!, topic: "google image fold", summary: `${SUMMARY_TEXT} — ${refIds[1]!}..${refIds[refIds.length - 8]!}` }] } } }], undefined, G_USAGE));
                res.write(googleFrame([], "STOP", G_USAGE));
            } else {
                res.write(googleFrame([{ text: `model reply ${bodies.length}` }], undefined, G_USAGE));
                res.write(googleFrame([], "STOP", G_USAGE));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gemini-test": { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;
    const filler = (i: number) => `google turn ${i}: ${"the quick brown fox jumps over the lazy dog. ".repeat(120)}`;
    const contents: { role: "user" | "model"; parts: GooglePart[] }[] = [];
    try {
        for (let i = 1; i <= 14; i++) {
            const parts: GooglePart[] = [{ text: filler(i) }];
            if (i === 3) parts.push({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
            contents.push({ role: "user", parts });
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "google-img-1" },
                body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } }),
            });
            assert.equal(res.status, 200, `turn ${i}`);
            // Echo the text we actually received: a fabricated reply makes the
            // re-sent model turns fail content-hash matching every turn, which
            // re-assigns refs and churns the ref space (observed m0175 at turn 6).
            const got = await readText(res);
            contents.push({ role: "model", parts: [{ text: got || `model reply ${i}` }] });
        }
        assert.ok(demanded, "the mock demanded a compress");
        assert.equal(shapeProblems, 0, "every rebuilt Gemini body satisfies the light contract (alternating roles, non-empty parts)");
        // The client sent the inlineData on EVERY turn; pre-fold bodies carried it...
        assert.ok(bodies[0]!.includes(PNG_B64.slice(0, 24)) === false, "turn 1 has no image yet (image enters at turn 3)");
        const preFold = bodies.findIndex((b) => b.includes(PNG_B64.slice(0, 24)));
        assert.ok(preFold >= 0, "the image bytes reached the upstream before the fold");
        // ...and after the fold every rebuilt body drops them (#2607 on google wire).
        const demandIdx = bodies.findIndex((b) => b.includes("fc_c1") || (demanded && b.includes(SUMMARY_TEXT)));
        const foldReached = bodies.findIndex((b) => b.includes(SUMMARY_TEXT));
        assert.ok(foldReached > preFold, "the fold summary reached the upstream after the demand");
        for (let i = foldReached; i < bodies.length; i++) {
            assert.ok(!bodies[i]!.includes(PNG_B64.slice(0, 24)), `body ${i} (post-fold) must not carry the inlineData bytes — the client kept re-sending them`);
        }
        // Pixels spilled by ref; restore them through the google session.
        const session = listSessions().find((x) => x.meta.label === "google-img-1");
        assert.ok(session, "google session exists");
        const dir = join(stateRoot, "billion-context", "retrieve", "img", "google-img-1");
        const files = readdirSync(dir);
        assert.ok(files.length >= 1, `spill dir has files: ${files.join(", ")}`);
        const ref = files[0]!.split("-")[0]!;
        assert.match(ref, /^m\d+$/);
        assert.ok(session!.incomingImageIndex?.get(ref)?.length ?? 0 > 0, `google session index has ${ref}`);
        const out = resolveDecompress({ imageRef: ref }, { core: createCore(), config: defaultConfig(1_000_000), messages: [], session: session!, log: () => {} });
        assert.equal(out.outcome, "success", `restore succeeded: ${out.text}`);
        const pathMatch = out.text.match(/\n  (\S+\.png)/);
        assert.ok(pathMatch, `restored path in receipt: ${out.text}`);
        assert.equal(readFileSync(pathMatch[1]!).compare(PNG_BYTES), 0, "restored google-lane pixels are byte-identical");
        void demandIdx;
    } finally {
        delete process.env.XDG_STATE_HOME;
        rmSync(stateRoot, { recursive: true, force: true });
        await close(proxy);
        await close(upstream);
    }
});
