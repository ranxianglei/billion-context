import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { responsesToCore, type BiliMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { simhashHex } from "../src/affinity-simhash.ts";
import {
    canonicalTextOf,
    normalizedIdentity,
    planReconciliation,
    reconcileFoldCoverage,
    METADATA_FOLD_COVERAGE,
    positionalFingerprint,
    wordBagDigest,
    type FoldAnchor,
} from "../src/fold-reconcile.ts";

const IMAGE_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=";
const IMAGE_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageItem = (base64: string) => ({
    type: "message" as const,
    role: "user" as const,
    content: [{ type: "input_image" as const, image_url: `data:image/png;base64,${base64}` }],
});
const textItem = (text: string) => ({
    type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text }],
});
const tailItem = textItem("Shared last message before the next upload");
const core = (input: Parameters<typeof responsesToCore>[0]["input"]): BiliMessage[] => responsesToCore({ input }).msgs;
const idOf = (message: CoreMessage): string => {
    assert.ok(message.id);
    return message.id;
};
function anchorOf(message: CoreMessage): FoldAnchor {
    const text = canonicalTextOf(message.text ?? "");
    return {
        n: normalizedIdentity(message), r: message.role, c: message.contentType, b: message.text?.length ?? 0,
        ...(!normalizedIdentity(message).startsWith("media:") && message.text ? { sh: simhashHex(text), wh: wordBagDigest(text) } : {}),
    };
}
function planFor(old: CoreMessage[], next: CoreMessage[], covered: CoreMessage[], positions: boolean) {
    const ids = old.map(idOf);
    return planReconciliation(
        ids, Object.fromEntries(covered.map((message) => [idOf(message), anchorOf(message)])), next,
        new Set(covered.map(idOf)), positions ? { ids, canon: old.map(positionalFingerprint) } : undefined,
    );
}
function assertUnclaimed(plan: ReturnType<typeof planReconciliation>, oldImage: CoreMessage, newImage: CoreMessage): void {
    assert.notEqual(idOf(oldImage), idOf(newImage), "fixture must have distinct occurrence ids");
    assert.equal(plan.claims.has(idOf(oldImage)), false,
        `new image inherited old coverage: ${JSON.stringify({ claims: [...plan.claims], byPos: plan.byPos, byNorm: plan.byNorm, bySim: plan.bySim, byOrder: plan.byOrder, byShape: plan.byShape })}`);
    assert.ok(plan.unmatched.includes(idOf(oldImage)), "vanished old image must remain honestly unmatched");
}

function legacyAnchorOf(message: CoreMessage): FoldAnchor {
    return anchorOf({ id: message.id, role: message.role, contentType: message.contentType, text: message.text });
}
function foldedSession(messages: CoreMessage[], anchor: FoldAnchor | undefined): Session {
    const ids = messages.slice(0, 2).map(idOf);
    return {
        id: "synthetic-image-reconciliation",
        state: { blocks: [
            { blockId: "b1", active: true, directMessageIds: [...ids], effectiveMessageIds: [...ids] },
            { blockId: "b2", active: false, directMessageIds: [...ids], effectiveMessageIds: [...ids] },
        ] },
        metadata: {
            foldAnchorOrder: messages.map(idOf),
            foldAnchors: { ...(anchor ? { [ids[0]]: anchor } : {}), [ids[1]]: anchorOf(messages[1]) },
        },
    } as unknown as Session;
}

describe("fold reconciliation must preserve image payload and occurrence identity", () => {
    test("Responses fixtures carry real image sidecars and payload-addressed ids", () => {
        const [a, b] = core([imageItem(IMAGE_A), imageItem(IMAGE_B)]);
        assert.equal(a.text, "[image]");
        assert.equal(b.text, "[image]");
        assert.equal(a.imageBase64, IMAGE_A);
        assert.equal(b.imageBase64, IMAGE_B);
        assert.ok(a.rawResponsesItem);
        assert.ok(b.rawResponsesItem);
        assert.notEqual(idOf(a), idOf(b));
    });

    test("different image bytes must not share normalizedIdentity", () => {
        const [a, b] = core([imageItem(IMAGE_A), imageItem(IMAGE_B)]);
        assert.notEqual(normalizedIdentity(a), normalizedIdentity(b));
    });

    test("different image bytes must not share positionalFingerprint", () => {
        const [a, b] = core([imageItem(IMAGE_A), imageItem(IMAGE_B)]);
        assert.notEqual(positionalFingerprint(a), positionalFingerprint(b));
    });

    for (const positions of [false, true]) {
        test(`different replacement image is not claimed (${positions ? "Pass 0 enabled" : "normalized fallback only"})`, () => {
            const old = core([imageItem(IMAGE_A), tailItem]);
            const next = core([imageItem(IMAGE_B), tailItem]);
            assertUnclaimed(planFor(old, next, [old[0]], positions), old[0], next[0]);
        });

        test(`new image after the shared old tail is not claimed (positions=${positions})`, () => {
            const old = core([imageItem(IMAGE_A), tailItem]);
            const next = core([tailItem, imageItem(IMAGE_B)]);
            assert.equal(idOf(old[1]), idOf(next[0]), "the shared old tail fences off the new upload");
            assertUnclaimed(planFor(old, next, [old[0]], positions), old[0], next[1]);
        });

        test(`same-payload independent upload after the old tail is not claimed (positions=${positions})`, () => {
            const old = core([imageItem(IMAGE_A), imageItem(IMAGE_A), tailItem]);
            const next = core([tailItem, imageItem(IMAGE_A)]);
            assert.equal(old[1].imageBase64, next[1].imageBase64);
            assert.equal(idOf(old[2]), idOf(next[0]), "both old occurrences precede the common tail; the new one follows it");
            assertUnclaimed(planFor(old, next, [old[1]], positions), old[1], next[1]);
        });
    }

    test("legacy image sketches cannot bypass normalized failure through simhash", () => {
        const old = core([imageItem(IMAGE_A), tailItem]);
        const next = core([imageItem(IMAGE_B), tailItem]);
        const legacy = legacyAnchorOf(old[0]);
        const plan = planReconciliation(old.map(idOf), { [old[0].id]: legacy }, next, new Set([old[0].id]), {
            ids: old.map(idOf), canon: ["legacy-image-pos", positionalFingerprint(old[1])],
        });
        assertUnclaimed(plan, old[0], next[0]);
        assert.equal(plan.bySim, 0);
    });

    test("legacy tool-call ids cannot claim a changed image payload", () => {
        const [a, b] = core([imageItem(IMAGE_A), imageItem(IMAGE_B)]);
        const old = { ...a, role: "tool" as const, contentType: "tool-result" as const, toolCallId: "same-tool-call" };
        const next = { ...b, role: "tool" as const, contentType: "tool-result" as const, toolCallId: "same-tool-call" };
        const plan = planReconciliation([old.id], { [old.id]: { ...legacyAnchorOf(old), t: old.toolCallId } }, [next], new Set([old.id]));
        assertUnclaimed(plan, old, next);
        assert.equal(plan.byTool, 0);
    });

    test("sidecar-only images retain payload-sensitive normalized and positional evidence", () => {
        const [a, b] = core([imageItem(IMAGE_A), imageItem(IMAGE_B)])
            .map((m) => ({ ...m, imageBase64: undefined }));
        assert.notEqual(normalizedIdentity(a), normalizedIdentity(b));
        assert.notEqual(positionalFingerprint(a), positionalFingerprint(b));
    });

    test("split remote images sharing a raw item cannot share identity", () => {
        const images = responsesToCore({ input: [{
            type: "message", role: "user", content: [
                { type: "input_image", image_url: "https://example.invalid/a.png" },
                { type: "input_image", image_url: "https://example.invalid/b.png" },
            ],
        }] }).msgs;
        assert.equal(images[0].rawResponsesItem, images[1].rawResponsesItem);
        assert.notEqual(normalizedIdentity(images[0]), normalizedIdentity(images[1]));
        assert.notEqual(positionalFingerprint(images[0]), positionalFingerprint(images[1]));
    });

    test("bracketed replacement image cannot inherit a slot through byOrder", () => {
        const old = core([textItem("left marker"), imageItem(IMAGE_A), ...[0, 1, 2].map((n) => textItem(`right marker ${n}`))]);
        const next = old.map((m, i) => i === 1 ? core([imageItem(IMAGE_B)])[0] : { ...m, id: `churn-${i}` });
        const legacy = { ...legacyAnchorOf(old[1]), n: "old-image-norm", sh: undefined, wh: undefined };
        const anchors = Object.fromEntries(old.map((m, i) => [m.id, i === 1 ? legacy : anchorOf(m)]));
        const plan = planReconciliation(old.map(idOf), anchors, next, new Set(old.map(idOf)), {
            ids: old.map(idOf), canon: old.map((m, i) => i === 1 ? "legacy-image-pos" : positionalFingerprint(m)),
        });
        assert.ok(plan.byPos >= 2, "verified positional claims bracket the replaced image");
        assertUnclaimed(plan, old[1], next[1]);
        assert.equal(plan.byOrder, 0);
    });

    test("legacy image sketch mass cannot claim different images through shape census", () => {
        const old = core([...Array.from({ length: 4 }, () => imageItem(IMAGE_A)), tailItem]);
        const next = core([...Array.from({ length: 4 }, () => imageItem(IMAGE_B)), tailItem]);
        const anchors = Object.fromEntries(old.slice(0, 4).map((m) => [m.id, { ...legacyAnchorOf(m), n: "no-norm-match" }]));
        const plan = planReconciliation(old.map(idOf), anchors, next, new Set(old.slice(0, 4).map(idOf)));
        assert.equal(plan.claims.size, 0);
        assert.equal(plan.byShape, 0);
        assert.deepEqual(plan.unmatched, old.slice(0, 4).map(idOf));
    });

    for (const evidence of ["legacy", "wrong-payload"] as const) {
        test(`self-heal exact-id image with ${evidence} evidence without unfolding text`, () => {
            const messages = core([imageItem(IMAGE_A), ...Array.from({ length: 10 }, (_, n) => textItem(`retained message ${n}`))]);
            const anchor = evidence === "legacy" ? legacyAnchorOf(messages[0]) : anchorOf(core([imageItem(IMAGE_B)])[0]);
            const session = foldedSession(messages, anchor);
            reconcileFoldCoverage(session, messages, { mode: "repair", log: () => {} });
            for (const block of session.state.blocks) {
                assert.deepEqual(block.effectiveMessageIds, [messages[1].id]);
                assert.deepEqual(block.directMessageIds, [messages[1].id]);
            }
            const coverage = session.metadata[METADATA_FOLD_COVERAGE] as Record<string, { p: number; t: number }>;
            assert.equal(coverage.b1.p, 1);
            assert.equal(coverage.b1.t, 1);
            assert.equal((session.metadata.foldAnchors as Record<string, FoldAnchor>)[messages[0].id], undefined);
            assert.equal(session.state.blocks[0].active, true);
        });
    }

    test("newly folded image without an anchor seeds payload evidence instead of unfolding", () => {
        const messages = core([imageItem(IMAGE_A), ...Array.from({ length: 10 }, (_, n) => textItem(`retained message ${n}`))]);
        const session = foldedSession(messages, undefined);
        for (let n = 0; n < 2; n++) {
            reconcileFoldCoverage(session, messages, { mode: "repair", log: () => {} });
            assert.deepEqual(session.state.blocks[0].effectiveMessageIds, messages.slice(0, 2).map(idOf));
            const anchor = (session.metadata.foldAnchors as Record<string, FoldAnchor>)[messages[0].id];
            assert.equal(anchor.n, normalizedIdentity(messages[0]));
            assert.equal(anchor.sh, undefined);
            assert.equal(anchor.wh, undefined);
        }
    });

    test("inline image identity ignores unrelated raw message metadata", () => {
        const [image] = core([imageItem(IMAGE_A)]);
        const restamped = { ...image, rawResponsesItem: { ...imageItem(IMAGE_A), cache_control: { type: "ephemeral" } } };
        assert.equal(normalizedIdentity(image), normalizedIdentity(restamped));
        assert.equal(positionalFingerprint(image), positionalFingerprint(restamped));
    });

    test("payload-aware exact-id image stays covered across repeated reconciliation", () => {
        const messages = core([imageItem(IMAGE_A), ...Array.from({ length: 10 }, (_, n) => textItem(`retained message ${n}`))]);
        const session = foldedSession(messages, anchorOf(messages[0]));
        for (let n = 0; n < 2; n++) {
            reconcileFoldCoverage(session, messages, { mode: "repair", log: () => {} });
            assert.deepEqual(session.state.blocks[0].effectiveMessageIds, messages.slice(0, 2).map(idOf));
        }
    });

    test("warn mode does not mutate legacy image coverage", () => {
        const messages = core([imageItem(IMAGE_A), ...Array.from({ length: 10 }, (_, n) => textItem(`retained message ${n}`))]);
        const session = foldedSession(messages, legacyAnchorOf(messages[0]));
        reconcileFoldCoverage(session, messages, { mode: "warn", log: () => {} });
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, messages.slice(0, 2).map(idOf));
    });

    test("host-pinned exact ids keep text and matching-media coverage", () => {
        const messages = core([imageItem(IMAGE_A), ...Array.from({ length: 10 }, (_, n) => textItem(`retained message ${n}`))])
            .map((m, i) => ({ ...m, id: `host-msg-${i}` }));
        const session = foldedSession(messages, anchorOf(messages[0]));
        reconcileFoldCoverage(session, messages, { mode: "repair", log: () => {} });
        assert.deepEqual(session.state.blocks[0].effectiveMessageIds, ["host-msg-0", "host-msg-1"]);
        assert.equal(messages[0].id, "host-msg-0");
    });

    test("positive control: whitespace-only text churn still reanchors", () => {
        const old = core([textItem("alpha  beta\r\n\r\ngamma"), tailItem]);
        const next = core([textItem("alpha beta\ngamma"), tailItem]);
        const plan = planFor(old, next, [old[0]], false);
        assert.deepEqual(plan.claims.get(idOf(old[0])), [idOf(next[0])]);
        assert.equal(plan.byNorm, 1);
        assert.deepEqual(plan.unmatched, []);
    });

    test("positive control: unchanged old image retains its existing coverage", () => {
        const old = core([imageItem(IMAGE_A), tailItem]);
        const next = core([imageItem(IMAGE_A), tailItem]);
        const plan = planFor(old, next, [old[0]], true);
        assert.equal(idOf(old[0]), idOf(next[0]));
        assert.deepEqual(plan.unmatched, []);
        assert.equal(plan.claims.size, 0, "already-present old image needs no coverage rewrite");
    });

    test("positive control: retained old occurrence does not cover a newly appended duplicate", () => {
        const old = core([imageItem(IMAGE_A), tailItem]);
        const next = core([imageItem(IMAGE_A), tailItem, imageItem(IMAGE_A)]);
        const plan = planFor(old, next, [old[0]], true);
        assert.notEqual(idOf(old[0]), idOf(next[2]));
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.unmatched, []);
    });
});
