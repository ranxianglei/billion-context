import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTitle, isContextualUserFragment, isAutoInjectedNotification } from "../src/server.js";
import { SUBAGENT_PROMPT_PREFIX } from "../src/session-title.js";
import type { CoreMessage } from "acp-kernel";

let seq = 0;
function msg(role: CoreMessage["role"], contentType: CoreMessage["contentType"], text?: string): CoreMessage {
    return { id: `m${++seq}`, role, contentType, text };
}

const AGENTS_MD = "# AGENTS.md instructions for /home/dev/app\n\n<INSTRUCTIONS>\nAlways run lint before committing.\n</INSTRUCTIONS>";
const ENV_CTX = "<environment_context>\n<cwd>/home/dev/app</cwd>\n<shell>bash</shell>\n</environment_context>";

describe("#2118 deriveTitle skips host-injected contextual fragments", () => {
    it("AGENTS.md fragment ahead of the real question does not become the title", () => {
        const t = deriveTitle([msg("user", "text", AGENTS_MD), msg("user", "text", "How do I fix my build?")]);
        assert.equal(t, "How do I fix my build?");
    });

    it("environment_context fragment ahead of the real question does not become the title", () => {
        const t = deriveTitle([msg("user", "text", ENV_CTX), msg("user", "text", "为什么部署失败?")]);
        assert.equal(t, "为什么部署失败?");
    });

    it("both fragments in codex order resolve to the first real question", () => {
        const t = deriveTitle([msg("user", "text", ENV_CTX), msg("user", "text", AGENTS_MD), msg("user", "text", "help me debug the proxy")]);
        assert.equal(t, "help me debug the proxy");
    });

    it("only fragments present: no title yet (retries on later requests)", () => {
        assert.equal(deriveTitle([msg("user", "text", AGENTS_MD), msg("user", "text", ENV_CTX)]), undefined);
        assert.equal(deriveTitle([]), undefined);
    });

    it("plain client without fragments keeps existing behavior", () => {
        assert.equal(deriveTitle([msg("user", "text", "Fix auth bug")]), "Fix auth bug");
    });

    it("long real questions still truncate at 60 chars with ellipsis", () => {
        const q = "a".repeat(80) + " tail";
        const t = deriveTitle([msg("user", "text", q)])!;
        assert.equal(t.length, 58);
        assert.ok(t.endsWith("\u2026"));
    });

    it("whitespace inside the question collapses as before", () => {
        assert.equal(deriveTitle([msg("user", "text", "  why   is\nthe\tbuild red?")]), "why is the build red?");
    });

    it("non-user roles and non-text content never contribute", () => {
        assert.equal(deriveTitle([
            msg("system", "text", "system prompt"),
            msg("assistant", "text", "assistant reply"),
            msg("user", "tool-call", "bash tool"),
            msg("user", "text", ""),
        ]), undefined);
    });
});

describe("#2118 isContextualUserFragment mirrors codex matches_marked_text", () => {
    it("matches trimmed text starting with open AND ending with close marker", () => {
        assert.equal(isContextualUserFragment(AGENTS_MD), true);
        assert.equal(isContextualUserFragment(ENV_CTX), true);
        assert.equal(isContextualUserFragment(`\n${ENV_CTX}\n`), true);
    });

    it("is ASCII case-insensitive like codex eq_ignore_ascii_case", () => {
        assert.equal(isContextualUserFragment("<ENVIRONMENT_CONTEXT>x</ENVIRONMENT_CONTEXT>"), true);
        assert.equal(isContextualUserFragment("# agents.md instructions for x\n\n<INSTRUCTIONS>y</INSTRUCTIONS>"), true);
    });

    it("requires BOTH markers — a real question mentioning one is not filtered", () => {
        assert.equal(isContextualUserFragment("# AGENTS.md instructions are confusing, how do I change them?"), false);
        assert.equal(isContextualUserFragment("<environment_context>foo</environment_context> what does this output mean?"), false);
        assert.equal(isContextualUserFragment("random </INSTRUCTIONS> closing tag in prose"), false);
    });

    it("does not match empty or whitespace-only text", () => {
        assert.equal(isContextualUserFragment(""), false);
        assert.equal(isContextualUserFragment("   \n\t "), false);
    });
});

// Exact notification texts from deepseek-ai/deepseek-harness (MIT):
// packages/interaction/user-approval/src/index.ts,
// packages/core/system-prompt/src/index.ts joinContextSections,
// packages/core/agent-loop/src/runtime-context.ts CLEARED,
// packages/context/time-context/src/index.ts.
const DSH_APPROVAL = 'The approval policy changed from "ask" to "never" (changed by the user).';
const DSH_RUNTIME_CTX = "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nMode: read-only.";
const DSH_RUNTIME_CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";
// #7085: dsh 0.2.2-rc.3 wraps the reworded runtime-context snapshot in a
// \x3csystem-reminder\x3e envelope (no longer contains "Current runtime context").
const DSH_RUNTIME_CTX_NEW = '\x3csystem-reminder\x3e\nThe following information describes your current session:\n\nCurrent working directory: "/path/to/repo".\n\nCurrent DSH file policy: danger-full-access.';
const DSH_TIME_CTX = "Time sampled while preparing turn 1, step 1: 2026-07-15T09:01:01+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\nElapsed since the preceding model-visible message: unavailable.";

describe("#2286 deriveTitle skips dsh-injected notifications", () => {
    it("approval-policy notice ahead of the real question does not become the title", () => {
        const t = deriveTitle([msg("user", "text", DSH_APPROVAL), msg("user", "text", "帮我重构这个模块")]);
        assert.equal(t, "帮我重构这个模块");
    });

    it("all three dsh notification kinds ahead of the real question resolve to it", () => {
        const t = deriveTitle([
            msg("user", "text", DSH_APPROVAL),
            msg("user", "text", DSH_TIME_CTX),
            msg("user", "text", DSH_RUNTIME_CTX),
            msg("user", "text", "debug the flaky test"),
        ]);
        assert.equal(t, "debug the flaky test");
    });

    it("only notifications present: no title yet (retries on later requests)", () => {
        assert.equal(deriveTitle([msg("user", "text", DSH_APPROVAL), msg("user", "text", DSH_TIME_CTX), msg("user", "text", DSH_RUNTIME_CLEARED)]), undefined);
    });

    it("the browser-time-zone line embedded in the time-context message is covered by its prefix", () => {
        assert.equal(deriveTitle([msg("user", "text", DSH_TIME_CTX), msg("user", "text", "why is CI red?")]), "why is CI red?");
    });

    it("the 0.2.2-rc.3 reworded snapshot ahead of the real question does not become the title (#7085)", () => {
        const t = deriveTitle([msg("user", "text", DSH_RUNTIME_CTX_NEW), msg("user", "text", "fix the failing test")]);
        assert.equal(t, "fix the failing test");
    });
});

describe("#2286 isAutoInjectedNotification prefix permitlist", () => {
    it("matches every verified dsh notification text", () => {
        assert.equal(isAutoInjectedNotification(DSH_APPROVAL), true);
        assert.equal(isAutoInjectedNotification(DSH_RUNTIME_CTX), true);
        assert.equal(isAutoInjectedNotification(DSH_RUNTIME_CLEARED), true);
        assert.equal(isAutoInjectedNotification(DSH_TIME_CTX), true);
        assert.equal(isAutoInjectedNotification(DSH_RUNTIME_CTX_NEW), true, "the 0.2.2-rc.3 reworded snapshot (system-reminder envelope) is recognized too (#7085)");
    });

    it("matches a polluted set-once title truncated at 60 chars with ellipsis", () => {
        const truncated = DSH_APPROVAL.slice(0, 57) + "\u2026";
        assert.equal(isAutoInjectedNotification(truncated), true);
    });

    it("is ASCII case-insensitive like the codex markers", () => {
        assert.equal(isAutoInjectedNotification(dshApprovalLower()), true);
        function dshApprovalLower() { return DSH_APPROVAL.replace(/^The/, "the"); }
    });

    it("prefix only — a real question mentioning a notice mid-sentence is not filtered", () => {
        assert.equal(isAutoInjectedNotification('What does "Current runtime context" in my log mean?'), false);
        assert.equal(isAutoInjectedNotification("Why did the approval policy change today?"), false);
    });

    it("does not match empty or whitespace-only text", () => {
        assert.equal(isAutoInjectedNotification(""), false);
        assert.equal(isAutoInjectedNotification("  \t\n "), false);
    });
});

describe("subagent dispatch prompts: the task after the prefix becomes the title", () => {
    const TASK = "你是 JavaScript 课程字幕校对员。工作目录：D:\\work\\js-course";
    const PROMPT = `${SUBAGENT_PROMPT_PREFIX}\n${TASK}`;

    it("derives the title from the task after the dispatch prefix", () => {
        assert.equal(deriveTitle([msg("user", "text", PROMPT)]), TASK);
    });

    it("a prefix-only dispatch prompt produces no title", () => {
        assert.equal(deriveTitle([msg("user", "text", SUBAGENT_PROMPT_PREFIX)]), undefined);
    });

    it("a prefix-only dispatch prompt does not block a later real user message", () => {
        const t = deriveTitle([msg("user", "text", SUBAGENT_PROMPT_PREFIX), msg("user", "text", "continue from 151")]);
        assert.equal(t, "continue from 151");
    });

    it("matches the dispatch prefix case-insensitively", () => {
        const t = deriveTitle([msg("user", "text", "you are a subagent spawned by another session.\nFix the login bug")]);
        assert.equal(t, "Fix the login bug");
    });

    it("does not strip a real question that merely mentions subagents", () => {
        const t = deriveTitle([msg("user", "text", "Why does every subagent spawned by another session show the same title?")]);
        assert.ok(t?.startsWith("Why does every subagent"));
        assert.ok(t?.endsWith("\u2026"));
    });
});
