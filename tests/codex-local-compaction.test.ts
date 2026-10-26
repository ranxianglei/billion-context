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

// Issue #2372 regression: codex's LOCAL auto-compaction (rollout event
// type:"compacted") never transits the proxy — no compaction_trigger item, no
// /responses/compact call. The next request replays [compaction summary,
// retained tail…] against the SAME session id. Before the fix the folded
// head's covered ids simply vanished: syncBlocks kept partially-alive blocks
// active forever, fold anchors self-destructed on the first pass, and every
// later turn logged coverage drift without recovering ("compression substrate
// appears destroyed (#1921)" escalation, never healing). The responses lane
// must detect the signature — codex client + summary template heading a
// resent message + decimated fold coverage — and rebase the ACP state onto
// the compacted view (same reset the /responses/compact endpoint uses).

const CODEX_UA = "codex_cli_rs/0.21.0 (Ubuntu 24.04; x86_64)";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

function fcEvents(callId: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "compress", arguments: args }, output_index: 0 }),
    ].join("");
}

// 14 messages at ~1100 tokens each (~15.4K total, under the 30K window —
// preflight stays off for the seed turn). The kernel protects the last 5
// messages and a 5K-token tail, so with the first 9 at ~9.9K tokens they sit
// above the tail floor and the fold covers 9 raw ids — above the 8-id
// detection floor, decimated by the compacted replay (summary + last 2).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function compactedInput() {
    return [
        {
            type: "message",
            role: "user",
            content: `${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX} of the conversation so far, as context for continuing. The work established the test harness, drove one fold, and then codex compacted locally. Continue with the retained tail.`,
        },
        seedInput()[12],
        seedInput()[13],
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
            if (bodies.length === 1) {
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
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(fcEvents("call_p", compressArgs));
                res.write(completed(3000));
            } else {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(completed(800));
            }
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
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
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
        headers: { "content-type": "application/json", "user-agent": CODEX_UA },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "codex-sess-a", instructions: "You are the test coding agent.", input: seedInput() }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const s = listSessions().find((x) => x.meta.label === "codex-sess-a");
    assert.ok(s, "seed session exists");
    assert.ok((s!.state.blocks ?? []).some((b) => b.active), "seed session has an active fold");
}

test("drift pin: codex local-compaction summary template header is versioned (#2372)", () => {
    assert.equal(
        CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX,
        "Another language model started to solve this problem and produced a summary",
    );
});

test("e2e #2372: codex replaying [summary, retained tail] rebases the ACP state instead of drifting forever", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const before = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        const coveredBefore = new Set(before.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, `seed fold covers >=8 ids (got ${coveredBefore.size})`);

        // The compacted replay: same session id, codex UA, summary + retained
        // tail. Must succeed and must have rebased (not drifted).
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "codex-sess-a", instructions: "You are the test coding agent.", input: compactedInput() }),
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

        // The compacted view actually reached the upstream (summary + tail).
        const forward = h.bodies[h.bodies.length - 1];
        assert.ok(forward.includes(CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX), "compaction summary forwarded upstream");
        assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "codex-sess-a", instructions: "You are the test coding agent.", input: [...compactedInput(), { type: "message", role: "user", content: "Post-compaction turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 5, "refs accumulate append-only after the rebase");
    } finally {
        await h.close();
    }
});

test("negative #2372: non-codex UA with the same compacted shape does NOT rebase", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "TraeCode/2.4.3 (Linux; x86_64)" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "codex-sess-a", instructions: "You are the test coding agent.", input: compactedInput() }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        // No rebase: the boundary is unset and the ref map is NOT re-seeded.
        // (The kernel's own syncBlocks may still deactivate the fully-drifted
        // block — the benign same-session path — so block liveness is not the
        // discriminator here; the ref map and boundary are.)
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded for a non-codex client");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length > 4, `ref map not re-seeded (got ${Object.keys(s.state.messageRefs.byRaw).length} ids — rebase would leave exactly 4)`);
    } finally {
        await h.close();
    }
});

test("negative #2372: codex UA + decimated coverage but no summary template does NOT rebase (#1195 churn path stays on fold-reconcile)", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({
                model: "gpt-resp",
                stream: true,
                session_id: "codex-sess-a",
                instructions: "You are the test coding agent.",
                input: [
                    { type: "message", role: "user", content: "A different rewritten head — no codex template here. " + "HEAD_.repeat".repeat(40) },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without the summary template");
    } finally {
        await h.close();
    }
});

test("negative #2372: user pasting the template text while history is intact does NOT rebase", async () => {
    const h = await startHarness();
    try {
        await seedFoldedSession(h);
        const r = await fetch(h.url, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": CODEX_UA },
            body: JSON.stringify({
                model: "gpt-resp",
                stream: true,
                session_id: "codex-sess-a",
                instructions: "You are the test coding agent.",
                input: [...seedInput(), { type: "message", role: "user", content: `${CODEX_LOCAL_COMPACTION_SUMMARY_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.` }],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = listSessions().find((x) => x.meta.label === "codex-sess-a")!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await h.close();
    }
});
