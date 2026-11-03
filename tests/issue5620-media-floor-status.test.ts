import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";
import { REMOTE_IMAGE_TOKENS } from "../src/image-tokens.ts";

// #5620: dsh sessions carrying remote-URL / file-ref images climbed to ~72%
// usage while the kernel offered only tens of K of foldable mass — such
// messages can never fold (#1188/#2609) and turn integrity pins the turns
// around them (#684), so the context floor silently includes their mass.
// acp_status now names that never-foldable mass (MEDIA FLOOR) whenever it is
// a meaningful share of the window, metered at billed grade (local text
// estimate + REMOTE_IMAGE_TOKENS per remote-URL image payload — the local
// meter alone only sees the "[image]" placeholder and would never fire here).
// The gate is independent of the PRESSURE
// NOTE, whose maxPending < growth-step condition is NOT met in this state
// (pinned turns keep a range advertised forever).
// Gate-test discipline (#3617): positive rows AND negative rows (recoverable
// data-URL media, below-threshold mass, media-free sessions).

function textMsg(id: string, role: "user" | "assistant", chars: number): CoreMessage {
    return { id, role, contentType: "text", text: "x".repeat(chars) };
}

// openai-wire image part riding the host sidecar; remote URL = unrecoverable,
// data: URL = archivable (#2607) and therefore NOT unrecoverable.
function imageMsg(id: string, url: string, chars: number): CoreMessage {
    return {
        id, role: "user", contentType: "text", text: "x".repeat(chars),
        rawOpenaiContent: { type: "image_url", image_url: { url } },
    } as unknown as CoreMessage;
}

let seq = 0;
function makeCtx(messages: CoreMessage[]): {
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    messages: CoreMessage[];
    session: Session;
} {
    seq += 1;
    const session = {
        id: `i5620-${seq}`,
        meta: {},
        stats: {
            requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0,
            lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0,
            storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0,
        },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session,
    };
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

const REMOTE = "https://cdn.example.com/img-%d.png";

test("#5620 A: remote-URL image mass above 5% of the window renders a MEDIA FLOOR line", () => {
    // Realistic shape: each image part is its own core message whose local
    // text is just a caption — the mass comes from the billed-grade prior,
    // 3 × (caption + 4096) ≈ 12300 tok = ~6% of the 200000 limit ≥ 5%.
    const msgs = [
        textMsg("raw_1", "user", 4000),
        imageMsg("img_1", REMOTE.replace("%d", "1"), 16),
        textMsg("raw_2", "assistant", 4000),
        imageMsg("img_2", REMOTE.replace("%d", "2"), 16),
        imageMsg("img_3", REMOTE.replace("%d", "3"), 16),
    ];
    const out = handleAcpStatus({}, withRefs(makeCtx(msgs))).text;
    assert.ok(out.includes("MEDIA FLOOR"), `media floor line present (got: ${out.slice(0, 600)})`);
    assert.ok(out.includes("3 live message(s)"), "names the message count");
    assert.ok(out.includes("~6% of the 200000-token limit"), "mass includes the billed prior, not just captions");
    assert.ok(out.includes(String(REMOTE_IMAGE_TOKENS)), "names the per-image prior");
    assert.ok(out.includes("#1188/#2609"), "cites the never-fold provenance");
    assert.ok(out.includes("turn integrity"), "names the pinning mechanism");
});

test("#5620 B: archivable data-URL images are NOT unrecoverable — no MEDIA FLOOR (#2607)", () => {
    // Same mass as row A but every image is a data: URL — the host spills its
    // bytes at arrival, so these messages fold like ordinary text.
    const msgs = [
        imageMsg("img_1", "data:image/png;base64,QUJD", 20000),
        imageMsg("img_2", "data:image/png;base64,REVG", 20000),
        imageMsg("img_3", "data:image/png;base64,SElK", 20000),
    ];
    const out = handleAcpStatus({}, withRefs(makeCtx(msgs))).text;
    assert.ok(!out.includes("MEDIA FLOOR"), "recoverable media must not be reported as a floor");
});

test("#5620 C: below the 5% share the line stays silent (noise guard)", () => {
    // 1 remote image ≈ 4096 tok = ~2% of the limit < 5% — a stray image must
    // not paint the whole session as media-bound.
    const msgs = [textMsg("raw_1", "user", 4000), imageMsg("img_1", REMOTE.replace("%d", "1"), 16)];
    const out = handleAcpStatus({}, withRefs(makeCtx(msgs))).text;
    assert.ok(!out.includes("MEDIA FLOOR"), "sub-threshold media mass stays silent");
});

test("#5620 D: media-free sessions keep today's output exactly (additive-only change)", () => {
    const msgs = [textMsg("raw_1", "user", 4000), textMsg("raw_2", "assistant", 4000)];
    const out = handleAcpStatus({}, withRefs(makeCtx(msgs))).text;
    assert.ok(out.includes("Nudge:"), "nudge line still present");
    assert.ok(!out.includes("MEDIA FLOOR") && !out.includes("PRESSURE NOTE"), "no new sections without media mass");
});
