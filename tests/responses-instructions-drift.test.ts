import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";

// #2668: hermetic XDG roots, set BEFORE importing anything from src/ (the
// auto-restart.test.ts pattern — several src modules capture XDG-derived
// paths at import time: update.ts throttle/lock files, registry.ts CACHE_FILE,
// restart.ts MARKER_FILE). startServer() additionally hydrates the
// machine-global prefix-affinity snapshot on boot and persists it back on
// debounce. Without this isolation, a prior run's persisted chain under one
// of the FIXED ids below (the raw id recorded at its final depth 7) survives
// into the next run, where the append-only tracking discipline never shrinks
// it; the drift turn then sees stored depth 7 > incoming 5, persona-anchor
// migration reads "history does not continue" and forks |sub:<fp> —
// deterministically red on any machine that has ever run this suite, green on
// fresh CI runners regardless of Node version.
const xdgRoot = mkdtempSync(path.join(os.tmpdir(), "bili-instr-drift-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetSessionsForTest } = await import("../src/session.ts");
const { conversationHeaderSource, instructionsFingerprintApplies } = await import("../src/session-id.ts");
const { resetPersonaAnchorsForTest } = await import("../src/persona-anchor.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

// #1102: opencode's system-context reconcile rewrites `instructions` whenever
// AGENTS.md is edited mid-session. Its conversation ids are persona-scoped
// (one session id per persona; task-tool subagents mint fresh child ids), so
// same-id + drifted instructions must NOT fork the compression namespace.
// #1106 inverts the default: the fingerprint is an allowlist (codex +
// claude-over-Responses only); everyone else keys verbatim.

test("instructionsFingerprintApplies: codex traffic keeps the fingerprint (#150)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-codex-turn-metadata": '{"thread_source":"user","thread_id":"t-1"}', "thread-id": "t-1", "session-id": "sess-150" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-codex-turn-metadata": "not-json", "session-id": "sess-150" }), true);
    assert.equal(instructionsFingerprintApplies({ "user-agent": "codex_cli_rs/0.147.0 (Ubuntu)", "session-id": "sess-150" }), true);
});

test("instructionsFingerprintApplies: claude-over-Responses keeps the fingerprint (#970)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "uuid-1" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "uuid-1", "x-session-affinity": "ses_abc" }), true);
    // only counts when the claude header WINS the walk — an outranking plugin
    // conversation id moves the request onto the verbatim default
    assert.equal(instructionsFingerprintApplies({ "x-bili-plugin": "host", "x-bili-plugin-conversation": "c-1", "x-claude-code-session-id": "uuid-1" }), false);
});

test("instructionsFingerprintApplies: everyone else keys verbatim (#1106)", () => {
    assert.equal(instructionsFingerprintApplies({ "x-session-affinity": "ses_abc123XYZ" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-opencode-session": "zen-sess-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-session-id": "generic-relay-client-7" }), false);
    assert.equal(instructionsFingerprintApplies({ "session-id": "thread-9" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-grok-session-id": "gr-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "x-mavis-session-id": "mc-1" }), false);
    assert.equal(instructionsFingerprintApplies({ "user-agent": "CherryStudio/1.0", "x-session-id": "cs-1" }), false);
    // the lenient codex substring fallback stays case-sensitive (#645/#1106),
    // so relays with "Codex"-shaped UAs are not pulled back into the fingerprint
    // (only known codex prefixes match case-insensitively, #1169)
    assert.equal(instructionsFingerprintApplies({ "user-agent": "CodeXchange/1.0", "x-session-id": "cx-1" }), false);
    assert.equal(instructionsFingerprintApplies({}), false);
});

test("instructionsFingerprintApplies: plugin declaration flag is vestigial (#1106)", () => {
    const base = { "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "c-1", "x-bili-plugin-instructions-mutable": "1" };
    assert.equal(instructionsFingerprintApplies(base), false);
    assert.equal(instructionsFingerprintApplies({ ...base, "x-bili-plugin-instructions-mutable": undefined }), false);
    assert.equal(instructionsFingerprintApplies({ "x-bili-plugin": "future-host", "x-bili-plugin-conversation": "c-2", "x-bili-plugin-instructions-mutable": "1" }), false);
});

test("conversationHeaderSource: reports the winning header with priority order intact", () => {
    assert.deepEqual(conversationHeaderSource({ "x-bili-plugin": "pi", "x-bili-plugin-conversation": "p1", "x-session-affinity": "ses_z" }), { name: "x-bili-plugin-conversation", value: "p1" });
    assert.deepEqual(conversationHeaderSource({ "x-session-affinity": " ses_a ", "x-session-id": "s-b" }), { name: "x-session-affinity", value: "ses_a" });
    assert.equal(conversationHeaderSource({ "x-bili-plugin-conversation": "orphan" }), undefined);
});

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", { response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } } });
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

function textEvents(delta: string): string {
    return [
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: delta }] }, output_index: 0 }),
    ].join("");
}

async function withProxy(upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse, bodies: string[]) => void, fn: (url: string, statsUrl: string, bodies: string[]) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            upstreamHandler(req, res, bodies);
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
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-drift-e2e": { context: 400_000 } } },
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
    try {
        await fn(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`, `http://127.0.0.1:${proxyPort}/__bili/stats`, bodies);
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

test("e2e #1102: opencode AGENTS.md edit (instructions drift) keeps ONE session and carries compression state", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const AFFINITY = "ses_drift_e2e";
    const INSTRUCTIONS_V1 = "You are OpenCode, the coding agent.\n\n# AGENTS.md\nBuild with npm.";
    const INSTRUCTIONS_V2 = "You are OpenCode, the coding agent.\n\n# AGENTS.md\nBuild with npm.\nUse pnpm for scripts.";
    const SEED_USER = "Kick off the working session.";
    const SEED_ASSISTANT = "Understood, starting now.";
    const TURN_1 = `DRIFT-FILLER-A ${"y".repeat(6000)}`;
    const TURN_2 = "DRIFT-FILLER-B acknowledged";
    // kernel refs are per-session snapshots assigned in render order:
    // m00001/m00002 = seed pair, m00003 = TURN_1, m00004 = TURN_2
    const REF_1 = "m00003";
    const REF_2 = "m00004";

    await withProxy((req, res, bodies) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (bodies.length === 1) {
            const compressArgs = JSON.stringify({
                content: [{ startId: REF_1, endId: REF_2, topic: "session setup", summary: "DRIFT-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
            });
            res.write(fcEvents(0, "call_d", "compress", compressArgs));
            res.write(completed(1600));
        } else {
            res.write(textEvents("post-edit answer"));
            res.write(completed(1700));
        }
        res.end();
    }, async (url, statsUrl, bodies) => {
        // The seed pair precedes the compress target because the kernel's
        // rebuildMessages pins the session's FIRST user message to the wire
        // even when covered by an active block — targeting it would leave raw
        // bytes on the wire and break the fold assertion below. Six medium
        // turns AFTER the target keep m00003/m00004 outside the kernel's
        // protected zone (last 5 messages AND last 5000 tokens), so the mock
        // compress call actually executes and folds them.
        const med = (i: number) => `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290);
        const baseInput = [
            { type: "message", role: "user", content: SEED_USER },
            { type: "message", role: "assistant", content: SEED_ASSISTANT },
            { type: "message", role: "user", content: TURN_1 },
            { type: "message", role: "assistant", content: TURN_2 },
            { type: "message", role: "user", content: med(5) },
            { type: "message", role: "assistant", content: med(6) },
            { type: "message", role: "user", content: med(7) },
            { type: "message", role: "assistant", content: med(8) },
            { type: "message", role: "user", content: med(9) },
            { type: "message", role: "assistant", content: med(10) },
        ];
        const req1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-session-affinity": AFFINITY }, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_V1, input: baseInput }) });
        assert.equal(req1.status, 200);
        await req1.text();
        assert.equal(bodies.length, 2, "original + post-compress re-request");

        const userEditsAgentsMd = "AGENTS.md edited mid-session: use pnpm for scripts (TURN-MARKER-1102)";
        const req2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-session-affinity": AFFINITY }, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_V2, input: [...baseInput, { type: "message", role: "user", content: userEditsAgentsMd }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 3);
        assert.ok(!bodies[2].includes("DRIFT-FILLER-A"), "compressed state carried across the instructions drift — no orphan re-seeding");
        assert.ok(!bodies[2].includes("DRIFT-FILLER-B"), "both folded messages are off the wire after the drift");
        assert.ok(bodies[2].includes("DRIFT-SUMMARY-SETUP"), "the folded summary renders in place of the compressed range");
        assert.ok(bodies[2].includes(userEditsAgentsMd), "the new turn is forwarded");

        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, "same logical conversation stays in ONE compression namespace despite instructions drift");
        assert.equal(stats.sessions[0].id, AFFINITY, "no |sub:<fp> fork");
    });
});

test("e2e #1106: plugin conversation without the mutable flag stays ONE session (flag is vestigial)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const CONVERSATION = "plg-drift-e2e";
    // no x-bili-plugin-instructions-mutable — under #1104 this forked; under
    // the #1106 allowlist default the plugin lane keys verbatim regardless
    const headers = { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": CONVERSATION };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("plugin lane answer"));
        res.write(completed(800));
        res.end();
    }, async (url, statsUrl, bodies) => {
        const input = [{ type: "message", role: "user", content: "initial turn" }];
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "persona v1", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "persona v1 with updated AGENTS.md section", input: [...input, { type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: "second turn" }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 2);
        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, "plugin lane keys verbatim; the mutable flag is no longer required");
        assert.equal(stats.sessions[0].id, CONVERSATION);
    });
});

test("e2e #1106: generic relay client (x-session-id) keeps ONE session across instructions drift", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const GENERIC_ID = "relay-client-conv-42";
    const headers = { "content-type": "application/json", "x-session-id": GENERIC_ID, "user-agent": "SomeRelayClient/2.3" };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("relay lane answer"));
        res.write(completed(800));
        res.end();
    }, async (url, statsUrl, bodies) => {
        const input = [{ type: "message", role: "user", content: "initial turn" }];
        // system prompt rewritten mid-conversation: software upgrade / plugin
        // install / AGENTS.md edit — the #1106 relay majority case
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "system prompt v1 (base)", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "system prompt v2 (upgraded, new plugin tools, AGENTS.md edited)", input: [...input, { type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: "second turn" }] }) });
        assert.equal(req2.status, 200);
        await req2.text();

        assert.equal(bodies.length, 2);
        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, "generic id + instructions drift = same conversation evolving, no fork");
        assert.equal(stats.sessions[0].id, GENERIC_ID);
    });
});

test("e2e #150: codex root thread reusing a task id across personas still splits by instructions fingerprint", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});

    const TASK_ID = "codex-task-id-9";
    const headers = {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.147.0",
        "session-id": TASK_ID,
        "x-codex-turn-metadata": JSON.stringify({ thread_source: "user", thread_id: "t-root" }),
        "thread-id": "t-root",
    };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("codex answer"));
        res.write(completed(700));
        res.end();
    }, async (url, statsUrl, _bodies) => {
        // #2250: the two tasks must differ in CONTENT, not just instructions —
        // continuity now keys on the message chain; a byte-identical payload
        // under new instructions is the SAME conversation evolving (migrate),
        // while #150's scenario is a genuinely fresh task reusing the id.
        const input = [{ type: "message", role: "user", content: "task A first turn" }];
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "task A persona instructions", input }) });
        assert.equal(req1.status, 200);
        await req1.text();
        const inputB = [{ type: "message", role: "user", content: "task B first turn (unrelated task reusing the id)" }];
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: "task B persona instructions (different task reusing the id)", input: inputB }) });
        assert.equal(req2.status, 200);
        await req2.text();

        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 2, "codex id-sharing personas stay split (#150 allowlist entry)");
        const ids = stats.sessions.map((s: { id: string }) => s.id).sort();
        assert.equal(ids[0], TASK_ID);
        assert.ok(ids[1].startsWith(`${TASK_ID}|sub:`), `forked namespace, got ${ids[1]}`);
    });
});

test("e2e #2250: codex instructions drift CARRIES the compression state across the migrate (fold survives)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    resetPersonaAnchorsForTest();

    const TASK_ID = "codex-task-id-2250-fold";
    const headers = {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.147.0",
        "session-id": TASK_ID,
        "x-codex-turn-metadata": JSON.stringify({ thread_source: "user", thread_id: "t-root-2250f" }),
        "thread-id": "t-root-2250f",
    };
    const INSTRUCTIONS_A = "You are Codex, the main agent (model: gpt-5.3).";
    const INSTRUCTIONS_B = "You are Codex, the main agent (model: glm-5.3). Workspace guidance updated.";
    const SEED_USER = "Kick off the working session.";
    const SEED_ASSISTANT = "Understood, starting now.";
    const TURN_1 = `FOLD2250-A ${"y".repeat(6000)}`;
    const TURN_2 = "FOLD2250-B acknowledged";
    // Same ref discipline as the #1102 case above: kernel refs are per-session
    // render-order snapshots — m00001/m00002 = seed pair, m00003/m00004 = fold
    // targets, and the six medium turns keep them outside the protected zone.
    const REF_1 = "m00003";
    const REF_2 = "m00004";

    await withProxy((_req, res, bodies) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (bodies.length === 1) {
            const compressArgs = JSON.stringify({
                content: [{ startId: REF_1, endId: REF_2, topic: "session setup", summary: "FOLD2250-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK" }],
            });
            res.write(fcEvents(0, "call_d", "compress", compressArgs));
            res.write(completed(1600));
        } else {
            res.write(textEvents("post-drift answer"));
            res.write(completed(1700));
        }
        res.end();
    }, async (url, statsUrl, bodies) => {
        const med = (i: number) => `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290);
        const baseInput = [
            { type: "message", role: "user", content: SEED_USER },
            { type: "message", role: "assistant", content: SEED_ASSISTANT },
            { type: "message", role: "user", content: TURN_1 },
            { type: "message", role: "assistant", content: TURN_2 },
            { type: "message", role: "user", content: med(5) },
            { type: "message", role: "assistant", content: med(6) },
            { type: "message", role: "user", content: med(7) },
            { type: "message", role: "assistant", content: med(8) },
            { type: "message", role: "user", content: med(9) },
            { type: "message", role: "assistant", content: med(10) },
        ];
        const req1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_A, input: baseInput }) });
        assert.equal(req1.status, 200);
        await req1.text();
        assert.equal(bodies.length, 2, "original + post-compress re-request");

        // Model switch: instructions drift, history fully replayed + one new
        // turn. The anchor must MIGRATE — the folded block stays on the raw
        // key instead of the conversation re-folding from zero on |sub:.
        const newTurn = "model switched to glm-5.3 — continue the task (TURN-MARKER-2250)";
        const req2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions: INSTRUCTIONS_B, input: [...baseInput, { type: "message", role: "user", content: newTurn }] }) });
        assert.equal(req2.status, 200);
        await req2.text();
        assert.equal(bodies.length, 3);

        assert.ok(!bodies[2].includes("FOLD2250-A"), "folded message stays off the wire across the instructions drift");
        assert.ok(!bodies[2].includes("FOLD2250-B"), "both folded messages are off the wire after the drift");
        assert.ok(bodies[2].includes("FOLD2250-SUMMARY"), "the folded summary renders in place of the compressed range — compression state CARRIED");
        assert.ok(bodies[2].includes(newTurn), "the new turn is forwarded");

        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, "the drifted turn must NOT have forked a second session");
        assert.equal(stats.sessions[0]!.id, TASK_ID, "the fold stays on the raw key");
    });
});

test("e2e #2250: claude-over-Responses instructions drift with continuing history keeps ONE session (#970 lane)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    resetPersonaAnchorsForTest();

    const CLAUDE_ID = "claude-code-uuid-2250";
    const headers = { "content-type": "application/json", "x-claude-code-session-id": CLAUDE_ID };
    const INSTRUCTIONS_A = "You are Claude Code, the main agent.";
    const INSTRUCTIONS_B = "You are Claude Code, the main agent. (claude-code upgraded — reassembled system)";

    const user = (n: number) => ({ type: "message", role: "user", content: [`turn ${n}: continue`] });
    const assistant = (n: number) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n}` }] });
    const post = async (url: string, instructions: string, input: unknown[]) => {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions, input }) });
        assert.equal(res.status, 200);
        await res.text();
    };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("claude answer"));
        res.write(completed(700));
        res.end();
    }, async (url, statsUrl) => {
        await post(url, INSTRUCTIONS_A, [user(1)]);
        await post(url, INSTRUCTIONS_A, [user(1), assistant(1), user(2)]);
        // upgrade reassembly: instructions drift, history continues → migrate
        await post(url, INSTRUCTIONS_B, [user(1), assistant(1), user(2), assistant(2), user(3)]);
        await post(url, INSTRUCTIONS_B, [user(1), assistant(1), user(2), assistant(2), user(3), assistant(3), user(4)]);

        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, `claude-over-Responses drift with continuing history keeps ONE session (got ${JSON.stringify(stats.sessions.map((x) => x.id))})`);
        assert.equal(stats.sessions[0]!.id, CLAUDE_ID, "no |sub:<fp> fork on the claude lane");
    });
});

test("e2e #2250: codex instructions drift with CONTINUING history keeps ONE session (model switch / AGENTS.md edit)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    resetPersonaAnchorsForTest();

    const TASK_ID = "codex-task-id-2250";
    const headers = {
        "content-type": "application/json",
        "user-agent": "codex_cli_rs/0.147.0",
        "session-id": TASK_ID,
        "x-codex-turn-metadata": JSON.stringify({ thread_source: "user", thread_id: "t-root-2250" }),
        "thread-id": "t-root-2250",
    };
    const INSTRUCTIONS_A = "You are Codex, the main agent (model: gpt-5.3).";
    const INSTRUCTIONS_B = "You are Codex, the main agent (model: glm-5.3). \nWorkspace guidance updated.";

    const user = (n: number) => ({ type: "message", role: "user", content: [`turn ${n}: please continue the task`] });
    const assistant = (n: number) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: `assistant answer ${n}` }] });
    const post = async (url: string, instructions: string, input: unknown[]) => {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-drift-e2e", stream: true, instructions, input }) });
        assert.equal(res.status, 200);
        await res.text();
    };

    await withProxy((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(textEvents("codex answer"));
        res.write(completed(700));
        res.end();
    }, async (url, statsUrl) => {
        // Turn 1-2 on instructions A: grow the conversation (full replay each
        // turn — the codex shape).
        await post(url, INSTRUCTIONS_A, [user(1)]);
        await post(url, INSTRUCTIONS_A, [user(1), assistant(1), user(2)]);

        // Turn 3: instructions drift (model switch / AGENTS.md edit), history
        // fully replayed and continued. Must NOT fork — the anchor migrates.
        await post(url, INSTRUCTIONS_B, [user(1), assistant(1), user(2), assistant(2), user(3)]);

        // Turn 4: still instructions B — plain match on the migrated anchor.
        await post(url, INSTRUCTIONS_B, [user(1), assistant(1), user(2), assistant(2), user(3), assistant(3), user(4)]);

        const stats = (await (await fetch(statsUrl)).json()) as { sessions: Array<{ id: string }> };
        assert.equal(stats.sessions.length, 1, `instructions drift with continuing history must keep ONE session (got ${JSON.stringify(stats.sessions.map((x) => x.id))})`);
        assert.equal(stats.sessions[0]!.id, TASK_ID, "the session stays on the raw key — no |sub: fork");
    });
});
