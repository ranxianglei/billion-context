/**
 * #5627: a unified-store ingest failure must be diagnosable from the log and
 * the status surface alone. Before this fix noteIngestFailure kept only
 * String(err) — a RangeError says "Maximum call stack size exceeded" without
 * saying WHERE — and its warn dedup keyed on that bare message, so ONE
 * generic error (a long-running Codex session with a single pathologically
 * nested message; V8's JSON.stringify recurses, ~5k levels overflows the call
 * stack) left the status banner and the log undiagnosable. Pinned here:
 *  - serializeForStore re-throws naming the offending MESSAGE id, so the
 *    forensics point at the exact row to remove or flatten;
 *  - stats.lastError (panel/status carrier) carries error + failing PHASE +
 *    session id + top stack frames (single line, length-capped);
 *  - warn dedup stays keyed on the message (#5140 pin: one warn per distinct
 *    message), and the enriched message names its victim — distinct victims
 *    carry distinct messages and each warns once; a shared root cause
 *    (one SQLITE_BUSY across many sessions) stays a single line;
 *  - nothing is ever disabled (breaker removed 2026-10-30): the index write
 *    retries on every save, so the store heals itself once the offending
 *    message leaves the history.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedShadow, formatShadowFailure } from "../src/storage/shadow.ts";
import { setLogCapture } from "../src/logger.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Same hermeticity pin as the other storage suites: a developer machine with
// storage.unified in its real config must not leak a tier into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5627-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");
process.env.BILI_STORAGE_UNIFIED = "legacy";

type Captured = { level: string; msg: string };

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

/** Iterative deep-nesting builder — the TEST itself must not recurse into
 *  the same overflow it probes. */
function buildDepth(d: number): unknown {
    let o: unknown = { leaf: 1 };
    for (let i = 0; i < d; i++) o = { wrap: o };
    return o;
}

function mkLegacy(id: string, lastMessages: LegacySessionLike["lastMessages"]): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "anthropic" },
        stats: { requests: 1 },
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages,
        lastMessagesFolded: false,
    };
}

function openShadow(dir: string, legacyLoad?: (record: unknown) => LegacySessionLike | null): UnifiedShadow {
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "shadow" }, legacyLoad ?? ((r) => r as LegacySessionLike));
    assert.ok(shadow, "shadow mode sidecar must open");
    return shadow;
}

test("#5627: a pathologically nested message names itself, phase, session and frames — never disables", () => {
    const dir = tmpdir("bili-5627-deep-");
    const { captured, stop } = captureLogs();
    try {
        const shadow = openShadow(dir);
        // V8's serializer recurses: 6000 levels overflows the call stack
        // (measured threshold on node 22: between 4096 and 5000).
        const deep = buildDepth(6000);
        const legacy = mkLegacy("sess-deep", [
            { id: "h_ok", role: "user", contentType: "text", text: "hello" } as never,
            { id: "h_deep", role: "user", contentType: "text", text: "see", payload: deep } as never,
        ]);
        for (let i = 0; i < 3; i++) shadow.record(legacy);

        assert.equal(shadow.stats.disabled, false, "the breaker is gone — failures retry forever, never disable");
        const last = shadow.stats.lastError ?? "";
        assert.match(last, /message h_deep: nesting too deep for JSON serialization/, "must name the offending message");
        assert.match(last, /phase=plan-ingest/, "must name the failing operation");
        assert.match(last, /session=sess-deep/, "must name the session");
        assert.match(last, /\| at /, "top stack frames ride along");

        const fails = captured.filter((e) => e.level === "warn" && e.msg.includes("[storage] unified sidecar") && /failed to ingest \(/.test(e.msg));
        assert.equal(fails.length, 1, "the same failing situation warns exactly once across repeated saves (no per-turn spam)");
        assert.match(fails[0].msg, /message h_deep: nesting too deep/, "the single warning carries the enriched detail");
        assert.equal(captured.filter((e) => e.msg.includes("auto-disabled")).length, 0, "no disable line exists anymore");
    } finally {
        stop();
        rmBestEffort(dir);
    }
});

test("#5627: a second session with the SAME error gets its own warning (no global silence)", () => {
    const dir = tmpdir("bili-5627-two-sessions-");
    const { captured, stop } = captureLogs();
    try {
        const shadow = openShadow(dir);
        const deepA = buildDepth(6000);
        const deepB = buildDepth(6000);
        const sessA = mkLegacy("sess-A", [{ id: "h_A", role: "user", contentType: "text", text: "see", payload: deepA } as never]);
        const sessB = mkLegacy("sess-B", [{ id: "h_B", role: "user", contentType: "text", text: "see", payload: deepB } as never]);
        shadow.record(sessA);
        shadow.record(sessB);

        const fails = captured.filter((e) => e.level === "warn" && /failed to ingest \(/.test(e.msg));
        assert.equal(fails.length, 2, "distinct sessions are distinct situations — each warns once");
        assert.match(fails[0].msg, /session=sess-A/);
        assert.match(fails[1].msg, /session=sess-B/);
        assert.match(shadow.stats.lastError ?? "", /session=sess-B/, "lastError reflects the latest failure");
    } finally {
        stop();
        rmBestEffort(dir);
    }
});

test("#5627: a non-nesting failure carries phase, session and stack frames", () => {
    const dir = tmpdir("bili-5627-boom-");
    const { captured, stop } = captureLogs();
    try {
        const shadow = openShadow(dir, () => {
            throw new Error("synthetic load boom");
        });
        shadow.record({ some: "record" });
        shadow.record({ some: "record" });
        shadow.record({ some: "record" });

        assert.equal(shadow.stats.disabled, false);
        const last = shadow.stats.lastError ?? "";
        assert.ok(last.startsWith("Error: synthetic load boom | phase=legacy-load | session=-"), `unexpected forensics shape: ${last}`);
        assert.match(last, /\| at /, "top stack frames ride along");

        const fails = captured.filter((e) => e.level === "warn" && /failed to ingest \(/.test(e.msg));
        assert.equal(fails.length, 1, "repeats of the same situation stay quiet after the first warning");
        assert.match(fails[0].msg, /phase=legacy-load \| session=-/, "the failure before any load names itself honestly");
    } finally {
        stop();
        rmBestEffort(dir);
    }
});

test("#5627: healthy saves emit no failure lines and leave lastError untouched", () => {
    const dir = tmpdir("bili-5627-healthy-");
    const { captured, stop } = captureLogs();
    try {
        const shadow = openShadow(dir);
        shadow.record(mkLegacy("sess-ok", [{ id: "h_1", role: "user", contentType: "text", text: "hi" } as never]));
        assert.equal(shadow.stats.disabled, false);
        assert.equal(shadow.stats.ingests, 1);
        assert.equal(shadow.stats.lastError, null, "success does not fabricate a last error");
        assert.equal(captured.filter((e) => /failed to ingest \(/.test(e.msg)).length, 0, "success is not a failure");
    } finally {
        stop();
        rmBestEffort(dir);
    }
});

test("#5627: formatShadowFailure is single-line, tolerant, and length-capped", () => {
    assert.equal(formatShadowFailure("plain string failure", "plan-ingest", "sid"), "plain string failure | phase=plan-ingest | session=sid", "non-Error values carry no frames");
    assert.match(formatShadowFailure(new TypeError("circular"), "ingest-session", undefined), /\| at /, "fresh Errors ride their top frames");
    const noStack = Object.assign(new Error("boom"), { stack: undefined });
    assert.equal(formatShadowFailure(noStack, "verify-sample", "s2"), "Error: boom | phase=verify-sample | session=s2");
    const long = formatShadowFailure(new Error("x".repeat(2000)), "plan-ingest", "sid");
    assert.ok(long.length <= 700, `detail must stay bounded, got ${long.length}`);
});
