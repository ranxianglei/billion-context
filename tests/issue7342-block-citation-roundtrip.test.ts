import "./preload-test-env.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createCore, defaultConfig, restampContentStore, restampRefsToLedger, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { _resetStoreForTest, getStore } from "../src/persist.ts";
import { createSession } from "../src/session.ts";
import { adoptContentStore, contentStoreOf, drainPendingRetrievals, executeRetrieve, storeEffectiveCcr } from "../src/store.ts";
import { applyRanges } from "../src/stream.ts";

const quotedTranscript = '\n\n[assistant]\n\x3cacp tokens="8" type="text"\x3em00002\x3c/acp\x3e\nLiteral m00002, copied from a transcript.';

async function foldedSession(t: TestContext, backfilled: boolean, options: { legacy?: boolean; firstTagOnly?: boolean; pluginSnapshot?: "current" | "stale" } = {}) {
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
    process.env.BILI_PERSIST = "1";
    const store = getStore();
    t.after(_resetStoreForTest);
    await store.ready();

    const texts = [
        "Please compare the proposed amounts before we choose a budget.",
        "My estimate is 82 dollars for the whole order.",
        "I approve exactly 46 dollars for this purchase." + quotedTranscript,
        "I will prepare the new checklist for the team.",
        "Please keep the cover green when you update it.",
    ];
    const raw: CoreMessage[] = texts.map((text, i) => ({
        id: String(i + 1), role: i % 2 ? "assistant" : "user", contentType: "text", text,
    }));
    const session = createSession("issue7342-" + randomUUID(), { protocol: "anthropic" });
    const core = createCore();
    const ccr = { enabled: true, minToolTokens: 50 };
    const config = applyCompressSettings(defaultConfig(200_000), 200_000, {
        ccr, preserveRecentTokens: 0, preserveRecentMessages: 2, minCompressRangeChars: 80,
    });
    storeEffectiveCcr(session, ccr);
    const initialMessages = backfilled ? [raw[0]!, raw[2]!] : raw.slice(0, 3);
    const first = core.processTurn({ messages: initialMessages, state: session.state, config, tokenCount: 100 });
    const full = core.processTurn({ messages: raw, state: first.state, config, tokenCount: 200, renderTags: "text-only" });
    session.state = full.state;
    session.lastMessages = raw;
    if (options.pluginSnapshot) {
        session.pluginSnapshot = raw.map(m => m.id === "3" && options.pluginSnapshot === "stale" ? { ...m, text: "An earlier draft." } : m);
    }

    // The first complete save orders the rows by transcript. When the quote
    // arrives late, the user's approval already holds the second citation.
    await store.writeNow(session);
    const approval = raw[2]!;
    const beforeFold = session.state.messageRefs.byRaw;
    assert.equal(beforeFold[approval.id], backfilled ? "m00002" : "m00003");
    assert.equal(store.unifiedSeqByRaw(session.id)?.get(approval.id), 2);

    const messages = options.firstTagOnly ? [full.messages[0]!, ...raw.slice(1)] : full.messages;
    const ctx = { core, config, session, messages, log: () => {} };
    const fold = applyRanges(parseCompressInput({ content: [{
        startId: beforeFold[raw[0]!.id], endId: beforeFold[approval.id],
        summary: "The assistant proposed a budget and the user approved the final, lower amount.",
    }] }), ctx);
    assert.equal(fold.blocksCreated, 1, fold.text);
    if (options.legacy) {
        // Write the pre-fix store using the exact old ledger/CCR restamp before
        // reopening with the new reader. No SQL rows or frozen text are edited.
        const seq = store.unifiedSeqByRaw(session.id);
        assert.ok(seq);
        restampRefsToLedger(session.state, seq);
        adoptContentStore(session, restampContentStore(contentStoreOf(session), session.state.messageRefs.byRaw));
    }
    await store.writeNow(session);

    const blockId = session.state.blocks.find(b => b.active)?.blockId;
    assert.ok(blockId);
    return { store, session, ctx, approval, texts, blockId, originalRef: beforeFold[approval.id]! };
}

async function checkRoundTrip(t: TestContext, backfilled: boolean): Promise<void> {
    const { store, session, ctx, approval, texts, blockId, originalRef } = await foldedSession(t, backfilled);
    const cold = store.loadSync(session.id, session.meta);
    assert.ok(cold);
    assert.equal(cold.metadata.foldedCitationsPreserved, backfilled ? true : undefined);
    const opened = resolveDecompress({ blockId, full: true }, ctx).text;
    const citations = opened.matchAll(/^\[user\]\r?\n\x3cacp\b[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e\r?\n([^\r\n]+)/gm);
    const printed = [...citations].find(match => match[2] === approval.text!.split("\n")[0]);
    assert.ok(printed, "the full block displays a citation next to the user's approval");
    assert.equal(printed[1], originalRef, "first-fold alignment preserves the published citation");
    assert.ok(opened.includes(quotedTranscript), "literal tags and role-like text stay verbatim");
    const range = resolveDecompress({ blockId, startId: printed[1], endId: printed[1] }, ctx);
    assert.match(range.text, /restored 1 item\(s\)/);
    const injections = drainPendingRetrievals(session);
    assert.equal(injections.length, 1);
    const restored = injections[0]!.text ?? "";
    assert.deepEqual(texts.filter(text => restored.includes(text)), [approval.text]);
    const direct = executeRetrieve({ ref: originalRef }, session);
    assert.equal(direct.outcome, "success");
    assert.deepEqual(texts.filter(text => direct.text.includes(text)), [approval.text]);
}

test("#7342: a citation copied from an ordered block restores its displayed original", async (t) => {
    await checkRoundTrip(t, false);
});

test("#7342: a citation copied from a block after ledger alignment restores its displayed original", async (t) => {
    await checkRoundTrip(t, true);
});

test("#7342: untagged messages without a public plugin snapshot follow legacy alignment", async (t) => {
    const { store, session, blockId, approval, originalRef } = await foldedSession(t, true, { firstTagOnly: true });
    const cold = store.loadSync(session.id, session.meta);
    assert.ok(cold);
    const frozen = cold.blockContents.get(blockId)!.full.text;
    assert.ok(frozen.includes("m00001\x3c/acp\x3e\nPlease compare"));
    assert.ok(frozen.includes(quotedTranscript));
    assert.equal(cold.state.messageRefs.byRaw["1"], "m00001");
    assert.equal(cold.state.messageRefs.byRef[originalRef], "2", "the other folded message never published this number");
    assert.notEqual(cold.state.messageRefs.byRaw[approval.id], originalRef);
    assert.equal(cold.metadata.foldedCitationsPreserved, undefined);
});

test("#7342: a public plugin snapshot exposes addressable messages even without inline tags", async (t) => {
    const { store, session, blockId, approval, originalRef } = await foldedSession(t, true, { firstTagOnly: true, pluginSnapshot: "current" });
    const cold = store.loadSync(session.id, session.meta);
    assert.ok(cold);
    assert.ok(cold.blockContents.get(blockId)!.full.text.includes("[user]\n" + approval.text));
    assert.equal(cold.state.messageRefs.byRef[originalRef], approval.id);
    assert.equal(cold.metadata.foldedCitationsPreserved, true);
    const direct = executeRetrieve({ ref: originalRef }, cold);
    assert.equal(direct.outcome, "success");
    assert.ok(direct.text.includes(approval.text!));
});

test("#7342: a retained plugin snapshot with different original text cannot reserve unprinted numbers", async (t) => {
    const { store, session, originalRef } = await foldedSession(t, true, { firstTagOnly: true, pluginSnapshot: "stale" });
    const cold = store.loadSync(session.id, session.meta);
    assert.ok(cold);
    assert.equal(cold.state.messageRefs.byRef[originalRef], "2");
    assert.equal(cold.metadata.foldedCitationsPreserved, undefined);
});

test("#7342: a pre-fix SQLite block survives restart and disambiguates reused numbers without queuing someone else's words", async (t) => {
    const { session, ctx, approval, texts, blockId, originalRef } = await foldedSession(t, true, { legacy: true });
    _resetStoreForTest();
    const coldStore = getStore();
    await coldStore.ready();
    const cold = coldStore.loadSync(session.id, session.meta);
    assert.ok(cold);
    cold.lastMessages = [];
    cold.pluginSnapshot = undefined;
    const coldCtx = { ...ctx, session: cold, messages: [] };
    const live = cold.state.messageRefs.byRaw[approval.id]!;
    assert.notEqual(live, originalRef);
    const archive = cold.blockContents.get(blockId)!.full.text;
    assert.ok(archive.includes(originalRef + "\x3c/acp\x3e\n" + approval.text));
    const opened = resolveDecompress({ blockId, full: true }, coldCtx).text;
    assert.ok(opened.includes(live + "\x3c/acp\x3e\n" + approval.text), "current label is attached to the entire verified original");
    const example = /for example current:(m\d+)/.exec(opened)?.[1];
    assert.ok(example && cold.state.messageRefs.byRef[example] && opened.includes("\x3e" + example + "\x3c/acp\x3e"), "the suggested current citation is one of the displayed references");
    assert.ok(opened.includes(quotedTranscript));
    assert.equal(cold.blockContents.get(blockId)!.full.text, archive);

    const range = (startId: string, endId = startId) => resolveDecompress({ blockId, startId, endId }, coldCtx);
    const ambiguous = range(originalRef);
    assert.equal(ambiguous.outcome, "failure");
    assert.ok(ambiguous.text.includes("current:" + live) && ambiguous.text.includes("current:" + originalRef));
    assert.equal(range("m00001", originalRef).outcome, "failure", "a span cannot silently select a shifted interior");
    assert.equal(range("m00004", live).outcome, "failure", "a moved message cannot silently enter a historical span");
    assert.equal(range("current:" + live, live).outcome, "failure");
    assert.equal(drainPendingRetrievals(cold).length, 0);
    const ambiguousDirect = executeRetrieve({ ref: originalRef }, cold);
    assert.equal(ambiguousDirect.outcome, "failure");
    assert.deepEqual(texts.filter(text => ambiguousDirect.text.includes(text)), []);

    for (const [ref, expected] of [["current:" + live, approval.text], ["current:" + originalRef, texts[1]], ["m00003", texts[1]]] as const) {
        assert.match(range(ref).text, /restored 1 item\(s\)/);
        const [result] = drainPendingRetrievals(cold);
        assert.deepEqual(texts.filter(text => result?.text?.includes(text)), [expected]);
        const direct = executeRetrieve({ ref }, cold);
        assert.equal(direct.outcome, "success");
        assert.deepEqual(texts.filter(text => direct.text.includes(text)), [expected]);
    }
});

test("#7342: an unverifiable archive can still be read without serving a guessed citation", async (t) => {
    const { store, session, ctx, blockId, originalRef, texts } = await foldedSession(t, true, { legacy: true });
    session.lastMessages = [];
    session.pluginSnapshot = undefined;
    t.mock.method(store, "unifiedMessageContentByIds", () => null);
    const frozen = session.blockContents.get(blockId)!.full.text;
    const coldCtx = { ...ctx, messages: [] };
    const whole = resolveDecompress({ blockId, full: true }, coldCtx);
    assert.ok(whole.text.includes("could not be verified") && whole.text.includes(frozen));
    assert.equal(resolveDecompress({ blockId, startId: originalRef, endId: originalRef }, coldCtx).outcome, "failure");
    const direct = executeRetrieve({ ref: originalRef }, session);
    assert.equal(direct.outcome, "failure");
    assert.deepEqual(texts.filter(text => direct.text.includes(text)), []);
    assert.equal(drainPendingRetrievals(session).length, 0);
});
