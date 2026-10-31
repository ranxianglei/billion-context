// #5049 item 4: decompress range endpoints go through the SAME resolution
// ladder as compress (supersededRefRejection) — a pre-restamp citation
// translates to the live refs of the SAME messages instead of falling into a
// generic "[decompress FAILED]" or silently picking a shifted window; only a
// genuinely dead cite refuses, with the compress-side actionable wording.
import test from "node:test";
import assert from "node:assert/strict";
import {
    createCore,
    defaultConfig,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { storeEffectiveCcr, drainPendingRetrievals } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

process.env.BILI_PERSIST = "0";

const pad = (n: number): string => String(n).padStart(5, "0");

// Same corpus discipline as tests/ccr-v2.test.ts: 20 messages so the
// m00001–m00007 fold range sits outside the protected recent zone.
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

type FoldResult = {
    core: ReturnType<typeof createCore>;
    config: Config;
    session: ReturnType<typeof getSession>;
    msgs: CoreMessage[];
    blockId: string;
};

function fold(): FoldResult {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: true, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`issue5049-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const raw = makeMsgs();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

function ctxOf(f: FoldResult) {
    return { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
}

/** Simulate a ledger restamp: every live ref shifts by `delta`, the vacated
 *  numbers land in session.restampSuperseded (oldRef → rawId), exactly the
 *  shape persist.ts produces on restart reconciliation. */
function restampShift(f: FoldResult, delta: number): void {
    const st = f.session.state;
    const superseded = new Map<string, string>();
    const byRef: Record<string, string> = {};
    const byRaw: Record<string, string> = {};
    // byRaw is keyed by raw id (raw → ref); the vacated KEYS of byRef are the old refs.
    for (const [raw, ref] of Object.entries(st.messageRefs.byRaw)) {
        const num = Number.parseInt(ref.slice(1), 10);
        const next = `m${String(num + delta).padStart(5, "0")}`;
        superseded.set(ref, raw);
        byRef[next] = raw;
        byRaw[raw] = next;
    }
    st.messageRefs.byRef = byRef;
    st.messageRefs.byRaw = byRaw;
    f.session.restampSuperseded = superseded;
}

test("pre-restamp citation translates to the same messages instead of failing (#5049 item 4)", () => {
    const f = fold();
    restampShift(f, 100); // m00001–m00007 → m00101–m00107
    // The model cites the numbers it saw BEFORE the restamp. Pre-fix this hit
    // "covers no messages in m00002–m00004 (its coverage is m00101–m00107)".
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctxOf(f)).text;
    assert.match(ack, /\[decompress .* m00002\u2013m00004: restored 3 item\(s\)/, `expected translated restore, got: ${ack.slice(0, 200)}`);
    const injs = drainPendingRetrievals(f.session);
    assert.equal(injs.length, 1, "one ephemeral injection queued");
    const text = injs[0]!.text!;
    // Same MESSAGES as the pre-restamp citation means: details 1–3 (h_1..h_3).
    assert.match(text, /Historical detail 1\./);
    assert.match(text, /Historical detail 2\./);
    assert.match(text, /Historical detail 3\./);
    assert.doesNotMatch(text, /Historical detail 0\./);
    assert.doesNotMatch(text, /Historical detail 4\./);
});

test("live citations pass through untouched when a superseded map exists", () => {
    const f = fold();
    restampShift(f, 100);
    // Numbers straight out of the POST-restamp acp_status surface are live —
    // the ladder must keep them as-is (case 1), not translate or refuse.
    const ack = resolveDecompress({ blockId: f.blockId, startId: "m00102", endId: "m00103" }, ctxOf(f)).text;
    assert.match(ack, /restored 2 item\(s\)/, `got: ${ack.slice(0, 200)}`);
    const text = drainPendingRetrievals(f.session)[0]!.text!;
    assert.match(text, /Historical detail 1\./);
    assert.match(text, /Historical detail 2\./);
    assert.doesNotMatch(text, /Historical detail 3\./);
});

test("a dead superseded cite refuses with the compress-side actionable wording", () => {
    const f = fold();
    restampShift(f, 100);
    // Kill the mapping of h_5 entirely (the message left the ledger map) while
    // keeping its superseded key: old m00006 → h_5 has nowhere to translate to.
    const st = f.session.state;
    delete st.messageRefs.byRaw["h_5"];
    delete st.messageRefs.byRef["m00106"];
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00006", endId: "m00006" }, ctxOf(f));
    assert.equal(out.outcome, "failure");
    assert.match(out.text, /\[decompress FAILED:/);
    assert.match(out.text, /re-numbered by the ledger alignment and no longer resolve to a live message/);
    assert.match(out.text, /acp_status/);
    assert.equal(drainPendingRetrievals(f.session).length, 0, "a refused range queues nothing");
    assert.equal(f.session.stats.rangeRestores, 0);
});

test("order check runs on the TRANSLATED endpoints (inverted old cites still swap-refused)", () => {
    const f = fold();
    restampShift(f, 100);
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00004", endId: "m00002" }, ctxOf(f));
    assert.match(out.text, /swap them/);
    assert.equal(drainPendingRetrievals(f.session).length, 0);
});

test("without a superseded map the old behavior is byte-identical (out-of-coverage still 'covers no messages')", () => {
    const f = fold();
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00015", endId: "m00016" }, ctxOf(f));
    assert.match(out.text, /covers no messages in m00015\u2013m00016/);
    assert.equal(drainPendingRetrievals(f.session).length, 0);
});
