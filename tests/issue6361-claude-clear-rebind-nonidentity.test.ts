// #6361 (gate direction 2 — non-identity host): the re-bind seam is scoped to
// identity-bound hosts only. This file loads src/mcp.ts WITHOUT
// CLAUDE_CODE_SESSION_ID (IDENTITY_BINDING is a module-load constant, so the
// direction needs its own process), mirroring the issue4580 precedent of
// importing the shim unbound: even with a resolver armed (as the claude entry
// does) and a fresh session id available, no re-bind may fire — an MCP child
// spawned without the session env keeps the pre-#6361 binding behavior
// exactly.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

delete process.env.CLAUDE_CODE_SESSION_ID;
process.env.BILI_CONVERSATION_ID = "nonidentity-bound-id";

const { _resetMcpBindingForTest, setClaudeSessionResolver, maybeRebindConversation, _resetClaudeSessionResolverForTest } = await import("../src/mcp.ts");

describe("#6361 shim: non-identity host — the re-bind seam stays a no-op", () => {
    test("resolver armed + fresh id available → no re-bind, resolver never called", () => {
        _resetMcpBindingForTest("nonidentity-bound-id");
        let resolverCalls = 0;
        setClaudeSessionResolver(() => {
            resolverCalls += 1;
            return "fresh-session-after-clear";
        });
        try {
            assert.equal(maybeRebindConversation(), undefined, "the identity gate must hold on a non-identity host");
            assert.equal(resolverCalls, 0, "the gate must short-circuit before the resolver runs");
        } finally {
            _resetClaudeSessionResolverForTest();
            _resetMcpBindingForTest();
        }
    });
});
