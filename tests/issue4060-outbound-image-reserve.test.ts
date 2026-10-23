import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { BiliMessage } from "acp-kernel/wire";
import type { CoreMessage } from "acp-kernel";
import { imageReserveFor, outboundImageReserve } from "../src/server.ts";
import type { Session } from "../src/session.ts";

// #4060: the window meter counted IMAGES ON THE INBOUND BODY while the egress
// prune had already dropped them. A screenshot-heavy session resends its whole
// history every turn, so a fold that removes 300 screenshots from the wire left
// the inbound body unchanged — the reserve kept charging for pixels nobody was
// billed for, the meter read several hundred percent, and the nudge
// emergency-suppressed the very folds that would have shrunk the payload
// (production: usage=863% with a 196KiB outbound body). Learning already
// measures the OUTBOUND wire body (noteForwardedImageFacts on wireBody), so
// consuming the inbound body was an asymmetry, not a design.
//
// These unit tests pin the new caliber: the reserve is charged on the messages
// that survive the prune, and it can only ever be at or below the inbound
// reading (a fold removes images, it never adds any).

const UPSTREAM = "https://upstream.example/v1";
const OPTS_BYTES = { routes: {}, imageBilling: "bytes" } as unknown as Parameters<typeof outboundImageReserve>[2];

let seq = 0;
function makeSession(blocks: Session["state"]["blocks"] = [], metadata: Record<string, unknown> = {}): Session {
    seq += 1;
    return {
        id: `i4060-${seq}`,
        metadata,
        stats: {},
        state: { blocks, messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function activeBlock(id: string, ids: string[]): Session["state"]["blocks"][number] {
    return {
        blockId: id,
        runId: "r1",
        tier: 1,
        summary: `summary of ${ids.length} messages`,
        directMessageIds: ids,
        effectiveMessageIds: ids,
        directBlockIds: [],
        compressedTokens: 1000,
        createdAt: 1,
        survivedCount: 0,
        generation: "young",
        active: true,
    } as Session["state"]["blocks"][number];
}

/** An anthropic image core: the base64 rides the rawAnthropicBlock sidecar, the
 *  text projection is a short note — exactly the shape whose mass the text-only
 *  token model cannot see (#488). */
function anthropicImage(id: string, b64: string): CoreMessage {
    return {
        id,
        role: "tool",
        contentType: "tool-result",
        text: "<type>image</type>",
        rawAnthropicBlock: {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: b64 },
        },
    } as unknown as BiliMessage;
}

function textMessage(id: string, text: string): CoreMessage {
    return { id, role: "assistant", contentType: "text", text };
}

test("#4060 unit: images covered by an active block are NOT reserved (prune drops them off the wire)", () => {
    const b64 = "A".repeat(4000);
    // The opening user turn is pinned by the kernel (#3642), so the foldable
    // images ride tool results — the production shape (screenshots returned by
    // read_image land in tool_result cores).
    const msgs = [textMessage("u1", "hi"), anthropicImage("a1", b64), anthropicImage("a2", b64), textMessage("t1", "hello")];
    const session = makeSession([activeBlock("b1", ["a1", "a2"])]);

    // The inbound body still carries both images — the old caliber keeps
    // charging for them every turn, forever.
    const inbound = { messages: [{ role: "user", content: msgs.slice(1, 3).map((m) => (m as unknown as BiliMessage).rawAnthropicBlock) }] };
    assert.equal(imageReserveFor(session, "anthropic", inbound, OPTS_BYTES, UPSTREAM), Math.ceil(4000 / 4) * 2, "inbound caliber charges the folded images");

    assert.equal(outboundImageReserve(session, msgs, OPTS_BYTES, UPSTREAM), 0, "outbound caliber charges only what survives the prune");
});

test("#4060 unit: images that survive the prune are charged per-image at the billing caliber", () => {
    const b64 = "B".repeat(4000);
    const session = makeSession();
    const msgs = [anthropicImage("a1", b64), textMessage("t1", "hello")];
    assert.equal(outboundImageReserve(session, msgs, OPTS_BYTES, UPSTREAM), Math.ceil(4000 / 4));

    const two = [anthropicImage("a1", b64), anthropicImage("a2", b64)];
    assert.equal(outboundImageReserve(session, two, OPTS_BYTES, UPSTREAM), Math.ceil(4000 / 4) * 2, "n images, n charges");
});

test("#4060 unit: an image nested in an anthropic tool_result counts too (#1995 parity)", () => {
    const b64 = "C".repeat(8000);
    const msg = {
        id: "tr1",
        role: "tool",
        contentType: "tool-result",
        text: "<type>image</type>",
        rawAnthropicBlock: {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }],
        },
    } as unknown as BiliMessage;
    assert.equal(outboundImageReserve(makeSession(), [msg], OPTS_BYTES, UPSTREAM), Math.ceil(8000 / 4));
});

test("#4060 unit: text-only wires reserve zero", () => {
    const session = makeSession();
    assert.equal(outboundImageReserve(session, [textMessage("t1", "x".repeat(10_000))], OPTS_BYTES, UPSTREAM), 0);
    assert.equal(outboundImageReserve(session, [], OPTS_BYTES, UPSTREAM), 0);
});

test("#4060 unit: learned truth bounds the prior but never exceeds it", () => {
    const b64 = "D".repeat(4000); // bytes caliber prior: 1000/image
    const msgs = [anthropicImage("a1", b64), anthropicImage("a2", b64)];
    const learned = (cost: number) => makeSession([], { learnedImageCosts: { "upstream.example": { cost, seen: 3, ts: Date.now(), fp: "bytes:0" } } });

    // Cheaper learned per-image cost (a real encoder bills far less than the
    // bytes prior) → the learned reserve wins.
    assert.equal(outboundImageReserve(learned(100), msgs, OPTS_BYTES, UPSTREAM), 200);
    // Dearer learned cost → the physical prior caps it; learning can never
    // inflate the reserve past what the payload could possibly bill.
    assert.equal(outboundImageReserve(learned(50_000), msgs, OPTS_BYTES, UPSTREAM), 2000);
    // Stale fingerprint (billing reconfigured since learning) → prior.
    assert.equal(
        outboundImageReserve(makeSession([], { learnedImageCosts: { "upstream.example": { cost: 100, seen: 3, ts: Date.now(), fp: "pixels:0" } } }), msgs, OPTS_BYTES, UPSTREAM),
        2000,
    );
});

test("#4060 unit: the outbound caliber never exceeds the inbound one — a fold can only shrink the reserve", () => {
    const b64 = "E".repeat(4000);
    // Three images, one of them folded: the outbound reserve must land exactly
    // on the surviving pair, and always at or below what the inbound body bills.
    const msgs = [textMessage("u1", "hi"), anthropicImage("a1", b64), anthropicImage("a2", b64), anthropicImage("a3", b64), textMessage("t1", "done")];
    const inbound = { messages: [{ role: "user", content: [1, 2, 3].map((i) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: i === 3 ? "Z".repeat(4000) : b64 } })) }] };
    const session = makeSession([activeBlock("b1", ["a2"])]);

    const inboundTokens = imageReserveFor(session, "anthropic", inbound, OPTS_BYTES, UPSTREAM);
    const outboundTokens = outboundImageReserve(session, msgs, OPTS_BYTES, UPSTREAM);
    assert.equal(inboundTokens, Math.ceil(4000 / 4) * 3, "inbound bills all three images");
    assert.equal(outboundTokens, Math.ceil(4000 / 4) * 2, "outbound bills only the two that survive the fold");
    assert.ok(outboundTokens <= inboundTokens, "the fold can only shrink the image reserve");
});

test("#4060 unit: a session that never folded keeps the inbound caliber exactly (no regression)", () => {
    const b64 = "F".repeat(4000);
    const msgs = [textMessage("u1", "hi"), anthropicImage("a1", b64), textMessage("t1", "done")];
    const inbound = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }] };
    const session = makeSession();
    assert.equal(
        outboundImageReserve(session, msgs, OPTS_BYTES, UPSTREAM),
        imageReserveFor(session, "anthropic", inbound, OPTS_BYTES, UPSTREAM),
        "with nothing covered, both calibers must agree — the fix is inert on unfurled sessions",
    );
});

test("#4060 unit: byte-less media shapes shrink the reserve without any fold (documented delta)", () => {
    // The no-fold equality above holds for inline base64/data-URL images. Media
    // shapes the inbound body walker prices but whose bytes messageImageBytes
    // cannot carry (remote URLs ride as a small URL string; redacted_thinking
    // carries signature payload, not pixels) drop out of the metering reserve
    // even on an unfolded session: outbound ≤ inbound still holds, and
    // preflight prices these shapes through the body walker on the actual
    // forward body, so overflow stays backstopped.
    const urlMsg = {
        id: "u-img",
        role: "user",
        contentType: "text",
        text: "",
        rawOpenaiContentParts: [{ type: "image_url", image_url: { url: "https://img.example/x.png" } }],
    } as unknown as BiliMessage;
    const urlInbound = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://img.example/x.png" } }] }] };
    assert.equal(imageReserveFor(makeSession(), "openai", urlInbound, OPTS_BYTES, UPSTREAM), 4096, "inbound walker flat-prices the remote URL");
    assert.equal(outboundImageReserve(makeSession(), [urlMsg], OPTS_BYTES, UPSTREAM), 0, "outbound view carries no pixels for a URL reference");

    const rtData = "R".repeat(8000);
    const rtMsg = {
        id: "rt1",
        role: "assistant",
        contentType: "reasoning",
        text: "",
        rawAnthropicBlock: { type: "redacted_thinking", data: rtData },
    } as unknown as BiliMessage;
    const rtInbound = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: rtData }] }] };
    assert.equal(imageReserveFor(makeSession(), "anthropic", rtInbound, OPTS_BYTES, UPSTREAM), 2000, "inbound walker bills the redacted payload");
    assert.equal(outboundImageReserve(makeSession(), [rtMsg], OPTS_BYTES, UPSTREAM), 0, "no indexable image bytes in the outbound view");
});
