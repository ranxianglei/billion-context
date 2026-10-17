import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    METADATA_INCREMENTAL_PREFIX,
    getIncrementalStats,
    prefixIdChainHash,
    reconcileFoldCoverage,
    type IncrementalPrefixState,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #3248 phase 1: verified-incremental prefix fast path. The load-bearing
// property under test is LOCKSTEP EQUIVALENCE: a plugin-lane session running
// the fast path must produce byte-identical metadata (minus the fingerprint
// key) and blocks as an identical session forced through full reconciliation
// every pass. Everything else (gates, miss reasons, no-clobber) hangs off it.

function msg(id: string, role: string, text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

function baseMsgs(n = 12): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => msg(`m${i + 1}`, i % 2 === 0 ? "user" : "assistant", `text ${i + 1}`));
}

function pluginSession(ids: string[], agent: string | undefined = "dsh"): Session {
    const metadata: Record<string, unknown> = {};
    if (agent !== undefined) metadata.pluginAgent = agent;
    return { state: { blocks: [{ active: true, effectiveMessageIds: [...ids] }] }, metadata } as unknown as Session;
}

const OPTS = (sessionId: string) => ({ mode: "repair" as const, sessionId, log: () => {} });

type StatsSnapshot = ReturnType<typeof getIncrementalStats>;
function delta(before: StatsSnapshot, after: StatsSnapshot, lane = "dsh") {
    const b = before.lanes[lane] ?? { hits: 0, misses: {} };
    const a = after.lanes[lane] ?? { hits: 0, misses: {} };
    return {
        hits: a.hits - b.hits,
        misses: Object.fromEntries(Object.entries(a.misses).map(([k, v]) => [k, v - (b.misses[k] ?? 0)])),
    };
}

describe("prefixIdChainHash (#3248)", () => {
    test("deterministic, 32-hex", () => {
        assert.equal(prefixIdChainHash(["a", "b"]), prefixIdChainHash(["a", "b"]));
        assert.match(prefixIdChainHash(["a"]), /^[0-9a-f]{32}$/);
    });
    test("order-sensitive", () => {
        assert.notEqual(prefixIdChainHash(["a", "b"]), prefixIdChainHash(["b", "a"]));
    });
    test("content-sensitive", () => {
        assert.notEqual(prefixIdChainHash(["a", "b"]), prefixIdChainHash(["a", "c"]));
    });
    test("truncation-sensitive (head deletion flips the digest)", () => {
        assert.notEqual(prefixIdChainHash(["a", "b", "c"]), prefixIdChainHash(["b", "c"]));
        assert.notEqual(prefixIdChainHash(["a", "b", "c"]), prefixIdChainHash(["a", "b"]));
    });
    test("NUL join prevents boundary ambiguity", () => {
        assert.notEqual(prefixIdChainHash(["ab", "c"]), prefixIdChainHash(["a", "bc"]));
    });
});

describe("verified-incremental prefix fast path (#3248 phase 1)", () => {
    test("steady-state append hits; first pass establishes without counting", () => {
        const before = getIncrementalStats();
        const ids = baseMsgs().map((m) => m.id!);
        const s = pluginSession(ids);
        const r1 = reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-steady-1"));
        assert.equal(r1.kind, "resend");
        assert.notEqual(r1.fastPath, true);
        const fp1 = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        assert.deepEqual(fp1, { count: 12, hash: prefixIdChainHash(ids), clean: true });

        const grown = [...baseMsgs(), msg("m13", "user", "text 13"), msg("m14", "assistant", "text 14")];
        const r2 = reconcileFoldCoverage(s, grown, OPTS("inc-steady-1"));
        assert.equal(r2.kind, "resend");
        assert.equal(r2.fastPath, true);
        const fp2 = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        assert.equal(fp2.count, 14);
        assert.equal(fp2.hash, prefixIdChainHash([...ids, "m13", "m14"]));
        assert.equal(fp2.clean, true);

        const d = delta(before, getIncrementalStats());
        assert.equal(d.hits, 1);
        assert.deepEqual(d.misses, {});
    });

    test("equal-length retry resend also hits (count stays)", () => {
        const ids = baseMsgs().map((m) => m.id!);
        const s = pluginSession(ids);
        reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-retry"));
        const r2 = reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-retry"));
        assert.equal(r2.fastPath, true);
        const fp = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        assert.equal(fp.count, 12);
        assert.equal(fp.clean, true);
    });

    test("LOCKSTEP EQUIVALENCE: fast-path session ≡ full-path session, every pass", () => {
        const mk = (): Session => pluginSession(baseMsgs().map((m) => m.id!));
        const A = mk();
        const B = mk();
        const optsA = OPTS("inc-lock-a");
        const optsB = OPTS("inc-lock-b");
        const turns: Array<{ label: string; msgs: CoreMessage[] }> = [
            { label: "base", msgs: baseMsgs() },
            { label: "append-2", msgs: [...baseMsgs(), msg("m13", "user", "text 13"), msg("m14", "assistant", "text 14")] },
            { label: "append-3", msgs: [...baseMsgs(), msg("m13", "user", "text 13"), msg("m14", "assistant", "text 14"), msg("m15", "user", "text 15"), msg("m16", "assistant", "text 16"), msg("m17", "user", "text 17")] },
            { label: "retry-resend", msgs: [...baseMsgs(), msg("m13", "user", "text 13"), msg("m14", "assistant", "text 14"), msg("m15", "user", "text 15"), msg("m16", "assistant", "text 16"), msg("m17", "user", "text 17")] },
            { label: "append-1", msgs: [...baseMsgs(), msg("m13", "user", "text 13"), msg("m14", "assistant", "text 14"), msg("m15", "user", "text 15"), msg("m16", "assistant", "text 16"), msg("m17", "user", "text 17"), msg("m18", "assistant", "text 18")] },
        ];
        for (let t = 0; t < turns.length; t++) {
            delete B.metadata[METADATA_INCREMENTAL_PREFIX]; // force B onto the full scan
            const ra = reconcileFoldCoverage(A, turns[t].msgs, optsA);
            const rb = reconcileFoldCoverage(B, turns[t].msgs, optsB);
            assert.equal(ra.kind, rb.kind, `turn ${t} (${turns[t].label}): kind diverged`);
            const ma = { ...A.metadata };
            const mb = { ...B.metadata };
            delete ma[METADATA_INCREMENTAL_PREFIX];
            delete mb[METADATA_INCREMENTAL_PREFIX];
            assert.deepEqual(ma, mb, `turn ${t} (${turns[t].label}): metadata diverged`);
            assert.deepEqual(A.state?.blocks, B.state?.blocks, `turn ${t} (${turns[t].label}): blocks diverged`);
            if (t >= 1) assert.equal(ra.fastPath, true, `turn ${t} (${turns[t].label}): A should be on the fast path`);
            assert.notEqual(rb.fastPath, true, `turn ${t} (${turns[t].label}): B must stay on the full path`);
        }
    });

    test("hash-mismatch falls back, then dirty-predecessor until a clean pass", () => {
        const before = getIncrementalStats();
        const ids = baseMsgs().map((m) => m.id!);
        const s = pluginSession(ids);
        reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-mismatch"));

        const edited = baseMsgs();
        edited[5] = msg("m6-edited", "assistant", "text 6 CHANGED");
        const r2 = reconcileFoldCoverage(s, edited, OPTS("inc-mismatch"));
        assert.notEqual(r2.fastPath, true);
        assert.equal(r2.missing, 1);
        let fp = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        assert.equal(fp.clean, false);
        let d = delta(before, getIncrementalStats());
        assert.equal(d.misses["hash-mismatch"], 1);

        const r3 = reconcileFoldCoverage(s, edited, OPTS("inc-mismatch"));
        assert.notEqual(r3.fastPath, true);
        fp = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        d = delta(before, getIncrementalStats());
        assert.equal(d.misses["dirty-predecessor"], 1);
        // whichever way the claim landed, the fingerprint now tracks the
        // edited wire; the NEXT identical pass may only hit if this one was clean
        if (fp.clean) {
            const r4 = reconcileFoldCoverage(s, edited, OPTS("inc-mismatch"));
            assert.equal(r4.fastPath, true);
        }
    });

    test("count-shrink (head truncation) falls back", () => {
        const before = getIncrementalStats();
        const s = pluginSession(baseMsgs().map((m) => m.id!));
        reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-shrink"));
        const truncated = baseMsgs().slice(2); // 10 msgs, still past the side gate
        const r2 = reconcileFoldCoverage(s, truncated, OPTS("inc-shrink"));
        assert.notEqual(r2.fastPath, true);
        const d = delta(before, getIncrementalStats());
        assert.equal(d.misses["count-shrink"], 1);
    });

    test("side requests (< SIDE_REQUEST_MAX_MSGS) neither hit nor clobber the fingerprint", () => {
        const ids = baseMsgs().map((m) => m.id!);
        const s = pluginSession(ids);
        reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-side"));
        const fpBefore = JSON.stringify(s.metadata[METADATA_INCREMENTAL_PREFIX]);
        const side = baseMsgs().slice(0, 5);
        const rs = reconcileFoldCoverage(s, side, OPTS("inc-side"));
        assert.equal(rs.kind, "noop");
        assert.equal(rs.fastPath, undefined);
        assert.equal(JSON.stringify(s.metadata[METADATA_INCREMENTAL_PREFIX]), fpBefore);
        const grown = [...baseMsgs(), msg("m13", "user", "text 13")];
        const r2 = reconcileFoldCoverage(s, grown, OPTS("inc-side"));
        assert.equal(r2.fastPath, true);
    });

    test("non-plugin lanes never write the fingerprint and never take the fast path", () => {
        // Explicit undefined would hit pluginSession's default ("dsh") — build
        // the no-lane fixture inline instead.
        const s = { state: { blocks: [{ active: true, effectiveMessageIds: baseMsgs().map((m) => m.id!) }] }, metadata: {} } as unknown as Session;
        const r1 = reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-nolane"));
        assert.equal(r1.kind, "resend");
        assert.equal(r1.fastPath, false);
        assert.equal(METADATA_INCREMENTAL_PREFIX in s.metadata, false);
        const r2 = reconcileFoldCoverage(s, [...baseMsgs(), msg("m13", "user", "text 13")], OPTS("inc-nolane"));
        assert.equal(r2.fastPath, false);
        assert.equal(METADATA_INCREMENTAL_PREFIX in s.metadata, false);
    });

    test("corrupt stored fingerprint shape falls back silently (no miss counted)", () => {
        const before = getIncrementalStats();
        const s = pluginSession(baseMsgs().map((m) => m.id!));
        s.metadata[METADATA_INCREMENTAL_PREFIX] = { count: "twelve", hash: 42, clean: "yes" };
        const r1 = reconcileFoldCoverage(s, baseMsgs(), OPTS("inc-corrupt"));
        assert.notEqual(r1.fastPath, true);
        const d = delta(before, getIncrementalStats());
        assert.equal(d.hits, 0);
        assert.equal(d.misses["count-shrink"] ?? 0, 0);
        assert.equal(d.misses["hash-mismatch"] ?? 0, 0);
        assert.equal(d.misses["dirty-predecessor"] ?? 0, 0);
        const fp = s.metadata[METADATA_INCREMENTAL_PREFIX] as IncrementalPrefixState;
        assert.equal(fp.count, 12);
        assert.equal(fp.clean, true);
    });
});
