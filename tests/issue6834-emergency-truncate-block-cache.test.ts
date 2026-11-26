import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { createCore, createInitialState, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { getSession } from "../src/session.ts";

// #6834: emergency truncation clips the MIDDLE of large tool-results in the
// DISPLAY view (turn.messages → ctx.messages) while the raw resend
// (ctx.compressMessages) stays complete. applyCompression (stream.ts) folds
// from the complete source, but the block-content ORIGINAL cache used to prefer
// the nonempty display view — so a block folded while emergency truncation was
// armed cached the CLIPPED text, and a later whole-block full decompress served
// the wrong (clipped) cache even though compression had the complete source.
//
// The regression arms REAL emergency truncation (tokenCount past the 0.95
// threshold), compresses a range spanning the clipped tool-result, clears both
// live views, and requests full restoration: the restored text must still carry
// the checksum that sat in the clipped middle.

const CHECKSUM = "CHECKSUM_MID_6834_abc123";

function makeCtx() {
    const core = createCore();
    const config = defaultConfig(200000) as Config;
    const session = getSession(`t6834-${Math.random().toString(36).slice(2)}`);
    return { core, config, session };
}

/** Build a history whose 3rd message is a large tool-result carrying CHECKSUM
 *  in its clipped middle, run processTurn with a tokenCount that arms REAL
 *  emergency truncation, and return the split views (display clipped, raw
 *  complete) plus the session. */
function armEmergencyTruncate() {
    const { core, config, session } = makeCtx();
    const bigToolResult = `${"A".repeat(4000)}\n${CHECKSUM}\n${"B".repeat(4000)}`;
    const original: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "Run the build and report the result." },
        { id: "a1", role: "assistant", contentType: "tool-call", toolName: "bash", text: "npm run build" },
        { id: "t1", role: "tool", contentType: "tool-result", toolName: "bash", text: bigToolResult },
        { id: "a2", role: "assistant", contentType: "text", text: "The build succeeded." },
        { id: "u2", role: "user", contentType: "text", text: "Now run the tests." },
        { id: "a3", role: "assistant", contentType: "tool-call", toolName: "bash", text: "npm test" },
        { id: "t2", role: "tool", contentType: "tool-result", toolName: "bash", text: "ok 1 - all tests passed" },
        { id: "a4", role: "assistant", contentType: "text", text: "All tests passed." },
    ];
    // 0.95 * 200000 = 190000; 195000 arms the emergency-truncate node.
    const turn = core.processTurn({
        messages: original,
        state: session.state,
        config,
        tokenCount: 195000,
        renderTags: "text-only",
    });
    session.state = turn.state;
    return { core, config, session, original, display: turn.messages };
}

test("#6834: emergency truncation clips the display view's tool-result middle", () => {
    const { display, original } = armEmergencyTruncate();
    const clipped = display.find((m) => m.id === "t1");
    const complete = original.find((m) => m.id === "t1");
    assert.ok(clipped && complete, "tool-result present in both views");
    // The raw resend keeps the checksum; the display view lost its clipped middle.
    assert.ok(complete!.text!.includes(CHECKSUM), "raw view keeps the checksum");
    assert.ok(!clipped!.text!.includes(CHECKSUM), "display view lost the checksum to emergency truncation");
    assert.ok(clipped!.text!.includes("[truncated for context space]"), "display view carries the truncation marker");
});

test("#6834: full restoration after emergency truncation keeps the clipped middle (cache from complete source)", () => {
    const { core, config, session, original, display } = armEmergencyTruncate();
    // Loop paths hand the folded/display view as `messages` and the raw resend
    // as `compressMessages`; the original cache must be built from the latter.
    const ctx = { core, config, messages: display, compressMessages: original, session, log: () => {} };
    applyRanges(
        parseCompressInput({
            content: [
                {
                    startId: "m00001",
                    endId: "m00004",
                    summary: "Build ran and succeeded: the user asked to build, the build command was executed, and the assistant reported success before the user asked to run tests.",
                },
            ],
        }),
        ctx as never,
    );
    const blockId = [...session.state.blocks].slice(-1)[0]?.blockId;
    assert.ok(blockId, "a block was created for the compressed range");
    assert.ok(session.blockContents.has(blockId!), "original cache populated at compress time");

    // Clear BOTH live views (the cross-round case: neither carries the
    // originals by the time decompress runs) and request full restoration.
    ctx.messages = [];
    ctx.compressMessages = [];
    const out = resolveDecompress({ blockId: blockId!, full: true }, ctx as never).text;
    assert.ok(out.includes(CHECKSUM), `full restoration must keep the clipped middle — checksum absent means the original cache was built from the truncated display view (#6834):\n${out.slice(0, 400)}`);
});
