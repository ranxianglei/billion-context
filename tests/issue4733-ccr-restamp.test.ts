import test from "node:test";
import assert from "node:assert/strict";
import {
    createContentStore,
    createCore,
    defaultConfig,
    storeOriginal,
    type Config,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { adoptContentStore, contentStoreOf, drainPendingRetrievals, storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

// #4733: after restampRefsToLedger renumbers the ref map (ref = seq+1), a CCR
// content store that was NOT re-keyed holds a stored original under a ref the
// map now vends to a DIFFERENT message — range restore would silently serve
// another message's original under this one's citation, and the plugin fork
// snapshot's alias gate would reject the whole session. Two guards:
// (a) range restore cross-checks entry.rawId === raw and falls back to the
//     view text on mismatch (this file);
// (b) persist's restamp pass re-keys the store via kernel restampContentStore
//     (kernel/tests/ccr-restamp.test.ts) and fork's alias gate skips
//     unmapped raw ids instead of throwing on frozen dead aliases.

function makeMsgs(): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    return msgs;
}

function foldWithPoisonedAlias(): { core: ReturnType<typeof createCore>; config: Config; session: ReturnType<typeof getSession>; msgs: CoreMessage[]; blockId: string } {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: true, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`issue4733-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw = makeMsgs();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    // Fold-time store is CORRECT for m00002/m00004, but m00003 carries a
    // post-restamp frozen alias: the stored original belongs to h_17 while the
    // citation m00003 is covered raw h_2's number.
    const store: MessageContentStore = storeOriginal(createContentStore(), { ref: `m${pad(2)}`, rawId: "h_1", kind: "text", tokens: 4, text: "ORIGINAL h_1", head: "ORIGINAL h_1" });
    const poisoned = storeOriginal(store, { ref: `m${pad(3)}`, rawId: "h_17", kind: "text", tokens: 4, text: "FOREIGN ORIGINAL OF h_17", head: "FOREIGN" });
    const full = storeOriginal(poisoned, { ref: `m${pad(4)}`, rawId: "h_3", kind: "text", tokens: 4, text: "ORIGINAL h_3", head: "ORIGINAL h_3" });
    adoptContentStore(session, full);
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history folded: messages 1-7 covered initial setup details.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { core, config, session, msgs: turn.messages, blockId: block!.blockId };
}

test("#4733: range restore never serves another raw id's stored original", () => {
    const f = foldWithPoisonedAlias();
    const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctx).text;
    assert.match(ack, /restored 3 item\(s\)/);
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1, "one ephemeral injection queued");
    const restored = injs[0]!.text!;
    assert.ok(restored.includes("ORIGINAL h_1"), "correct alias still restored from store");
    assert.ok(restored.includes("ORIGINAL h_3"), "correct alias still restored from store");
    assert.ok(!restored.includes("FOREIGN ORIGINAL OF h_17"), "a foreign raw id's stored original must NOT be served under h_2's citation");
    assert.match(restored, /Historical detail 2\./, "the poisoned ref falls back to the view text of its own raw id (h_2)");
});

test("#4733: intact store keeps the stored-restore path (negative control)", () => {
    const f = foldWithPoisonedAlias();
    // Heal the alias exactly the way the kernel re-key does: the live mapping
    // (h_2 owns m00003 now) claims the key.
    const store = contentStoreOf(f.session);
    const healed = { ...store, byRef: { ...store.byRef, [`m${pad(3)}`]: { ...store.byRef[`m${pad(3)}`]!, rawId: "h_2" } } };
    adoptContentStore(f.session, healed);
    const ctx = { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctx).text;
    assert.match(ack, /restored 3 item\(s\)/);
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1);
    const restored = injs[0]!.text!;
    assert.ok(!restored.includes("Historical detail 2."), "stored entry wins over the view text when the alias is consistent");
    assert.ok(restored.includes("FOREIGN ORIGINAL OF h_17"), "the healed alias serves its stored original");
});
