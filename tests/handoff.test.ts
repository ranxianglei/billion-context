import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInitialState } from "acp-kernel";
import { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { parseArgs } from "../src/cli.ts";
import {
    encodeHandoffToken,
    decodeHandoffPayload,
    findHandoffToken,
    handoffEnabled,
    isBlankForHandoff,
    buildHandoffCarrier,
    planHandoff,
    applyHandoff,
    handoffSession,
} from "../src/handoff.ts";

// applyHandoff calls markDirty → getStore().scheduleSave; point the global
// store at a disabled instance so unit tests never touch the real session dir.
_setStoreForTest(new SessionStore({ enabled: false }));

function makeSession(id: string, title: string, label: string | undefined): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title, ...(label ? { label } : {}) },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function makeBlock(blockId: string, topic: string, summary: string, active = true) {
    return {
        blockId, runId: "r0", tier: 1, topic, summary,
        directMessageIds: ["m1"], effectiveMessageIds: ["m1"], directBlockIds: [],
        compressedTokens: 100, createdAt: Date.now(), survivedCount: 1, generation: 1, active,
    };
}

function seedRefs(state: ReturnType<typeof createInitialState>, n: number): void {
    for (let i = 1; i <= n; i++) {
        const ref = "m" + String(i).padStart(5, "0");
        const raw = `raw-${i}`;
        state.messageRefs.byRef[ref] = raw;
        state.messageRefs.byRaw[raw] = ref;
    }
}

test("handoff token round-trips ids through base64url", () => {
    for (const id of ["abc123", "pfa-9f8e7d6c5b4a", "sess with spaces & symbols!@#", "会话-中文-id", "a".repeat(2000)]) {
        const token = encodeHandoffToken(id);
        assert.match(token, /^\[BILI_SESSION_HANDOFF v1 [A-Za-z0-9_-]+\]$/);
        const found = findHandoffToken(`hello ${token} world`);
        assert.ok(found);
        assert.equal(found.sessionId, id);
        assert.equal(found.token, token);
    }
    assert.throws(() => encodeHandoffToken(""), /empty session id/);
    // Mint side must enforce the same payload floor as HANDOFF_TOKEN_RE: ids
    // below it mint tokens findHandoffToken can never detect.
    assert.throws(() => encodeHandoffToken("abcde"), /too short/);
    const boundary = encodeHandoffToken("abcdef");
    assert.equal(findHandoffToken(boundary)?.sessionId, "abcdef");
});

test("decodeHandoffPayload rejects non-canonical or malformed payloads", () => {
    const good = Buffer.from("abc123", "utf8").toString("base64url");
    assert.equal(decodeHandoffPayload(good), "abc123");
    assert.equal(decodeHandoffPayload(good + "="), undefined);
    assert.equal(decodeHandoffPayload(""), undefined);
    assert.equal(decodeHandoffPayload("!!!!"), undefined);
    const oversized = Buffer.from("x".repeat(5000), "utf8").toString("base64url");
    assert.equal(decodeHandoffPayload(oversized), undefined);
});

test("findHandoffToken: version gate, first match wins, absent → undefined", () => {
    assert.equal(findHandoffToken("no token here"), undefined);
    const wrongVersion = `[BILI_SESSION_HANDOFF v9 ${Buffer.from("xxxxxxxxxx", "utf8").toString("base64url")}]`;
    assert.equal(findHandoffToken(wrongVersion), undefined);
    const t1 = encodeHandoffToken("session-a");
    const t2 = encodeHandoffToken("session-b");
    const both = findHandoffToken(`${t1} then ${t2}`);
    assert.ok(both);
    assert.equal(both.sessionId, "session-a");
});

test("handoffEnabled kill-switch (BILI_HANDOFF=pass)", () => {
    const prev = process.env.BILI_HANDOFF;
    try {
        delete process.env.BILI_HANDOFF;
        assert.equal(handoffEnabled(), true);
        process.env.BILI_HANDOFF = "pass";
        assert.equal(handoffEnabled(), false);
        process.env.BILI_HANDOFF = " PASS ";
        assert.equal(handoffEnabled(), false);
        process.env.BILI_HANDOFF = "on";
        assert.equal(handoffEnabled(), true);
    } finally {
        if (prev === undefined) delete process.env.BILI_HANDOFF;
        else process.env.BILI_HANDOFF = prev;
    }
});

test("isBlankForHandoff gates on ACP state, not request counts", () => {
    const fresh = createInitialState();
    assert.equal(isBlankForHandoff(fresh), true);
    const withRefs = createInitialState();
    seedRefs(withRefs, 3);
    assert.equal(isBlankForHandoff(withRefs), false);
    const withBlocks = createInitialState();
    withBlocks.blocks.push(makeBlock("b0", "t", "s"));
    assert.equal(isBlankForHandoff(withBlocks), false);
    const withTokens = createInitialState();
    withTokens.tokenSnapshot["raw-x"] = 100;
    assert.equal(isBlankForHandoff(withTokens), false);
});

test("buildHandoffCarrier: deterministic order, kernel render format, skips inactive", () => {
    const st = createInitialState();
    seedRefs(st, 500);
    st.blocks.push(makeBlock("b10", "later", "Later summary body."));
    st.blocks.push(makeBlock("b2", "early", "Early summary body."));
    st.blocks.push(makeBlock("b11", "dead", "Inactive block must not appear.", false));
    st.nextBlockId = 12;
    const c1 = buildHandoffCarrier(st, "source-ses");
    const c2 = buildHandoffCarrier(structuredClone(st), "source-ses");
    assert.equal(c1, c2);
    assert.match(c1, /\[bili\] session handoff from source-ses: 2 compression block summaries inherited below/);
    assert.match(c1, /refs up to m00500/);
    const earlyIdx = c1.indexOf("Early summary body.");
    const laterIdx = c1.indexOf("Later summary body.");
    assert.ok(earlyIdx > -1 && laterIdx > -1 && earlyIdx < laterIdx);
    assert.match(c1, /\[Compressed conversation section\] — early\nEarly summary body\./);
    assert.doesNotMatch(c1, /Inactive block must not appear/);
});

test("planHandoff: ok-path fields and every rejection reason", () => {
    const sourceState = createInitialState();
    seedRefs(sourceState, 500);
    sourceState.blocks.push(makeBlock("b00001", "t1", "s1"));
    sourceState.nextBlockId = 42;
    sourceState.nextRunId = 7;

    const target = makeSession("new-target", "fresh", undefined);
    const plan = planHandoff(target, sourceState, "old-source");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.refsCount, 500);
    assert.equal(plan.maxRef, "m00500");
    assert.equal(plan.nextBlockId, 42);
    assert.equal(plan.nextRunId, 7);
    assert.equal(plan.adoptedBlocks, 1);
    assert.match(plan.carrier, /session handoff from old-source/);

    const self = planHandoff(target, sourceState, "new-target");
    assert.equal(self.ok, false);
    if (!self.ok) assert.match(self.reason, /same session/);

    const busy = makeSession("busy", "", undefined);
    seedRefs(busy.state, 1);
    const busyPlan = planHandoff(busy, sourceState, "old-source");
    assert.equal(busyPlan.ok, false);
    if (!busyPlan.ok) assert.match(busyPlan.reason, /already has ACP state/);

    const already = makeSession("already", "", undefined);
    already.metadata.handoffFrom = "prior-source";
    const againPlan = planHandoff(already, sourceState, "old-source");
    assert.equal(againPlan.ok, false);
    if (!againPlan.ok) assert.match(againPlan.reason, /already has a handoff from prior-source/);

    const derived = makeSession("derived", "", undefined);
    derived.metadata.derivedFromSessionId = "rlm-parent";
    const derivedPlan = planHandoff(derived, sourceState, "old-source");
    assert.equal(derivedPlan.ok, false);
    if (!derivedPlan.ok) assert.match(derivedPlan.reason, /already derives/);

    const emptySource = createInitialState();
    seedRefs(emptySource, 10);
    const noActive = planHandoff(makeSession("t3", "", undefined), emptySource, "old-source");
    assert.equal(noActive.ok, false);
    if (!noActive.ok) assert.match(noActive.reason, /no active compression blocks/);
});

test("applyHandoff seeds refs/counters/metadata, leaves source untouched, refuses double adoption", () => {
    const sourceState = createInitialState();
    seedRefs(sourceState, 300);
    sourceState.blocks.push(makeBlock("b00001", "t", "s"));
    sourceState.nextBlockId = 55;
    const refsBefore = JSON.stringify(sourceState.messageRefs.byRef);
    const blocksBefore = sourceState.blocks.length;

    const target = makeSession("target-t", "", undefined);
    const token = encodeHandoffToken("source-s");
    const plan = planHandoff(target, sourceState, "source-s");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    applyHandoff(target, plan, sourceState, "source-s", token);

    assert.equal(Object.keys(target.state.messageRefs.byRef).length, 300);
    assert.equal(target.state.messageRefs.byRef["m00300"], "raw-300");
    assert.equal(target.state.messageRefs.byRaw["raw-300"], "m00300");
    assert.equal(target.state.nextBlockId, 55);
    assert.equal(target.metadata.handoffFrom, "source-s");
    assert.equal(target.metadata.derivedFromSessionId, "source-s");
    assert.equal(target.metadata.handoffToken, token);
    assert.equal(target.metadata.handoffCarrier, plan.carrier);
    assert.equal(target.state.blocks.length, 0);

    assert.equal(JSON.stringify(sourceState.messageRefs.byRef), refsBefore);
    assert.equal(sourceState.blocks.length, blocksBefore);

    // The seeded target now carries refs, so the freshness gate (not the
    // metadata gate) refuses a second adoption.
    const retry = planHandoff(target, sourceState, "another-source");
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.match(retry.reason, /already has ACP state/);
});

test("numbering continues above the source space on large rollovers (#1539 repro scale)", () => {
    const sourceState = createInitialState();
    seedRefs(sourceState, 11699);
    sourceState.blocks.push(makeBlock("b00001", "t", "s"));
    sourceState.nextBlockId = 99999;
    const target = makeSession("t-big", "", undefined);
    const plan = planHandoff(target, sourceState, "big-session");
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.maxRef, "m11699");
    assert.equal(plan.nextBlockId, 99999);
    applyHandoff(target, plan, sourceState, "big-session", encodeHandoffToken("big-session"));
    const maxCloned = Math.max(...Object.keys(target.state.messageRefs.byRef).map((r) => Number(r.replace(/\D/g, ""))));
    assert.equal(maxCloned, 11699);
    assert.equal(target.state.nextBlockId, 99999);
});

test("bili handoff lists sessions and mints tokens offline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-handoff-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    const s = makeSession("abc123", "Long session", "ses_long");
    s.state.blocks.push(makeBlock("b0", "auth debug", "Debugged auth flow."));
    await store.writeNow(s);
    try {
        const listing = await handoffSession(undefined, { dir });
        assert.match(listing, /abc123/);
        assert.match(listing, /ses_long/);

        const out = await handoffSession("ses_long", { dir });
        const m = out.match(/^\[BILI_SESSION_HANDOFF v1 ([A-Za-z0-9_-]+)\]/);
        assert.ok(m);
        assert.equal(decodeHandoffPayload(m![1]), "abc123");

        const file = path.join(dir, "token.txt");
        const written = await handoffSession("abc123", { dir, output: file });
        assert.match(written, /written to/);
        assert.equal(readFileSync(file, "utf8").trim(), `[BILI_SESSION_HANDOFF v1 ${m![1]}]`);

        await assert.rejects(() => handoffSession("nope", { dir }), /no session matches/);

        const s2 = makeSession("def456", "Other", "ses_long");
        s2.state.blocks.push(makeBlock("b0", "t", "s"));
        await store.writeNow(s2);
        await assert.rejects(() => handoffSession("ses_long", { dir }), /matches 2 sessions/);

        const s3 = makeSession("ghi789", "Dead", "ses_dead");
        s3.state.blocks.push(makeBlock("b0", "t", "s", false));
        await store.writeNow(s3);
        await assert.rejects(() => handoffSession("ses_dead", { dir }), /no active compression blocks/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("parseArgs recognizes bili handoff forms", () => {
    const a = parseArgs(["handoff"]);
    assert.equal(a.command, "handoff");
    assert.equal(a.handoffSelector, undefined);
    const b = parseArgs(["handoff", "abc123"]);
    assert.equal(b.command, "handoff");
    assert.equal(b.handoffSelector, "abc123");
    const c = parseArgs(["handoff", "--output", "/tmp/t.txt", "abc"]);
    assert.equal(c.command, "handoff");
    assert.equal(c.handoffSelector, "abc");
    assert.equal(c.handoffOutput, "/tmp/t.txt");
});
