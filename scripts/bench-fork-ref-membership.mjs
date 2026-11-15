// Public snapshot/fork handlers with deterministic in-memory parent state; no upstream model call.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { handlePluginFork, handlePluginSnapshot, _resetPluginStateForTest } from "../src/plugin.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

const count = Number(process.argv[2] ?? 12000);
assert(Number.isSafeInteger(count) && count >= 4);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function response(run) {
    let status;
    let body;
    await run({ writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
    assert(status >= 200 && status < 300, JSON.stringify({ status, body }));
    return body;
}

const timings = [];
const outputs = new Set();
for (let run = 0; run < 4; run++) {
    const dir = mkdtempSync(join(tmpdir(), "bili-fork-ref-bench-"));
    const store = new SessionStore({ dir, enabled: false });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetPluginStateForTest();
    try {
        const parent = getSession("bench-parent");
        const refs = Array.from({ length: count }, (_, i) => `m${String(i + 1).padStart(5, "0")}`);
        parent.pluginSnapshot = refs.map((ref, i) => {
            const id = `source-${i}`;
            parent.state.messageRefs.byRaw[id] = ref;
            parent.state.messageRefs.byRef[ref] = id;
            return { id, role: i % 2 ? "assistant" : "user", contentType: "text", text: `source text ${i}` };
        });
        parent.state.lastPassIds = parent.pluginSnapshot.map((message) => message.id);
        parent.state.hiddenOrphanRefs = [...refs];
        parent.state.emergencyTruncateLatch = refs.map((ref) => ({ ref, text: `clipped ${ref}` }));
        parent.state.renderDeferredRefs = [...refs];
        parent.state.deadRefs = [...refs];
        const snapshot = await response((res) => handlePluginSnapshot(parent.id, res));
        const orderedMessages = snapshot.orderedMessages.slice(0, Math.floor(count / 2));
        const payload = JSON.stringify({
            protocolVersion: 2, parentConversationId: parent.id, childConversationId: "bench-child",
            parentRevision: snapshot.parentRevision,
            branchPoint: { messageCount: orderedMessages.length, orderHash: digest(orderedMessages) },
            orderedMessages, idempotencyKey: "bench-fork",
        });
        const started = performance.now();
        await response((res) => handlePluginFork(payload, res));
        const elapsed = performance.now() - started;
        const child = getSession("bench-child");
        const state = child.state;
        outputs.add(digest({
            hidden: state.hiddenOrphanRefs, clipped: state.emergencyTruncateLatch,
            deferred: state.renderDeferredRefs, dead: state.deadRefs, messages: child.pluginSnapshot,
        }));
        assert.equal(state.hiddenOrphanRefs.length, orderedMessages.length);
        assert.equal(state.deadRefs.length, count - orderedMessages.length);
        if (run > 0) timings.push(elapsed);
    } finally {
        store.cancelAll();
        store.closeQuietly();
        _resetSessionsForTest();
        _resetPluginStateForTest();
        rmSync(dir, { recursive: true, force: true });
    }
}
assert.equal(outputs.size, 1);
timings.sort((a, b) => a - b);
console.log(JSON.stringify({ count, prefix: Math.floor(count / 2), medianMs: timings[1], measuredMs: timings, sha256: [...outputs][0] }));
