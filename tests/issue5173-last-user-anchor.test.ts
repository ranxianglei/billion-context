// #5173: dsh host-injected user-role messages landing right after the newest
// human request stole the Rule-3 "last user message" protected slot, so the
// live instruction folded away and the model answered a finished topic.
// The kernel half (#5109: lastUserAnchor skips virtual-path messages) shipped
// in v0.1.210 covering the five then-classified families; this file pins the
// remaining dsh families at both levels — classifier units (#3617 positive +
// negative rows) for the three NEW classifiers, the BOTH-registries wiring
// (the defect class here was exactly "classified but unwired into the slot
// exclusion set"), and the end-to-end anchor geometry through the REAL dsh
// classifier rather than an id-based stub.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assignRefs, createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import {
    dshAgentRelayPath,
    dshMnemonPath,
    dshSubagentSettledPath,
    durableMessageToolPaths,
    oneShotCarrierPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";

function mk(id: string, role: CoreMessage["role"], text: string): CoreMessage {
    return { id, role, contentType: "text", text } as CoreMessage;
}

describe("#5173 new dsh injection classifiers", () => {
    test("dshMnemonPath: prefix positives, role/contentType negatives, near-misses", () => {
        assert.equal(dshMnemonPath(mk("u1", "user", "[MNEMON] recall: user prefers terse diffs")), "oneshot/mnemon");
        assert.equal(dshMnemonPath(mk("u2", "user", "[MNEMON RUNTIME MEMORY] session budget note")), "oneshot/mnemon");
        assert.equal(dshMnemonPath(mk("u3", "user", "  [mnemon] leading pad + lowercase tag still machine-generated")), "oneshot/mnemon");
        assert.equal(dshMnemonPath(mk("u4", "assistant", "[MNEMON] echo must never classify (#2766)")), undefined, "assistant echo must never classify");
        assert.equal(dshMnemonPath(mk("u5", "user", "we noted [MNEMON] earlier in chat")), undefined, "marker mid-text is not a carrier");
        assert.equal(dshMnemonPath(mk("u6", "user", "[MNEMONX] different tag")), undefined, "no closing-bracket-space boundary → different tag");
        const tool = { id: "u7", role: "tool" as const, contentType: "tool-result" as const, text: "[MNEMON] x" } as CoreMessage;
        assert.equal(dshMnemonPath(tool), undefined, "tool channel is not a carrier surface");
    });

    test("dshSubagentSettledPath: settlement positives, prose near-miss, role negative", () => {
        const settled = "Background subagent session-a1b2 finished and will do no further work unless you send it more.";
        assert.equal(dshSubagentSettledPath(mk("s1", "user", settled)), "oneshot/subagent-settled");
        assert.equal(dshSubagentSettledPath(mk("s2", "user", "background subagent 3 was stopped before it finished.")), "oneshot/subagent-settled", "asciiCI like the other auto-injected families");
        assert.equal(dshSubagentSettledPath(mk("s3", "assistant", settled)), undefined, "assistant echo must never classify (#2766)");
        assert.equal(dshSubagentSettledPath(mk("s4", "user", "Background subagents are handy for parallel work")), undefined, "prose starting with the words stays unmatched (trailing-space boundary)");
        assert.equal(dshSubagentSettledPath(mk("s5", "user", "the background subagent failed again")), undefined, "marker mid-text is not a carrier");
    });

    test("dshAgentRelayPath: wrapper positives, echo/near-miss negatives", () => {
        assert.equal(dshAgentRelayPath(mk("r1", "user", "Agent session-42 sent a message: please review the draft")), "oneshot/agent-relay");
        assert.equal(dshAgentRelayPath(mk("r2", "user", "Agent 7 sent a message: done")), "oneshot/agent-relay", "counter-form session id");
        assert.equal(dshAgentRelayPath(mk("r3", "assistant", "Agent session-42 sent a message: forged echo (#2766)")), undefined, "assistant echo must never classify");
        assert.equal(dshAgentRelayPath(mk("r4", "user", "I sent a message: hello there")), undefined, "no Agent lead-in → plain prose");
        assert.equal(dshAgentRelayPath(mk("r5", "user", "Agent X sent a message:no-space joint")), undefined, "the wrapper joint always carries the space");
    });
});

describe("#5173 registry wiring", () => {
    test("all ten dsh families resolve in BOTH the slot-exclusion and drift-accounting registries", () => {
        const samples: Array<[string, string]> = [
            ["\x3csystem-reminder\x3e \x3cavailable_skills\x3e updated catalog \x3c/available_skills\x3e", "durable/skill-catalog"],
            ["Instructions from: /home/x/.dsh/AGENTS.md", "durable/agents-md"],
            ["Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", "durable/runtime-context"],
            ["\x3cmcp_catalog\x3e registered servers \x3c/mcp_catalog\x3e", "durable/mcp-catalog"],
            ["Time sampled while preparing turn 9, step 1: 2026-11-01T00:00:00Z", "oneshot/time-context"],
            ["\x3cpath\x3ex.png\x3c/path\x3e \x3ctype\x3eimage\x3c/type\x3e \x3ccontent\x3epng bytes\x3c/content\x3e", "oneshot/ptc-image"],
            ['background job bash-abcd (bash: "true") finished [status: completed, exit code: 0]. Read its output with job_output.', "oneshot/tool-job-notice"],
            ["[MNEMON] recall note", "oneshot/mnemon"],
            ["Background subagent session-x finished and will do no further work unless you send it more.", "oneshot/subagent-settled"],
            ["Agent session-y sent a message: over there", "oneshot/agent-relay"],
        ];
        for (const [text, expected] of samples) {
            const msg = mk("w", "user", text);
            assert.equal(durableMessageToolPaths.dsh!(msg), expected, `slot-exclusion registry misses ${expected}`);
            assert.equal(oneShotCarrierPaths.dsh!(msg), expected, `drift-accounting registry misses ${expected}`);
        }
    });
});

describe("#5173 end-to-end anchor geometry", () => {
    test("fold covering the injection tail keeps the live request visible (THE repro)", () => {
        // Filler pads every message past config.compress.minCompressRange
        // (mirrors kernel/tests/issue5109's .repeat(120) bodies); appended
        // AFTER each marker so prefix classifiers still see a clean head.
        const PAD = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(12);
        const LIVE = "current live request: run the migration now";
        const all: CoreMessage[] = [
            mk("p1", "user", `old question ${PAD}`),
            mk("p2", "assistant", `old answer ${PAD}`),
            mk("p3", "user", LIVE),
            mk("p4", "user", `\x3csystem-reminder\x3e \x3cavailable_skills\x3e updated catalog \x3c/available_skills\x3e ${PAD}`),
            mk("p5", "user", `Time sampled while preparing turn 9, step 1: 2026-11-01T00:00:00Z ${PAD}`),
            mk("p6", "user", `[MNEMON] recall: prefer terse diffs ${PAD}`),
            mk("p7", "user", `Background subagent session-a1b2 finished and will do no further work unless you send it more. ${PAD}`),
            mk("p8", "user", `Agent session-c3d4 sent a message: draft is ready ${PAD}`),
            mk("p9", "user", `\x3cpath\x3ex.png\x3c/path\x3e \x3ctype\x3eimage\x3c/type\x3e \x3ccontent\x3epng bytes\x3c/content\x3e ${PAD}`),
            mk("p10", "user", `background job bash-ef01 (bash: "echo ok") finished [status: completed, exit code: 0]. Read its output with job_output. ${PAD}`),
            mk("p11", "assistant", `working on the migration ${PAD}`),
        ];
        const core = createCore();
        const state = createInitialState();
        state.messageRefs = assignRefs(all, { existing: state.messageRefs, nextIndex: 1 }).map;
        const config = withDurableProtection(
            defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 }),
            durableMessageToolPaths.dsh!,
        );
        const result = core.applyCompression({
            ranges: [{ startRef: "m00002", endRef: "m00010", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
            messages: all,
            state,
            config,
        });
        const run = (msgs: CoreMessage[], startRef: string, endRef: string) => {
            const c = createCore();
            const st = createInitialState();
            st.messageRefs = assignRefs(msgs, { existing: st.messageRefs, nextIndex: 1 }).map;
            return c.applyCompression({
                ranges: [{ startRef, endRef, summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
                messages: msgs,
                state: st,
                config,
            });
        };

        // THE repro: the requested range spans the live request plus the
        // injection tail. Pre-fix the anchor was p10 (job notice), so #3953
        // truncated at p10 and folded p3 — the instruction the model is
        // currently answering. Post-fix the anchor is p3, so NOTHING at or
        // after it may fold; only the pre-anchor content (p2) becomes the
        // block. This assertion is the data-loss pin.
        {
            const res = run(all, "m00002", "m00010");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["p2"], "only pre-anchor content folds; #3953 keeps everything at/after the live request visible");
            assert.ok(
                res.result.warnings.some((w) => w.startsWith("Excluded") && w.includes("Last-user anchor: m00003")),
                `receipt names the anchor ref, got: ${JSON.stringify(res.result.warnings)}`,
            );
        }

        // No-bloat pin: once an injection sits BEFORE the live request (the
        // normal steady state on the next turn), it folds like any other
        // history — classification removes slot eligibility only, never
        // foldability. Without this, classifying every dsh carrier would
        // silently accumulate context.
        {
            // PAD2 clears config.compress.minCompressRange (5000 chars) on
            // the four foldable messages; PAD alone leaves the range short.
            const PAD2 = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(30);
            const msgs: CoreMessage[] = [
                mk("q1", "user", `old question ${PAD2}`),
                mk("a1", "assistant", `old answer ${PAD2}`),
                mk("t1", "user", `Time sampled while preparing turn 3, step 1: 2026-11-01T00:00:00Z ${PAD2}`),
                mk("n1", "user", `[MNEMON] recall: prefer terse diffs ${PAD2}`),
                mk("live", "user", LIVE),
            ];
            const res = run(msgs, "m00001", "m00004");
            assert.equal(res.result.blocksCreated, 1, `expected one block, got errors=${JSON.stringify(res.result.errors)} warnings=${JSON.stringify(res.result.warnings)}`);
            const block = res.state.blocks.find((b) => b.active)!;
            assert.deepEqual([...block.effectiveMessageIds].sort(), ["a1", "n1", "q1", "t1"].sort(), "classified injections fold normally when they are ahead of the live request");
        }
    });
});
