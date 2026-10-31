import { readFileSync } from "node:fs";
import { LANE_TOKEN_MARKER, mintClaudeLaneToken } from "./claude-lane-token.js";

/** #5095 (D1-C): Claude Code SubagentStart hook. One line of work per
 *  subagent launch — mint a random lane token and hand it back as
 *  `additionalContext`, which Claude Code injects into that dispatch's
 *  context. Every model request of the dispatch then carries the token in
 *  its first user message, and the bili proxy keys the dispatch onto its own
 *  compression lane (`<id>|sub:...:t:<token>`) instead of the persona-text
 *  fingerprint that merges parallel same-type subagents under the parent's
 *  session id (#4352/#5095).
 *
 *  The hook does NOT register anything locally: the token's only carrier is
 *  the wire content itself, so a proxy restart cannot orphan it. Non-goal:
 *  authentication — this is a birth hint, not a receipt (#5051 needs those;
 *  this does not). */

/** Pure output builder (exported for tests). */
export function subagentStartHookOutput(): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } {
    return {
        hookSpecificOutput: {
            hookEventName: "SubagentStart",
            additionalContext: `${LANE_TOKEN_MARKER}${mintClaudeLaneToken()}`,
        },
    };
}

function main(): void {
    // Drain stdin (Claude Code pipes the hook input JSON and waits for EOF
    // before reading stdout). The payload is intentionally unused: the token
    // is minted, not derived from anything the client could influence.
    try {
        readFileSync(0, "utf8");
    } catch {}
    process.stdout.write(`${JSON.stringify(subagentStartHookOutput())}\n`);
}

// Standalone entry (tsup bundles this file to dist/claude-subagent-hook.js).
// A hook failure must never break the user's subagent launch: any error
// exits 0 with no output, which Claude Code treats as a silent no-op.
if (process.argv[1] !== undefined && process.argv[1].includes("claude-subagent-hook")) {
    try {
        main();
    } catch {}
}
