// #7153: the dsh carrier classifiers used to match a BARE marker
// (`includes`/`startsWith`), so a HUMAN message that merely quotes or
// mentions one was treated as a host injection. Two consumers make that a
// correctness bug, not a cosmetic one:
//   - kernel `lastUserAnchor()` refuses a virtual-path message the Rule-3
//     anchor role, so the live request stops being protected and an
//     intra-turn fold can drop it (the #5109 failure mode);
//   - `durable/*` goes into protectedLatestTools, so a quote takes the
//     identity over from the real carrier (latest-per-identity) and gets
//     pinned forever while the real one folds.
// Fix: shape gates on the four classifiers whose bare marker collides with
// human/relay text — the durable pair must open the `<system-reminder>` frame
// the producers emit, and the two one-shot notices must carry their emitter's
// real shape (job id + detail/EOL; a settlement ending). Every emitter shape
// keeps matching; a future emitter change degrades to a MISS, never a false
// positive (the direction this module's doctrine prefers).
import test from "node:test";
import assert from "node:assert/strict";
import {
    dshSkillCatalogPath,
    dshSubagentSettledPath,
    dshToolJobNoticePath,
    dshWorkspaceInstructionsPath,
    durableMessageToolPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";
import { defaultConfig } from "../kernel/src/config.js";
import { lastUserAnchor } from "../kernel/src/protected.js";
import { buildCompressibleRanges, computeProtectedRefs } from "../kernel/src/recommend.js";
import { createInitialState } from "../kernel/src/state.js";
import { assignRefs } from "../kernel/src/refs.js";
import type { CoreMessage } from "../kernel/src/types.js";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
    return { id, role, contentType: "text", text };
}

/** The shape dsh-tool-skill emits (renderCatalogMessage). */
const REAL_CATALOG = [
    "\x3csystem-reminder\x3e",
    "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
    "",
    "\x3cavailable_skills\x3e",
    "- name: git-helper",
    "  description: commit conventions",
    "\x3c/available_skills\x3e",
    "\x3c/system-reminder\x3e",
].join("\n");

/** A human prompt that QUOTES a catalog block mid-text (the #7153 field shape). */
const HUMAN_PROMPT_QUOTING_CATALOG = [
    "You are researching the runtime. Compare this prompt with ours and report the diff.",
    "",
    "\x3cavailable_skills\x3e",
    "- name: other-helper",
    "\x3c/available_skills\x3e",
    "",
    "Start with the prompt, not the harness.",
].join("\n");

/** A relayed subagent report that quotes the block (the 43 KB field shape). */
const RELAY_QUOTING_CATALOG = "Agent 423c357e-d37a-405e-92d2-1399fff01e0c sent a message: REPORT\n\nFor reference the header is\n\x3cavailable_skills\x3e\n- name: x\n\x3c/available_skills\x3e";

test("#7153 durable carriers still match when they open the system-reminder frame", () => {
    assert.equal(dshSkillCatalogPath(msg("c1", REAL_CATALOG)), "durable/skill-catalog");
    const instructions = "\x3csystem-reminder\x3e\nworkspace instructions\n\nInstructions from: AGENTS.md\n\n# rules\nalways lint\n\x3c/system-reminder\x3e";
    assert.equal(dshWorkspaceInstructionsPath(msg("i1", instructions)), "durable/agents-md");
});

test("#7153 a human paste / relay report that quotes a durable marker is NOT a carrier", () => {
    assert.equal(dshSkillCatalogPath(msg("h1", HUMAN_PROMPT_QUOTING_CATALOG)), undefined, "a human prompt quoting the catalog keeps its anchor role");
    assert.equal(dshSkillCatalogPath(msg("h2", RELAY_QUOTING_CATALOG)), undefined, "a relay report quoting the catalog must not take the catalog identity");
    assert.equal(dshSkillCatalogPath(msg("h3", "why does this say Instructions from: AGENTS.md?")), undefined);
    assert.equal(
        dshWorkspaceInstructionsPath(msg("h4", "I pasted this from another repo:\n\nInstructions from: /other/AGENTS.md\n\nwhy does that rule exist?")),
        undefined,
        "a quoted rule file is ordinary history, not the baseline",
    );
    assert.equal(dshSkillCatalogPath(msg("h5", REAL_CATALOG, "assistant")), undefined, "#2766 assistant gate survives");
});

test("#7153 every tool-job notice emitter shape still matches, ordinary English does not", () => {
    // packages/jobs/tool-jobs/src/index.ts: inline / truncated / compact.
    const inline = 'background job bash-abcd (bash: "true") finished [status: completed, exit code: 0]. Read its output with job_output.';
    const truncated = "background job bash-abcd\n[notice truncated]\nDone; job_output.";
    const compact = "background job bash-abcd\nDone; job_output.";
    assert.equal(dshToolJobNoticePath(msg("j1", inline)), "oneshot/tool-job-notice");
    assert.equal(dshToolJobNoticePath(msg("j2", truncated)), "oneshot/tool-job-notice");
    assert.equal(dshToolJobNoticePath(msg("j3", compact)), "oneshot/tool-job-notice");

    assert.equal(
        dshToolJobNoticePath(msg("p1", "background jobs keep failing with exit code 1 — please read the logs and fix the root cause")),
        undefined,
        "a human question about background jobs keeps the anchor role",
    );
    assert.equal(dshToolJobNoticePath(msg("p2", "background job keeps failing, why?")), undefined);
    assert.equal(dshToolJobNoticePath(msg("p3", inline, "assistant")), undefined);
});

test("#7153 every settlement ending still matches, prose about a subagent does not", () => {
    const endings = [
        "finished and will do no further work unless you send it more.",
        "finished. It cannot receive follow-up messages.",
        "was stopped before it finished.",
        "ran out of room before it finished.",
        "declined the task.",
        "failed before it finished.",
    ];
    for (const ending of endings) {
        assert.equal(
            dshSubagentSettledPath(msg("s1", `Background subagent session-a1b2 ${ending}`)),
            "oneshot/subagent-settled",
            `emitter ending must keep matching: ${ending}`,
        );
    }
    assert.equal(dshSubagentSettledPath(msg("p1", "Background subagent session-a1b2 is stuck again — why?")), undefined);
    assert.equal(dshSubagentSettledPath(msg("p2", "Background subagents are handy for parallel work")), undefined);
});

test("#7153 the live request keeps the Rule-3 anchor and stays out of the compressible zone", () => {
    const messages: CoreMessage[] = [
        msg("m1", "earlier question about the build"),
        msg("m2", "answer one ".repeat(120), "assistant"),
        msg("m3", "background jobs keep failing with exit code 1 — please read the logs and fix the root cause"),
    ];
    for (let i = 4; i <= 14; i++) messages.push(msg(`m${i}`, `working step ${i} ` + "payload ".repeat(120), "assistant"));

    const state = createInitialState();
    state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
    const config = withDurableProtection(
        defaultConfig(200000, { preserveRecentMessages: 2, preserveRecentTokens: 0 }),
        durableMessageToolPaths.dsh!,
    );

    assert.equal(lastUserAnchor(messages, new Set(), config)?.id, "m3", "the live request is the anchor");
    const protectedRefs = computeProtectedRefs(messages, state, config);
    assert.ok(protectedRefs.has("m00003"), "Rule 3 protects the live request");
    const ranges = buildCompressibleRanges(messages, state, config, protectedRefs);
    const covering = ranges.compressible.filter((r) => r.startRef <= "m00003" && r.endRef >= "m00003");
    assert.deepEqual(covering, [], "no compressible range may contain the live request");
});

test("#7153 a real notice after the request still loses the anchor role (the exclusion keeps working)", () => {
    const messages: CoreMessage[] = [
        msg("m1", "earlier question"),
        msg("m2", "answer two ".repeat(120), "assistant"),
        msg("m3", "please summarise the build output"),
        msg("m4", 'background job bash-abcd (bash: "make") finished [status: completed, exit code: 0]. Read its output with job_output.'),
    ];
    const config = withDurableProtection(
        defaultConfig(200000, { preserveRecentMessages: 2, preserveRecentTokens: 0 }),
        durableMessageToolPaths.dsh!,
    );
    assert.equal(lastUserAnchor(messages, new Set(), config)?.id, "m3", "the machine notice never displaces the human request");
    assert.equal(dshToolJobNoticePath(messages[3]!), "oneshot/tool-job-notice", "the notice is still recognised as a carrier");
});
