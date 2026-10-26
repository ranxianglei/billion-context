// #2451 review fix (M1): the /v1/responses lane had the #2372 codex
// local-compaction rebase but NOT the #2432 dsh variant — yet
// CONFIGURATION.md names responses "the lane dsh desktop's compaction
// actually rides" (#2360). Before the fix, a dsh-bound session replaying
// [checkpoint summary, retained tail…] on this wire fell back into the
// pre-#2432 death spiral: partially-alive blocks, self-destructing fold
// anchors, every later compress "cannot be anchored". The responses lane
// now runs the same detector as the openai lane (prepare-responses.ts):
// dsh-bound session + checkpoint framing in resent history + decimated
// fold coverage → rebase in the SAME turn.
//
// Harness note: plugin mode suppresses wire tool injection and the
// compress loop never intercepts proxy-named tool calls (handle.ts "Plugin
// mode (issue #1)") — folds on this lane are driven through the plugin's
// own channel, POST /__bili/plugin/tool, exactly like the openai #2432
// fixture. The upstream here is a plain SSE responder.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX } from "../src/codex-compact.ts";

// Same SSE upstream as the codex #2372 fixture. With modelFold=true the
// first (seed) turn returns a compress function_call — that path only lands
// for NON-plugin sessions (plugin mode suppresses the compress loop), so a
// plain-UA negative can seed a fold without the plugin tool channel.
function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

// 14 messages at ~1100 tokens each (~15.4K total, under the 30K window —
// preflight stays off for the seed turn). Kernel protects the last 5
// messages, so folding m00001–m00009 covers 9 raw ids — above the 8-id
// dsh detection floor, decimated by the compacted replay.
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

// The dsh compaction-basic replay shape, framed exactly like the openai
// #2432 fixture: preamble + <compacted-summary> open tag in the first
// resent message.
function checkpointInput() {
    return [
        {
            type: "message",
            role: "user",
            content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
        },
        seedInput()[12],
        seedInput()[13],
    ];
}

type Harness = {
    url: string;
    pluginToolUrl: string;
    bodies: string[];
    close: () => Promise<void>;
};

async function startHarness(modelFold = false): Promise<Harness> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (modelFold && bodies.length === 1) {
                res.write(fcEvents("call_p", JSON.stringify({ content: [{ startId: "m00001", endId: "m00009", topic: "folded head", summary: FOLD_SUMMARY }] })));
            }
            res.write(completed(800));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool: true, injectNudge: true },
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
    });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function dshHeaders(conv: string): Record<string, string> {
    // The plugin stamps bind the session to agent "dsh" (handle.ts identity
    // path — same headers as the openai lane's #2432 fixture).
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function dshSession(conv: string) {
    return listSessions().find((x) => x.meta.label === conv || x.metadata.pluginAgent === "dsh");
}

async function seedFoldedSession(h: Harness, conv: string): Promise<void> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: seedInput() }),
    });
    assert.equal(r.status, 200, "seed request succeeds");
    await r.text();
    const s = dshSession(conv);
    assert.ok(s, "seed session exists and is dsh-bound");
    assert.equal(s!.metadata.pluginAgent, "dsh", "pluginAgent stamped on the responses lane");
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= 14, "refs assigned to the seeded history");

    // Plugin mode: the fold rides the plugin tool channel (see header note).
    const r2 = await fetch(h.pluginToolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", topic: "folded head", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

test("e2e #2451: dsh replaying [checkpoint, retained tail] on /v1/responses rebases the ACP state instead of drifting", async () => {
    const h = await startHarness();
    const conv = "dshc-resp-main";
    try {
        await seedFoldedSession(h, conv);
        const before = dshSession(conv)!;
        const coveredBefore = new Set(before.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, `seed fold covers >=8 ids (got ${coveredBefore.size})`);

        const r = await fetch(h.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: checkpointInput() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = dshSession(conv)!;
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "no active blocks survive the rebase");
        assert.equal((s.state.blocks ?? []).length, 0, "block list is empty after the boundary reset");
        // #2592/F5: 3 re-seeded entries + the pinned ref floor.
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 4, "refs were re-seeded onto exactly the compacted view (checkpoint + 2 retained + ref-floor)");
        assert.ok(s.metadata.nativeCompactionBoundary, "native-compaction boundary is recorded");
        assert.equal((s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean }).pendingRebase, false, "rebase consumed within the same request");
        assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");

        const events = conflictEventsOf(s);
        assert.ok(events.some((e) => e.kind === "native-compaction"), "classified as native-compaction in the conflict ledger");

        // The compacted view actually reached the upstream.
        const forward = h.bodies[h.bodies.length - 1];
        assert.ok(forward.includes(DSH_CHECKPOINT_OPEN_TAG), "checkpoint framing forwarded upstream");
        assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: [...checkpointInput(), { type: "message", role: "user", content: "Post-compaction turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = dshSession(conv)!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 5, "refs accumulate append-only after the rebase");
    } finally {
        await h.close();
    }
});

test("negative #2451: dsh binding + checkpoint framing but INTACT history does NOT rebase (paste-the-template analog)", async () => {
    const h = await startHarness();
    const conv = "dshc-resp-neg";
    try {
        await seedFoldedSession(h, conv);
        // Framing present, session dsh-bound, but the resent history is the
        // FULL seed — no decimated coverage, no gap: the detector must stay
        // quiet (a user pasting checkpoint text is not a compaction).
        const r = await fetch(h.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: [...checkpointInput(), ...seedInput().slice(0, 12)] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = dshSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded when coverage is intact");
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "the live fold survives the framing-bearing turn");
    } finally {
        await h.close();
    }
});

test("negative #2451: decimated checkpoint replay on a session that was NEVER dsh-bound does NOT rebase", async () => {
    // pluginAgent is sticky per session (handle.ts re-stamps from metadata
    // on every request), so "no dsh binding" must be pinned by seeding a
    // session that was never bound at all. The fold rides the model's own
    // compress function_call (the non-plugin path the codex #2372 fixture
    // uses), then the compacted replay arrives with checkpoint framing.
    const h = await startHarness(true);
    const conv = "dshc-resp-neverbound";
    try {
        const r1 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "TraeCode/2.4.3 (Linux; x86_64)" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: seedInput() }),
        });
        assert.equal(r1.status, 200, "seed request succeeds");
        await r1.text();
        const s0 = listSessions().find((x) => x.meta.label === conv)!;
        assert.ok(s0, "seed session exists");
        assert.equal(s0.metadata.pluginAgent, undefined, "session is not plugin-bound");
        const covered = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(covered.size >= 8, `model-driven fold covers >=8 ids (got ${covered.size})`);

        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "TraeCode/2.4.3 (Linux; x86_64)" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: conv, instructions: "You are the test coding agent.", input: checkpointInput() }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded without the dsh binding");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length > 4, `ref map not re-seeded (got ${Object.keys(s.state.messageRefs.byRaw).length} ids — a rebase would leave exactly 4)`);
    } finally {
        await h.close();
    }
});

test("negative #2451: dsh binding with the codex template (wrong producer) does NOT rebase via the dsh lane", async () => {
    const h = await startHarness();
    const conv = "dshc-resp-codextmpl";
    try {
        await seedFoldedSession(h, conv);
        // dsh-bound session replaying the CODEX summary template: the dsh
        // detector must not match foreign framing, and the codex detector
        // must not match a non-codex client — decimated coverage alone
        // stays on the existing churn paths.
        const r = await fetch(h.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: "gpt-resp",
                stream: true,
                session_id: conv,
                instructions: "You are the test coding agent.",
                input: [
                    { type: "message", role: "user", content: `${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX} of the conversation so far, as context for continuing. The work established the test harness, drove one fold, and then codex compacted locally. Continue with the retained tail.` },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = dshSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded for foreign framing on a dsh-bound session");
    } finally {
        await h.close();
    }
});
