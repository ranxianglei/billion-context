import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, createInitialState, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { defaultConfig } from "acp-kernel";
import { adoptContentStore, executeRetrieve, storeEffectiveCcr } from "../src/store.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { retrieveSessionDirName, retrievalExportDir, stateDir } from "../src/paths.ts";

// Isolate stateDir() (hence retrievalExportDir()) under a throwaway dir. node
// --test gives each file its own process, so the env mutation is safe.
process.env.BILI_PERSIST = "0";
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), "bili-retrieve-partition-"));

// ≥4000 tokens each (RETRIEVE_INLINE_TOKENS_DEFAULT) so applyRetrieve takes
// the EXPORT branch instead of inlining — that is the branch that writes to
// disk and is where #4699's collision lived.
const ALPHA = "alpha original line ".repeat(2500);
const BETA = "beta original line ".repeat(2500);

function ccrConfig() {
    return applyCompressSettings(defaultConfig(200000), 200_000, {
        absorb: { enabled: true, minToolTokens: 50 },
        ccr: { enabled: true, minToolTokens: 50 },
    });
}

// One oversized tool result per session ⇒ each session's FIRST stored ref is
// m00001 — two independent sessions share the same ref number by construction
// (refs are per-session sequence numbers). This is exactly the reporter's
// shape: same number, different content, different conversation.
function storeFor(text: string) {
    const core = createCore();
    const msgs: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text },
    ];
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config: ccrConfig(), tokenCount: 0, renderTags: "text-only" });
    return turn.contentStore;
}

test("retrieveSessionDirName: deterministic, injective across sanitizing collisions", () => {
    assert.equal(retrieveSessionDirName("ses_abc123"), "ses_abc123", "clean ids keep their historical unsalted name");
    assert.equal(retrieveSessionDirName("ses_abc123"), retrieveSessionDirName("ses_abc123"), "deterministic across calls (path survives restarts)");
    const slash = retrieveSessionDirName("a/b");
    const dash = retrieveSessionDirName("a-b");
    assert.notEqual(slash, dash, "ids that sanitize to the same form must not share a dir (salted apart)");
    assert.ok(slash.startsWith("a-b-"), `salted form keeps the sanitized prefix: ${slash}`);
    const long = retrieveSessionDirName("x".repeat(150));
    assert.ok(long.length <= 109, "truncation + salt stays bounded (100 + '-' + 8)");
    assert.equal(retrieveSessionDirName(""), "session", "empty id falls back to a named dir");
});

test("#4699: two sessions exporting the SAME ref number land in separate files with their own bytes", () => {
    try {
        const idA = "part-alpha-1";
        const idB = "part-beta-1";
        const sA = getSession(idA);
        const sB = getSession(idB);
        for (const s of [sA, sB]) {
            storeEffectiveCcr(s, { enabled: true, minToolTokens: 50 });
        }
        adoptContentStore(sA, storeFor(ALPHA));
        adoptContentStore(sB, storeFor(BETA));
        const refA = Object.keys(sA.contentStore!.byRef)[0]!;
        const refB = Object.keys(sB.contentStore!.byRef)[0]!;
        assert.equal(refA, refB, "precondition: independent sessions reuse the same ref number");

        const resA = executeRetrieve({ ref: refA }, sA);
        const resB = executeRetrieve({ ref: refB }, sB);
        assert.match(resA.text!, /exported|read file/i, "oversized original takes the pointer branch");
        assert.match(resB.text!, /exported|read file/i);

        const pathA = path.join(retrievalExportDir(idA), `${refA}.txt`);
        const pathB = path.join(retrievalExportDir(idB), `${refB}.txt`);
        assert.notEqual(pathA, pathB, "per-session dirs keep the two exports apart");
        assert.ok(existsSync(pathA), `session A export written: ${pathA}`);
        assert.ok(existsSync(pathB), `session B export written: ${pathB}`);
        assert.equal(readFileSync(pathA, "utf8"), ALPHA, "A's pointer reads A's original, not B's");
        assert.equal(readFileSync(pathB, "utf8"), BETA, "B's pointer reads B's original, not A's");
        assert.ok(resA.text!.includes(pathA), "pointer names A's own file");
        assert.ok(resB.text!.includes(pathB), "pointer names B's own file");
        // The pre-#4699 flat location must NOT be used anymore.
        assert.ok(!existsSync(path.join(stateDir(), "retrieve", `${refA}.txt`)), "no flat <stateDir>/retrieve/<ref>.txt write");
    } finally {
        _resetSessionsForTest();
    }
});

test("#4699: re-retrieve of the same ref is idempotent within its session (same file, same bytes)", () => {
    try {
        const id = "part-idem-1";
        const s = getSession(id);
        storeEffectiveCcr(s, { enabled: true, minToolTokens: 50 });
        adoptContentStore(s, storeFor(ALPHA));
        const ref = Object.keys(s.contentStore!.byRef)[0]!;
        const first = executeRetrieve({ ref }, s);
        const p = path.join(retrievalExportDir(id), `${ref}.txt`);
        assert.ok(first.text!.includes(p));
        const second = executeRetrieve({ ref }, s);
        assert.ok(second.text!.includes(p), "second retrieve points at the same file");
        assert.equal(readFileSync(p, "utf8"), ALPHA, "rewrite lands identical bytes");
        // #4699 review: overwriting an existing file does not touch its parent
        // dir's mtime, and the GC age gate reads exactly that mtime — so the
        // write path must refresh it, or a live session that only re-retrieves
        // the same refs would get its export dir swept after maxAgeDays.
        const dir = path.dirname(p);
        const backdated = new Date(Date.now() - 10 * 86_400_000);
        utimesSync(dir, backdated, backdated);
        executeRetrieve({ ref }, s);
        assert.ok(statSync(dir).mtimeMs > backdated.getTime(), "re-retrieve refreshes the export dir mtime (GC age gate input)");
    } finally {
        _resetSessionsForTest();
    }
});
