import test from "node:test";
import assert from "node:assert/strict";
process.env.BILI_PERSIST = "0";
import {
    applyRetrieve,
    buildStoredPlaceholder,
    countMessageTokens,
    createContentStore,
    normalizeHead,
    type CompressionState,
    type CoreMessage,
} from "acp-kernel";
import { foldSummariesToCcrPlaceholders } from "../src/server/fold-summary-ccr.js";

const PROSE =
    "Compressed history: the user asked about X, we ran Y, then discussed Z in detail across several turns.";

function summaryMsg(text: string): CoreMessage {
    return { id: "acp_summary_b1", role: "system", contentType: "text", text } as CoreMessage;
}

function state(): CompressionState {
    return {
        messageRefs: {
            byRaw: { acp_summary_b1: "m00005" },
            byRef: { m00005: "acp_summary_b1" },
        },
    } as unknown as CompressionState;
}

test("renders a rendered-summary egress message as a deterministic CCR placeholder and stores its prose", () => {
    const m = summaryMsg(PROSE);
    const res = foldSummariesToCcrPlaceholders([m], state(), createContentStore(), "acp_retrieve");
    assert.equal(res.changed, true);
    const expected = buildStoredPlaceholder({
        ref: "m00005",
        kind: "compressed history",
        tokens: countMessageTokens(m),
        head: normalizeHead(PROSE, 96),
        retrieveToolName: "acp_retrieve",
    });
    assert.equal(res.messages[0].text, expected);
    const got = applyRetrieve({ store: res.store, ref: "m00005" });
    assert.equal(got.ok, true);
    if (got.ok) assert.equal(got.text, PROSE);
});

test("leaves non-summary messages byte-identical and reports no store change", () => {
    const user = { id: "u1", role: "user", contentType: "text", text: "current question" } as CoreMessage;
    const res = foldSummariesToCcrPlaceholders([user], state(), createContentStore(), "acp_retrieve");
    assert.equal(res.changed, false);
    assert.equal(res.messages[0], user);
});

test("is idempotent on re-egress of an already-stored summary (no re-store)", () => {
    const first = foldSummariesToCcrPlaceholders([summaryMsg(PROSE)], state(), createContentStore(), "acp_retrieve");
    assert.equal(first.changed, true);
    const second = foldSummariesToCcrPlaceholders([summaryMsg(PROSE)], state(), first.store, "acp_retrieve");
    assert.equal(second.changed, false);
    assert.equal(second.messages[0].text, first.messages[0].text);
});
