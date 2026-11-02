import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, REF_FLOOR_RAW_ID } from "../src/session.ts";
import { epochConfirmPending } from "../src/fold-reconcile.ts";
import { CODEX_NATIVE_CHECKPOINT_TYPE, findNativeCodexCheckpoint, nativeCodexCheckpointFingerprint } from "../src/codex-compact.ts";

// Issue #4929 regression: newer codex builds land their LOCAL auto-compaction
// as a NATIVE Responses compaction item carrying an opaque provider blob
// (encrypted_content) instead of the legacy text summary message (#2372). The
// kernel projection drops such items into the preamble (no core id ever exists
// for them), so the legacy text detector never fires; the fold coverage of the
// replaced head vanishes from the resent history, the fold-drift escalation
// latches the epoch-confirm gate, and preflight pauses forever (the compacted
// history never grows back the covered ids — the old head is durably gone).
// The fix recognizes the structural item shape (marker-decisive, no absolute
// missing floor), persists the sha256 identity of the opaque blob without
// decoding it, and rebases iff fold coverage was lost (majority rule) or the
// old substrate is empty. Repeated echoes and cold loads must retain later
// folds; non-codex requests, bili-generated items, malformed inputs and
// healthy coverage are controls.

const CODEX_UA = "codex_cli_rs/0.21.0 (Ubuntu 24.04; x86_64)";

// Opaque provider blob — base64-ish wire bytes; carries neither the bili id
// prefix nor the bili:acp: sentinel, so the echo-replace path leaves it alone.
const OPAQUE_BLOB = "gAAAAABl-opaque-provider-checkpoint-" + "opaque-segment-".repeat(24);
const OPAQUE_FP = createHash("sha256").update(OPAQUE_BLOB, "utf8").digest("hex");

function checkpointItem(): Record<string, unknown> {
    return { type: CODEX_NATIVE_CHECKPOINT_TYPE, id: "cmp_opaque_4929", encrypted_content: OPAQUE_BLOB };
}

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

const LONG_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

function foldSse(callId: string, startId: string, endId: string, topic: string, inputTokens: number): string {
    const compressArgs = JSON.stringify({ content: [{ startId, endId, topic, summary: LONG_SUMMARY }] });
    return fcEvents(callId, compressArgs) + completed(inputTokens);
}

function seedFoldSse(): string {
    return foldSse("call_p", "m00001", "m00004", "folded head", 3000);
}

// The post-rebase fold targets whatever refs the rebased view ACTUALLY holds:
// a native-compaction rebase pins the pre-rebase high-water mark as ref floor
// (#2592/F5), so the compacted view's refs resume ABOVE it in the sparse
// space — never back at m00001. The mock model resolves them the way a real
// one must: read the live ref table, then compress.
type RangeHolder = { current?: [string, string] };

function postRebaseFoldSse(h: RangeHolder): string | undefined {
    if (!h.current) return undefined;
    const [startId, endId] = h.current;
    return foldSse("call_q", startId, endId, "post-rebase head", 1200);
}

function oldestAllocatedRefs(s: ReturnType<typeof sessionOf>, n: number): string[] {
    const floorRef = s.state.messageRefs.byRaw[REF_FLOOR_RAW_ID];
    return Object.keys(s.state.messageRefs.byRef)
        .filter((ref) => ref !== floorRef)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .slice(0, n);
}

// 9 messages at ~1100-1600 tokens each (~12-15K total, under the 30K window —
// preflight stays off for the seed turn). Sized so the kernel's 5K-token
// preserve-recent floor covers the LAST FIVE messages and stops there: the
// first 4 sit above it and the fold covers exactly 4 raw ids — BELOW the
// legacy 8-id text-detector floor, which is why the #2372 heuristic cannot see
// this scenario once the opaque checkpoint replaces the text summary.
function seedInput() {
    return Array.from({ length: 9 }, (_, i) => ({
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(350),
    }));
}

// The compacted replay: native opaque checkpoint + retained tail (last 3).
function tailInput() {
    return [checkpointItem(), seedInput()[6], seedInput()[7], seedInput()[8]];
}

// ~1100+ tokens each so that FIVE fillers alone exceed the kernel's 5K-token
// preserve-recent floor — the post-rebase fold target (the four oldest refs of
// the rebased view) must sit entirely above it or the carve-out eats its last cell.
function growthFiller(i: number): Record<string, unknown> {
    return { type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Growth filler ${i}. ` + "pad_pad_pad_".repeat(450) };
}

type Harness = {
    url: string;
    bodies: string[];
    store?: SessionStore;
    close: () => Promise<void>;
};

async function startUpstream(script: (n: number) => string, bodies: string[]): Promise<{ port: number; close: () => Promise<void> }> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(script(bodies.length));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    return {
        port: (upstream.address() as { port: number }).port,
        close: async () => {
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

async function startProxy(upstreamPort: number): Promise<{ url: string; close: () => Promise<void> }> {
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
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
        },
    };
}

async function startHarness(opts: { persistDir?: string; script?: (n: number) => string } = {}): Promise<Harness> {
    const bodies: string[] = [];
    const script = opts.script ?? ((n: number) => (n === 1 ? seedFoldSse() : completed(800)));
    const up = await startUpstream(script, bodies);
    const store = opts.persistDir ? new SessionStore({ dir: opts.persistDir, debounceMs: 0 }) : undefined;
    _setStoreForTest(store ?? new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const pr = await startProxy(up.port);
    return {
        url: pr.url,
        bodies,
        store,
        close: async () => {
            await pr.close();
            await up.close();
        },
    };
}

async function send(url: string, sessionId: string, input: unknown[], ua: string = CODEX_UA): Promise<number> {
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": ua },
        body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: sessionId, instructions: "You are the test coding agent.", input }),
    });
    await r.text();
    return r.status;
}

function sessionOf(label: string) {
    const s = listSessions().find((x) => x.meta.label === label);
    assert.ok(s, `session ${label} exists`);
    return s!;
}

// --- helper unit tests -------------------------------------------------------

test("#4929: findNativeCodexCheckpoint matches only valid native items and ignores malformed/bili shapes", () => {
    assert.equal(findNativeCodexCheckpoint(null), null);
    assert.equal(findNativeCodexCheckpoint("not-an-array"), null);
    assert.equal(findNativeCodexCheckpoint([]), null);
    assert.equal(findNativeCodexCheckpoint([{ type: "message", role: "user", content: "hi" }]), null);
    // malformed shapes never match
    assert.equal(findNativeCodexCheckpoint([{ type: "compaction", id: "cmp_a" }]), null);
    assert.equal(findNativeCodexCheckpoint([{ type: "compaction", id: "cmp_b", encrypted_content: "" }]), null);
    assert.equal(findNativeCodexCheckpoint([{ type: "compaction", id: "cmp_c", encrypted_content: 12345 }]), null);
    // bili-generated items are excluded (echo-replace path owns them)
    assert.equal(findNativeCodexCheckpoint([{ type: "compaction", id: "fc_bili_x", encrypted_content: "some-blob" }]), null);
    assert.equal(findNativeCodexCheckpoint([{ type: "compaction", id: "cmp_d", encrypted_content: "bili:acp:summary text" }]), null);
    // a valid native item matches, identity = sha256 hex of the raw blob
    const fp = findNativeCodexCheckpoint([{ type: "compaction", id: "cmp_e", encrypted_content: OPAQUE_BLOB }]);
    assert.equal(fp, OPAQUE_FP);
    assert.equal(nativeCodexCheckpointFingerprint(checkpointItem()), OPAQUE_FP);
    assert.equal(nativeCodexCheckpointFingerprint({ type: "compaction", encrypted_content: "" }), null);
});

// --- e2e ---------------------------------------------------------------------

test("e2e #4929: codex replaying [opaque checkpoint, retained tail] reconciles the boundary once and creates new folds afterwards", async () => {
    const ranges: RangeHolder = {};
    const h = await startHarness({
        script: (n) => (n === 1 ? seedFoldSse() : postRebaseFoldSse(ranges) ?? completed(800)),
    });
    try {
        // Seed: 4-id fold (below the 8-id legacy floor).
        assert.equal(await send(h.url, "codex-sess-a", seedInput()), 200);
        const seeded = sessionOf("codex-sess-a");
        const covered = new Set(seeded.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.equal(covered.size, 4, `seed fold covers exactly 4 ids (got ${covered.size})`);

        // Seed the failure precondition: pending epoch confirmation + a high
        // stale usage baseline (what the drift escalation leaves behind).
        seeded.metadata["foldEpochConfirmPending"] = true;
        seeded.stats.lastInputTokens = 28_000;
        assert.equal(epochConfirmPending(seeded), true, "epoch-confirm latched before the checkpoint lands");

        // The compacted replay with the opaque checkpoint.
        assert.equal(await send(h.url, "codex-sess-a", tailInput()), 200, "checkpoint replay request succeeds");
        const s = sessionOf("codex-sess-a");
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean; rebasedAt?: number } | undefined;
        assert.ok(boundary, "native-compaction boundary is recorded");
        assert.equal(boundary.pendingRebase, false, "rebase consumed within the same request");
        assert.ok(boundary.rebasedAt, "rebase timestamp recorded");
        assert.equal(s.metadata.codexCheckpointFp, OPAQUE_FP, "opaque checkpoint identity persisted (sha256, undecoded)");
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "no active blocks survive the rebase");
        assert.equal((s.state.blocks ?? []).length, 0, "block list is empty after the boundary reset");
        const byRawKeys = Object.keys(s.state.messageRefs.byRaw);
        assert.equal(byRawKeys.length, 4, `refs re-seeded onto exactly the compacted view (3 retained + ref-floor, got ${byRawKeys.length})`);
        assert.ok(byRawKeys.includes(REF_FLOOR_RAW_ID), "ref floor pinned");
        assert.equal(epochConfirmPending(s), false, "epoch-confirm latch cleared after the reconciliation");
        assert.ok(s.stats.lastInputTokens < 28_000, `stale usage baseline reset (got ${s.stats.lastInputTokens})`);
        // Wire fidelity: the opaque checkpoint forwards byte-exact, undecoded.
        const forward = h.bodies[h.bodies.length - 1];
        assert.ok(forward.includes("cmp_opaque_4929"), "checkpoint item forwarded upstream");
        assert.ok(forward.includes(OPAQUE_BLOB), "opaque blob forwarded verbatim");
        assert.ok(forward.includes("FILLER_8_"), "retained tail forwarded upstream");

        // Repeated echo of the SAME checkpoint must NOT re-rebase.
        const rebasedAt = boundary.rebasedAt;
        assert.equal(await send(h.url, "codex-sess-a", [...tailInput(), { type: "message", role: "user", content: "Post-checkpoint continuation." }]), 200);
        const s2 = sessionOf("codex-sess-a");
        assert.equal((s2.metadata.nativeCompactionBoundary as { rebasedAt?: number }).rebasedAt, rebasedAt, "echo of the same checkpoint does not re-rebase");
        assert.equal(s2.metadata.codexCheckpointFp, OPAQUE_FP, "identity unchanged on echo");
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 5, "refs accumulate append-only after the rebase");

        // The session grows again and creates NEW folds successfully — the mock
        // model compresses the four OLDEST refs of the rebased view (the
        // compacted head), resolved from the live ref table above the floor.
        const targetRefs = oldestAllocatedRefs(sessionOf("codex-sess-a"), 4);
        assert.equal(targetRefs.length, 4, "four oldest refs allocated in the rebased view");
        ranges.current = [targetRefs[0], targetRefs[3]];
        const growth = [...tailInput(), { type: "message", role: "user", content: "Post-checkpoint continuation." }, growthFiller(1), growthFiller(2), growthFiller(3), growthFiller(4), growthFiller(5)];
        assert.equal(await send(h.url, "codex-sess-a", growth), 200);
        ranges.current = undefined;
        const s3 = sessionOf("codex-sess-a");
        const newBlock = (s3.state.blocks ?? []).find((b) => b.active);
        assert.ok(newBlock, "a new active fold was created after the rebase");
        const expectedRaw = targetRefs.map((ref) => s3.state.messageRefs.byRef[ref]).sort();
        assert.deepEqual([...newBlock.effectiveMessageIds].sort(), expectedRaw, "new fold covers exactly the re-based head");
        assert.equal((s3.metadata.nativeCompactionBoundary as { rebasedAt?: number }).rebasedAt, rebasedAt, "second fold did not trigger another rebase");
    } finally {
        await h.close();
    }
});

test("negative #4929: non-codex UA replaying the opaque checkpoint shape does NOT rebase", async () => {
    const h = await startHarness();
    try {
        assert.equal(await send(h.url, "codex-sess-b", seedInput()), 200);
        assert.equal(await send(h.url, "codex-sess-b", tailInput(), "TraeCode/2.4.3 (Linux; x86_64)"), 200);
        const s = sessionOf("codex-sess-b");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary recorded for a non-codex client");
        assert.ok(s.metadata.codexCheckpointFp === undefined, "no identity recorded for a non-codex client");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length > 4, `ref map not re-seeded (got ${Object.keys(s.state.messageRefs.byRaw).length} ids — rebase would leave exactly 4)`);
    } finally {
        await h.close();
    }
});

test("negative #4929: bili-generated compaction item is not treated as a native checkpoint", async () => {
    const h = await startHarness();
    try {
        assert.equal(await send(h.url, "codex-sess-c", seedInput()), 200);
        const input = [{ type: "compaction", id: "fc_bili_testid", encrypted_content: "bili:acp:captured summary text" }, seedInput()[6], seedInput()[7], seedInput()[8]];
        assert.equal(await send(h.url, "codex-sess-c", input), 200);
        const s = sessionOf("codex-sess-c");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no native rebase for a bili-generated item");
        assert.ok(s.metadata.codexCheckpointFp === undefined, "no native identity for a bili-generated item");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length > 4, "ref map not re-seeded");
    } finally {
        await h.close();
    }
});

test("negative #4929: malformed compaction items never match (missing / empty / non-string encrypted_content)", async () => {
    const h = await startHarness();
    try {
        assert.equal(await send(h.url, "codex-sess-d", seedInput()), 200);
        const variants: Record<string, unknown>[] = [
            { type: "compaction", id: "cmp_m1" },
            { type: "compaction", id: "cmp_m2", encrypted_content: "" },
            { type: "compaction", id: "cmp_m3", encrypted_content: 12345 },
        ];
        for (const bad of variants) {
            assert.equal(await send(h.url, "codex-sess-d", [bad, seedInput()[6], seedInput()[7], seedInput()[8]]), 200);
            const s = sessionOf("codex-sess-d");
            assert.ok(s.metadata.nativeCompactionBoundary === undefined, `no rebase for malformed shape (${JSON.stringify(bad)})`);
            assert.ok(s.metadata.codexCheckpointFp === undefined, "no identity for a malformed shape");
        }
    } finally {
        await h.close();
    }
});

test("negative #4929: checkpoint first observed with fully intact coverage preserves current folds", async () => {
    const h = await startHarness();
    try {
        assert.equal(await send(h.url, "codex-sess-e", seedInput()), 200);
        // Full replay (every covered id present) + a novel opaque checkpoint.
        assert.equal(await send(h.url, "codex-sess-e", [checkpointItem(), ...seedInput()]), 200);
        const s = sessionOf("codex-sess-e");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "intact coverage preserves the folds — no rebase");
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "fold survives an intact-coverage checkpoint observation");
        assert.equal(s.metadata.codexCheckpointFp, OPAQUE_FP, "identity recorded so a later decimated echo of the SAME checkpoint does not re-rebase");
    } finally {
        await h.close();
    }
});

test("e2e #4929 cold load: persisted checkpoint identity survives a restart — echo retains later folds", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4929-cold-"));
    const ranges: RangeHolder = {};
    const h = await startHarness({
        persistDir: dir,
        script: (n) => (n === 1 ? seedFoldSse() : postRebaseFoldSse(ranges) ?? completed(800)),
    });
    let cold: Harness | undefined;
    try {
        // Warm phase: fold → opaque checkpoint rebase → post-rebase growth fold.
        assert.equal(await send(h.url, "codex-sess-f", seedInput()), 200);
        assert.equal(await send(h.url, "codex-sess-f", tailInput()), 200);
        const warm = sessionOf("codex-sess-f");
        const rebasedAt = (warm.metadata.nativeCompactionBoundary as { rebasedAt?: number }).rebasedAt;
        assert.ok(rebasedAt, "warm rebase happened");
        // No echo turn here, so the rebased view holds EXACTLY the three
        // retained-tail refs — the fold targets all of them. Six fillers keep
        // the whole span above the preserve-recent floor.
        const targetRefs = oldestAllocatedRefs(sessionOf("codex-sess-f"), 3);
        assert.equal(targetRefs.length, 3, "the three retained-tail refs are the whole rebased view");
        ranges.current = [targetRefs[0], targetRefs[2]];
        const growth = [...tailInput(), growthFiller(1), growthFiller(2), growthFiller(3), growthFiller(4), growthFiller(5), growthFiller(6)];
        assert.equal(await send(h.url, "codex-sess-f", growth), 200);
        ranges.current = undefined;
        const warm2 = sessionOf("codex-sess-f");
        assert.ok(warm2.state.blocks.some((b) => b.active), "post-rebase fold active before the restart");
        const refsBeforeRestart = Object.keys(warm2.state.messageRefs.byRaw).length;
        assert.ok(h.store, "persistent store available");
        await h.store.writeNow(warm2);
        await h.close();

        // Cold phase: fresh store instance on the SAME dir + fresh session map —
        // the session must come back from disk carrying its persisted checkpoint
        // identity. startHarness re-sets the global store and resets sessions.
        cold = await startHarness({ persistDir: dir, script: () => completed(800) });
        assert.equal(await send(cold.url, "codex-sess-f", [...growth, { type: "message", role: "user", content: "After restart echo." }]), 200);
        const s = sessionOf("codex-sess-f");
        assert.equal((s.metadata.nativeCompactionBoundary as { rebasedAt?: number }).rebasedAt, rebasedAt, "cold-load echo of the same checkpoint does NOT re-rebase");
        assert.ok(s.state.blocks.some((b) => b.active), "post-rebase fold survived the restart");
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, refsBeforeRestart + 1, "refs accumulate append-only across the restart");
    } finally {
        if (!h) throw new Error("unreachable");
        await h.close();
        if (cold) await cold.close();
    }
});
