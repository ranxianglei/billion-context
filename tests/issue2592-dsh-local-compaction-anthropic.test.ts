// #2592: the #2432 dsh local-compaction detector landed on the OpenAI lane
// only (f48424c41), so a dsh desktop session riding the Anthropic Messages
// lane (Anthropic-compatible endpoints, e.g. deepseek-official) hit the
// pre-#2432 death spiral whenever dsh compacted locally: the first replay of
// [checkpoint summary, retained tail…] against the same session id left the
// ACP state unrebased — syncBlocks kept partially-alive blocks whose dead
// refs the nudge kept broadcasting, every later compress failed "every ref
// is unknown to this session", and the compress circuit breaker armed after
// four consecutive failures. prepare-anthropic now runs the same detection
// as the openai/responses lanes: dsh-bound session + checkpoint framing in
// resent history + decimated fold coverage → mark AND rebase in the SAME
// turn. Lane inventory done in the same PR: responses already fixed
// (db585effe, in v0.1.189); google — dsh speaks no Google wire, so the dsh
// detector cannot fire there (nothing to port).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { carriesDshLocalCompactionSummary, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

const MODEL = "deepseek-flash";

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

async function startRig(compress: { injectTool: boolean; injectNudge?: boolean }): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Report prompt tokens proportional to the payload so the token
            // baseline tracks real growth between turns.
            const inputTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: MODEL,
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: inputTokens, output_tokens: 5 },
            }));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress,
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
    } as ProxyOptions);
    await once(proxy, "listening");
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        bodies,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

const messagesUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

function piHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv };
}

type AnthMsg = { role: string; content: Array<{ type: string; text: string }> };

function msg(role: string, text: string): AnthMsg {
    return { role, content: [{ type: "text", text }] };
}

// 14 messages sized like the #2432 openai fixture: the kernel protects the
// last 5 messages, so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput(): AnthMsg[] {
    return Array.from({ length: 14 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230)));
}

function checkpointMessage(): AnthMsg {
    return msg("user", `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`);
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string, headers: (c: string) => Record<string, string>): Promise<void> {
    const r1 = await fetch(messagesUrl(rig), {
        method: "POST",
        headers: headers(conv),
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: seedInput() }),
    });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= 14, "refs assigned to the seeded history");

    const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

test("unit #2592: carriesDshLocalCompactionSummary matches framing on anthropic-shaped user text", () => {
    // #2621 tightened the guard to user TEXT messages only (quotes from any
    // other producer must not fire it); pin the anthropic wire shape for that
    // contract: a user message's block-array content must be seen, while an
    // anthropic-lane tool result (role=user, contentType=tool-result) quoting
    // the marker must read false.
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", content: [{ type: "text", text: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation…` }] }]), true, "preamble inside a user-text block array");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", content: [{ type: "text", text: `intro\n${DSH_CHECKPOINT_OPEN_TAG}\n## section` }] }]), true, "open tag inside a user-text block array");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", content: [{ type: "text", text: "ordinary prose" }] }]), false, "ordinary prose");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "tool-result", content: [{ type: "text", text: `${DSH_CHECKPOINT_OPEN_TAG} quoted from a transcript read` }] }]), false, "anthropic-lane tool result quoting the marker (#2621)");
});

test("e2e #2592: dsh replaying [checkpoint, retained tail] on the ANTHROPIC lane rebases the ACP state instead of drifting forever", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-anthropic-main";
    try {
        await seedAndFold(rig, conv, dshHeaders);
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const r = await fetch(messagesUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [checkpointMessage(), seedInput()[12], seedInput()[13]] }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = getSession(conv)!;
        assert.equal((s.state.blocks ?? []).length, 0, "block list empty after the rebase reset");
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
        assert.ok(boundary, "native-compaction boundary recorded");
        assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
        assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 3, "refs re-seeded onto exactly the compacted view (checkpoint + 2 retained)");

        const events = conflictEventsOf(s);
        assert.ok(events.some((e) => e.kind === "native-compaction"), "classified as native-compaction in the conflict ledger");
        assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "no double-record as unannounced-rewrite beside it");

        const forward = rig.bodies[rig.bodies.length - 1];
        assert.ok(forward.includes(DSH_CHECKPOINT_OPEN_TAG), "checkpoint framing forwarded upstream");
        assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(messagesUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [checkpointMessage(), seedInput()[12], seedInput()[13], msg("user", "Post-compaction turn continues fine.")] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = getSession(conv)!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 4, "refs accumulate append-only after the rebase");
    } finally {
        await rig.close();
    }
});

test("negative #2592: same compacted shape on a NON-dsh plugin lane (pi) over /v1/messages does NOT rebase", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-anthropic-nonbind";
    try {
        // Seed + fold under a DIFFERENT plugin agent (pi): the sticky
        // pluginAgent binding stays "pi", so the identical compacted shape
        // must not trigger the dsh-specific rebase.
        await seedAndFold(rig, conv, piHeaders);
        const s0 = getSession(conv)!;
        assert.equal(s0.metadata["pluginAgent"], "pi", "precondition: session bound to the pi lane");
        const before = Object.keys(s0.state.messageRefs.byRaw).length;

        const r = await fetch(messagesUrl(rig), {
            method: "POST",
            headers: piHeaders(conv),
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [checkpointMessage(), seedInput()[12], seedInput()[13]] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary outside the dsh lane");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length >= before, "ref map not re-seeded");
    } finally {
        await rig.close();
    }
});

test("negative #2592: decimated history WITHOUT checkpoint framing stays on the existing paths", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-anthropic-nomarker";
    try {
        await seedAndFold(rig, conv, dshHeaders);
        const r = await fetch(messagesUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1024,
                messages: [
                    msg("user", "A different rewritten head — no dsh checkpoint framing here. " + "HEAD_.repeat".repeat(40)),
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no rebase without the checkpoint framing (gap alone is ordinary churn)");
    } finally {
        await rig.close();
    }
});

test("negative #2592: user pasting the framing while history is intact does NOT rebase", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-anthropic-paste";
    try {
        await seedAndFold(rig, conv, dshHeaders);
        const r = await fetch(messagesUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1024,
                messages: [...seedInput(), msg("user", `${DSH_CHECKPOINT_PREAMBLE_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.`)],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await rig.close();
    }
});
