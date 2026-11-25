import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    reconcileFoldCoverage,
    METADATA_EXPECTED_REBASE,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #7693 — DSH host image offload of a TOOL-CHANNEL image (read_image /
// screenshot result) was not classified as expected image-offload: the C3
// slot-pairing skipped any replacement carrying a toolCallId (tool results
// are tied to tool calls), so the drift stayed "no anchor match" and the fold
// was silently lost. The fix allows tool-channel replacements when the
// toolCallId matches the anchor's (the same tool result, just offloaded), and
// recognizes the DSH attachment image part (rawOpenaiContentParts) in the
// stored-row image marker.
const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";

let seq = 0;
function makeMsg(role: CoreMessage["role"], text: string, extra?: Partial<CoreMessage>): CoreMessage {
    seq += 1;
    return { id: `m${seq}`, role, contentType: "text", text, ...extra } as CoreMessage;
}

function baseHistory(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        out.push(makeMsg(i % 2 === 0 ? "user" : "assistant", `${i}: ${FILLER.repeat(2)}`));
    }
    return out;
}

interface Harness {
    session: Session;
    block: { active: boolean; effectiveMessageIds: string[] };
    logs: Array<[string, string]>;
    opts: { mode: "repair"; sessionId: string; log: (lvl: string, m: string) => void };
}

function harness(lane?: string): Harness {
    const block: { active: boolean; effectiveMessageIds: string[] } = { active: true, effectiveMessageIds: [] };
    const session = { state: { blocks: [block] }, metadata: lane === undefined ? {} : { pluginAgent: lane } } as unknown as Session;
    const logs: Array<[string, string]> = [];
    const opts = { mode: "repair" as const, sessionId: "t7693", log: (lvl: string, m: string) => { logs.push([lvl, m]); } };
    return { session, block, logs, opts };
}

function recordOf(session: Session): Record<string, string> | undefined {
    return (session.metadata as Record<string, unknown>)[METADATA_EXPECTED_REBASE] as Record<string, string> | undefined;
}

describe("#7693 tool-channel image offload", () => {
    test("T1: DSH read_image tool result offload pairs through C3 (same toolCallId)", () => {
        const { session, block, logs, opts } = harness("dsh");
        // The read_image tool result with an image (DSH attachment format).
        const imgTool = makeMsg("tool", "Image loaded successfully", {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const history = [imgTool, ...baseHistory(34)];
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        const storedRowLookup = (ids: readonly string[]) => ids.filter((id) => id === imgTool.id!).map((id) => ({
            seq: 1,
            msgId: id,
            content: JSON.stringify({
                id, role: "tool", contentType: "tool-result", toolCallId: "call_read_1", toolName: "read_image",
                text: "Image loaded successfully",
                rawOpenaiContentParts: [
                    { type: "image", attachment: { attachmentId: "abc123", mediaType: "image/png" } },
                    { type: "text", text: "Image loaded successfully" },
                ],
            }),
        }));
        const fullOpts = { ...opts, storedRowLookup };
        reconcileFoldCoverage(session, history, fullOpts);
        // The DSH host offloads the image: the tool result now has a placeholder
        // (same toolCallId, no image).
        const placeholder = makeMsg("tool", '[image omitted to fit request image limits; "screenshot.png" (sha256:2e896b95dec003df). Normalized copy (read-only; may be resized or re-encoded): "normalized/screenshot.png" (1600x900px, image/png).]', {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const wire2 = [placeholder, ...history.slice(1)];
        const r = reconcileFoldCoverage(session, wire2, fullOpts);
        // The same-toolCallId case is claimed by the byTool pass (the fold is
        // preserved) — assert the fold is NOT lost either way.
        const notLost = r.claims > 0 || recordOf(session)?.[imgTool.id!] === "image-offload";
        assert.ok(notLost, "the tool-channel offload must not lose the fold (claimed or C3-classified)");
        assert.ok(!logs.some(([, m]) => m.includes("no anchor match")), "tool-channel offload must not read as no-anchor-match drift");
    });

    test("T2 negative: tool-channel replacement with MISMATCHED toolCallId stays in drift", () => {
        const { session, block, logs, opts } = harness("dsh");
        const imgTool = makeMsg("tool", "Image loaded successfully", {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const history = [imgTool, ...baseHistory(34)];
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        const storedRowLookup = (ids: readonly string[]) => ids.filter((id) => id === imgTool.id!).map((id) => ({
            seq: 1,
            msgId: id,
            content: JSON.stringify({
                id, role: "tool", contentType: "tool-result", toolCallId: "call_read_1", toolName: "read_image",
                text: "Image loaded successfully",
                rawOpenaiContentParts: [
                    { type: "image", attachment: { attachmentId: "abc123", mediaType: "image/png" } },
                    { type: "text", text: "Image loaded successfully" },
                ],
            }),
        }));
        const fullOpts = { ...opts, storedRowLookup };
        reconcileFoldCoverage(session, history, fullOpts);
        // MISMATCHED toolCallId — this is NOT the same tool result.
        const mismatched = makeMsg("tool", '[image omitted to fit request image limits; "screenshot.png" (sha256:2e896b95dec003df).]', {
            toolCallId: "call_read_DIFFERENT",
            toolName: "read_image",
        });
        const wire2 = [mismatched, ...history.slice(1)];
        const r = reconcileFoldCoverage(session, wire2, fullOpts);
        assert.equal(recordOf(session)?.[imgTool.id!], undefined, "mismatched toolCallId must not classify as offload");
        assert.ok(r.missing > 0 || r.claims > 0, "genuine mismatch must still be handled");
    });

    test("T3: C3 slot-pairing classifies the offload when byTool's toolCallId bucket is ambiguous", () => {
        const { session, block, logs, opts } = harness("dsh");
        const imgTool = makeMsg("tool", "Image loaded successfully", {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const history = [imgTool, ...baseHistory(34)];
        block.effectiveMessageIds.push(...history.map((m) => m.id!));
        const storedRowLookup = (ids: readonly string[]) => ids.filter((id) => id === imgTool.id!).map((id) => ({
            seq: 1,
            msgId: id,
            content: JSON.stringify({
                id, role: "tool", contentType: "tool-result", toolCallId: "call_read_1", toolName: "read_image",
                text: "Image loaded successfully",
                rawOpenaiContentParts: [
                    { type: "image", attachment: { attachmentId: "abc123", mediaType: "image/png" } },
                    { type: "text", text: "Image loaded successfully" },
                ],
            }),
        }));
        const fullOpts = { ...opts, storedRowLookup };
        reconcileFoldCoverage(session, history, fullOpts);
        // Two wire candidates share toolCallId "call_read_1": the offload
        // placeholder at the same position as imgTool, plus a decoy further
        // down. byTool's bucket is ambiguous (2 usable same-role candidates)
        // so it skips — C3 is the pass that must classify the same-position
        // placeholder as the offload. This is the scenario T1 does not cover
        // (T1's single-candidate bucket is claimed by byTool pre-fix).
        const placeholder = makeMsg("tool", '[image omitted to fit request image limits; "screenshot.png" (sha256:2e896b95dec003df).]', {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const decoy = makeMsg("tool", "decoy tool result, different content entirely", {
            toolCallId: "call_read_1",
            toolName: "read_image",
        });
        const wire2 = [placeholder, ...history.slice(1, 20), decoy, ...history.slice(20)];
        const r = reconcileFoldCoverage(session, wire2, fullOpts);
        assert.equal(r.byTool, 0, "byTool must skip the ambiguous bucket (no claim)");
        assert.equal(recordOf(session)?.[imgTool.id!], "image-offload", "C3 must classify the same-position tool-channel offload");
        assert.equal(r.missing, 0, "the offloaded fold id must not remain missing");
        assert.ok(!logs.some(([, m]) => m.includes("no anchor match")), "no no-anchor-match drift for the C3-classified offload");
    });
});
