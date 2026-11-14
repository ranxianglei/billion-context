// #4686: after a dsh conversation forks onto its `|sub:` lane (persona-anchor
// drift, #3149 family), the host keeps stamping the RAW id on every
// Context-tab poll — GET /__bili/plugin/status?conversationId=<bare>&fallback=latest.
// An exact hit on the stale bare row used to win over everything (fallback=latest
// only fires when the id has NO record), freezing the tab on the dead row while
// the live lane kept folding. The read path must follow the live fork under the
// exact criteria the #2601 tool-call routing uses: birth order (#3442/#3647 —
// the fork must be BORN after the parent's last traffic, so a still-active
// parent stays authoritative), ref-holding (#2948 aux-lane breaker), freshness
// ≤ 10 min, recency pick (#3397). Gate discipline (#3617): every negative shape
// below asserts the follow does NOT trigger, not just that it triggers.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCore, defaultConfig } from "acp-kernel";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { handlePluginStatus } from "../src/plugin.ts";

const BASE = "sess-4686-base";
const CHILD = `${BASE}|sub:4c73101d32b4dd4c`;

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

function statusBody(id: string): Record<string, unknown> {
    const r = mockRes();
    handlePluginStatus(id, r.res, { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} }, true);
    assert.equal(r.status, 200, `status "${id}" answers 200`);
    return JSON.parse(r.body) as Record<string, unknown>;
}

/** Plant a stale-parent / fork pair. `*MsAgo` values are relative to now;
 *  `childRefs=false` reproduces the #2948 ref-less aux-lane shape. createdAt
 *  is pinned explicitly — under the #3442/#3647 birth-order discriminator it
 *  is the load-bearing field, and creation-time microseconds are not a
 *  reliable fixture. */
function plant(baseSeenMsAgo: number, childSeenMsAgo: number, childRefs: boolean, childBornMsAgo: number): void {
    _resetSessionsForTest();
    const base = getSession(BASE, { protocol: "anthropic" });
    base.stats.requests = 43;
    base.lastSeen = Date.now() - baseSeenMsAgo;
    const child = getSession(CHILD, { protocol: "anthropic" });
    child.createdAt = Date.now() - childBornMsAgo;
    child.stats.requests = 503;
    if (childRefs) child.state.messageRefs.byRef["m00001"] = "raw-1";
    child.lastSeen = Date.now() - childSeenMsAgo;
}

test("#4686: plugin/status follows the live |sub: fork when the bare parent went stale", () => {
    try {
        // Parent frozen 60 s ago; fork born 30 s later (born after the freeze),
        // ref-holding, active right now.
        plant(60_000, 0, true, 30_000);
        const body = statusBody(BASE);
        assert.equal(body.sessionId, CHILD, "serves the live fork");
        assert.equal(body.conversationId, BASE, "keeps the requested conversation id");
        assert.equal(body.personaFork, true, "marks the follow");
        assert.equal(body.fallback, undefined, "not a fallback=latest resolution");
    } finally { _resetSessionsForTest(); }
});

test("#4686 negative: parent still live after the fork was born → stays bound to it", () => {
    try {
        // Fork born 120 s ago, but the parent saw traffic just now — the
        // birth-order gate keeps an active parent authoritative (#3442 shape).
        plant(0, 60_000, true, 120_000);
        const body = statusBody(BASE);
        assert.equal(body.sessionId, BASE, "parent wins when it carries newer traffic than its forks' birth");
        assert.equal(body.personaFork, undefined, "no follow marker");
    } finally { _resetSessionsForTest(); }
});

test("#4686 negative: ref-less aux fork (#2948 shape) is never a follow target", () => {
    try {
        plant(60_000, 0, false, 30_000);
        const body = statusBody(BASE);
        assert.equal(body.sessionId, BASE, "a ref-less lane can serve nothing a management read needs");
        assert.equal(body.personaFork, undefined, "no follow marker");
    } finally { _resetSessionsForTest(); }
});

test("#4686 negative: fork idle beyond the freshness window routes home", () => {
    try {
        // Born after the freeze (passes the birth-order gate) but idle 11 min —
        // outside PERSONA_LINEAGE_FRESH_MS, so the stale parent id routes home.
        plant(60_000, 11 * 60 * 1000, true, 30_000);
        const body = statusBody(BASE);
        assert.equal(body.sessionId, BASE, "an idle fork is not live anymore");
        assert.equal(body.personaFork, undefined, "no follow marker");
    } finally { _resetSessionsForTest(); }
});

test("#4686: asking for the fork id directly resolves the fork (no chained follow)", () => {
    try {
        plant(60_000, 0, true, 30_000);
        const body = statusBody(CHILD);
        assert.equal(body.sessionId, CHILD, "exact hit on the fork itself");
        assert.equal(body.personaFork, undefined, "no chained follow off a |sub: id");
    } finally { _resetSessionsForTest(); }
});

test("#4686: among several qualifying forks the freshest one wins", () => {
    try {
        // Two forks born while the parent was frozen; the fresher one serves.
        plant(60_000, 5_000, true, 30_000);
        const other = `${BASE}|sub:ffffffffffffffff`;
        const s = getSession(other, { protocol: "anthropic" });
        s.createdAt = Date.now() - 10_000;
        s.stats.requests = 7;
        s.state.messageRefs.byRef["m00001"] = "raw-9";
        s.lastSeen = Date.now();
        const body = statusBody(BASE);
        assert.equal(body.sessionId, other, "recency picks among qualifying forks (listSessions order)");
        assert.equal(body.personaFork, true, "marks the follow");
    } finally { _resetSessionsForTest(); }
});
