// #6071 field (session-9dd7b2f0): a compress call rejected with
// kind=no-valid-ranges ("refs separator not recognized") was logged WITHOUT
// the offending payload — the server line carried only kind/keys/reasons, so
// the exact separator the model used had to be guessed from its next retry.
// Fix: the rejected warn carries a bounded preview of the offending content
// (a bare string or the string entries of a content array). Server log only;
// never echoed into the model-facing receipt (#1454), and quiet (#5161) still
// suppresses it via the shared note() helper.
//
// Gate both directions (#3617): a rejected LINE entry logs preview=; a
// rejected OBJECT entry (nothing string-shaped to preview) does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompressInput } from "../src/compress-tool.ts";
import { setLogCapture } from "../src/logger.ts";

/** Run fn under the logger's programmatic capture seam (same pattern as
 *  tests/issue5161-compress-scan-log-noise.test.ts) and return its lines. */
function withLogCapture<T>(fn: () => T): { result: T; lines: string[] } {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    try {
        return { result: fn(), lines };
    } finally {
        setLogCapture(null);
    }
}

const ACP_INPUT_LINES = (lines: string[]): string[] => lines.filter((l) => l.includes("[acp-compress-input]"));

test("#6071 rejected line entry logs a bounded preview of the offending content", () => {
    // The pinned unrecognized-separator shape (=> must stay rejected, kernel
    // guard test) — independent of which separators the kernel accepts.
    const header = "m00150 => m00168 topic\nsummary.";
    const { result, lines } = withLogCapture(() =>
        parseCompressInput({ content: [header] }),
    );
    assert.equal(result.ranges.length, 0);
    const rejected = ACP_INPUT_LINES(lines).filter((l) => l.includes("rejected:"));
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.includes("preview="), `missing preview in: ${rejected[0]}`);
    // The exact offending bytes are on the line — no more guessing from retries.
    assert.ok(rejected[0]!.includes("m00150 => m00168 topic"));
});

test("#6071 preview is bounded: a long offending entry is truncated, not dumped", () => {
    const header = `m00150 => m00168 topic\n${"x".repeat(800)}`;
    const { lines } = withLogCapture(() => parseCompressInput({ content: [header] }));
    const rejected = ACP_INPUT_LINES(lines).filter((l) => l.includes("rejected:"));
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.includes("preview="));
    assert.ok(!rejected[0]!.includes("x".repeat(200)), "preview must not carry the full payload");
});

test("#6071 rejected OBJECT entry logs no preview (nothing string-shaped to show)", () => {
    // Summary-less object entry: rejected for missing summary, but there is no
    // raw text whose shape matters — keys+reasons already name it.
    const { lines } = withLogCapture(() =>
        parseCompressInput({ content: [{ startId: "m00001", endId: "m00003" }] }),
    );
    const rejected = ACP_INPUT_LINES(lines).filter((l) => l.includes("rejected:"));
    assert.equal(rejected.length, 1);
    assert.ok(!rejected[0]!.includes("preview="), `unexpected preview: ${rejected[0]}`);
});
