import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX } from "../src/codex-compact.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";

// Issue #4521 regression: codex configured for chat completions (wire_api=chat,
// or a declared providers[].protocol=openai outranking the URL heuristics,
// #1909) rides the OPENAI lane — never /v1/responses — so the #2372
// local-auto-compaction detector there cannot see its landings. Before this
// fix they fell into the generic unannounced-rewrite path: misclassified
// (unconfirmed-signal tier instead of handled native-compaction) and WITHOUT
// the immediate rebase — partially-alive blocks survived syncBlocks and only
// the #2695 zombie reap cleaned them up passes later, leaving a dead-anchor
// window in between. This suite pins the openai-lane parity: codex identity +
// the summary template heading a resent message + decimated fold coverage →
// record "native-compaction" AND rebase within the same request (same reset
// the responses lane performs, #2372).

const CODEX_UA = "codex_cli_rs/0.21.0 (Ubuntu 24.04; x86_64)";

function line(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(id: string, choices: unknown[], usage?: unknown): string {
    return line({ id, object: "chat.completion.chunk", created: 1, model: "gpt-resp", choices, ...(usage ? { usage } : {}) });
}

// 14 messages at ~1100 tokens each (~15.4K total, under the 30K window —
// preflight stays off for the seed turn). The kernel protects the last 5
// messages and a 5K-token tail, so with the first 9 at ~9.9K tokens they sit
// above the tail floor and the fold covers 9 raw ids — above the 8-id
// detection floor, decimated by the compacted replay (summary + last 2).
// Mirrors tests/codex-local-compaction.test.ts (responses lane).
function seedMessages() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function compactedMessages() {
    return [
        {
            role: "user",
            content: `${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX} of the conversation so far, as context for continuing. The work established the test harness, drove one fold, and then codex compacted locally. Continue with the retained tail.`,
        },
        seedMessages()[12],
        seedMessages()[13],
    ];
}

type Harness = {
    url: string;
    bodies: string[];
    close: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (bodies.length === 1) {
                // Seed turn: the model drives one fold over the head.
                const compressArgs = JSON.stringify({
                    content: [
                        {
                            startId: "m00001",
                            endId: "m00009",
                            topic: "folded head",
                            summary: "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK",
                        },
                    ],
                });
                res.write(chunk("c_seed", [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_cmp_seed", type: "function", function: { name: "compress", arguments: compressArgs } }] } }]));
                res.write(chunk("c_seed", [{ index: 0, delta: {}, finish_reason: "tool_calls" }], { prompt_tokens: 3000, completion_tokens: 2 }));
            } else {
                res.write(chunk(`c_${bodies.length}`, [{ index: 0, delta: { role: "assistant", content: "ok" } }]));
                res.write(chunk(`c_${bodies.length}`, [{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 800, completion_tokens: 2 }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
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
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
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

async function seedFoldedSession(h: Harness): Promise<void> {
    const r = await fetch(h.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": CODEX_UA, "x-acp-session": "codex-sess-a" },
        body: JSON.stringify({ model: "gpt-resp", stream: true, messages: seedMessages() }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const s = listSessions().find((x) => x.meta.label === "codex-sess-a");
    assert.ok(s, "seed session exists");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "seed session has an active fold");
}

test("e2e #4521: codex replaying [summary, retained tail] on the chat-completions wire rebases the ACP state and records native-compaction", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const before = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        const coveredBefore = new Set(before.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, `seed fold covers >=8 ids (got ${coveredBefore.size})`);

        // The compacted replay: same session id, codex UA, summary + retained
        // tail — on the OPENAI wire this time. Must succeed and must have
        // rebased (not drifted), recorded as handled native compaction.
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA, "x-acp-session": "codex-sess-a" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, messages: compactedMessages() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "no active blocks survive the rebase");
        assert.equal((s.state.blocks ?? []).length, 0, "block list is empty after the boundary reset");
        const byRawKeys = Object.keys(s.state.messageRefs.byRaw);
        // #2592/F5: 3 re-seeded entries + the pinned REF_FLOOR_RAW_ID (the
        // pre-rebase high-water mark must never be re-allocated onto new raw).
        assert.equal(byRawKeys.length, 4, "refs were re-seeded onto exactly the compacted view (summary + 2 retained + ref-floor)");
        assert.ok(s.metadata.nativeCompactionBoundary, "native-compaction boundary is recorded");
        assert.equal((s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean }).pendingRebase, false, "rebase consumed within the same request");
        assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");

        // #4521 classification pin: the ledger carries the HANDLED
        // native-compaction kind (not the unconfirmed-signal
        // unannounced-rewrite the pre-fix path recorded).
        const events = conflictEventsOf(s);
        const native = events.find((e) => e.kind === "native-compaction");
        assert.ok(native, "ledger records a native-compaction event");
        assert.ok(native!.detail.includes("codex local auto-compaction"), "event names the codex local auto-compaction");
        assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "no double-recorded unannounced-rewrite beside the handled event");

        // The compacted view actually reached the upstream (summary + tail).
        const forward = h.bodies[h.bodies.length - 1];
        assert.ok(forward.includes(CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX), "compaction summary forwarded upstream");
        assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA, "x-acp-session": "codex-sess-a" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, messages: [...compactedMessages(), { role: "user", content: "Post-compaction turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 5, "refs accumulate append-only after the rebase");
    } finally {
        await h.close();
    };
});

test("negative #4521: non-codex UA with the same compacted shape does NOT rebase on the openai wire", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "TraeCode/2.4.3 (Linux; x86_64)", "x-acp-session": "codex-sess-a" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, messages: compactedMessages() }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        // No rebase: the boundary is unset and the ref map is NOT re-seeded.
        // (The generic unannounced-rewrite path may still fire for a
        // non-codex client — the benign pre-fix behavior — so block liveness
        // and the rewrite boundary are not the discriminators here; the
        // native boundary and the ref map are.)
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded for a non-codex client");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no native-compaction event for a non-codex client");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length > 4, `ref map not re-seeded (got ${Object.keys(s.state.messageRefs.byRaw).length} ids — rebase would leave exactly 4)`);
    } finally {
        await h.close();
    };
});

test("negative #4521: codex UA + decimated coverage but no summary template does NOT rebase on the openai wire", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA, "x-acp-session": "codex-sess-a" },
            body: JSON.stringify({
                model: "gpt-resp",
                stream: true,
                messages: [
                    { role: "user", content: "A different rewritten head — no codex template here. " + "HEAD_.repeat".repeat(40) },
                    seedMessages()[12],
                    seedMessages()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without the summary template");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no native-compaction event without the summary template");
    } finally {
        await h.close();
    };
});

test("negative #4521: codex UA pasting the template text while history is intact does NOT rebase on the openai wire", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA, "x-acp-session": "codex-sess-a" },
            body: JSON.stringify({
                model: "gpt-resp",
                stream: true,
                messages: [...seedMessages(), { role: "user", content: `${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.` }],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await h.close();
    };
});
