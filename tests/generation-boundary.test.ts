// #4305 regression: after a mid-conversation model/upstream switch the ref
// ledger restarts while the visible history keeps citing previous-generation
// refs — the standing generation-boundary note must be detected ONCE from
// that residue and ride every subsequent request byte-stably.

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import type { ProxyOptions } from "../src/config.js";
import { createSession, type Session } from "../src/session.js";
import { detectGenerationBoundary, GENERATION_BOUNDARY_NOTE, readGenerationBoundary } from "../src/generation-boundary.js";
import { PROJECT_ATTRIBUTION_LINE } from "../src/compress-tool.js";
import { injectSystem } from "../src/server/inject.js";

const msg = (id: string, text: string): CoreMessage => ({ id, role: "user", contentType: "text", text });

function sessionWithFrontier(frontier: number): Session {
    const s = createSession(`genb-${Math.random().toString(36).slice(2)}`);
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= frontier; i++) byRef[`m${String(i).padStart(5, "0")}`] = `raw-${i}`;
    s.state.messageRefs.byRef = byRef;
    return s;
}

test("#4305: two distinct above-frontier citations detect and persist the verdict", () => {
    const s = sessionWithFrontier(10);
    const messages = [
        msg("a", "Compressed b7 covering m00042–m00051, summary attached."),
        msg("b", "The earlier acp_status report listed range m00060–m00071 as compressible."),
    ];
    const logs: string[] = [];
    const active = detectGenerationBoundary(s, messages, (_l, m) => logs.push(m));
    assert.equal(active, true, "note rides the request that detected the residue");
    const rec = readGenerationBoundary(s);
    assert.ok(rec, "verdict persisted in session metadata");
    assert.equal(rec?.frontier, "m00010");
    // Early-exit by design: the first message already carries two distinct stale
    // refs, so the second one is never scanned — maxStaleRef records what was seen.
    assert.equal(rec?.maxStaleRef, "m00051");
    assert.equal(logs.length, 1, "detection logged exactly once");
    assert.match(logs[0], /\[acp-gen-boundary\]/);
});

test("#4305: citations at or below the frontier never trigger", () => {
    const s = sessionWithFrontier(10);
    const messages = [msg("a", "compress m00003–m00007 please"), msg("b", "and m00010 was the last one")];
    assert.equal(detectGenerationBoundary(s, messages), false);
    assert.equal(readGenerationBoundary(s), undefined, "no metadata written");
});

test("#4305: one stray above-frontier token (repeated) is not evidence — distinctness guard", () => {
    const s = sessionWithFrontier(10);
    const messages = [msg("a", "refs m00042 m00042 m00042 keep failing")];
    assert.equal(detectGenerationBoundary(s, messages), false);
    assert.equal(readGenerationBoundary(s), undefined);
});

test("#4305: fresh session (no mapped refs yet) detects on stale residue", () => {
    const s = sessionWithFrontier(0);
    const messages = [msg("a", "old receipt says compress m09631–m09640"), msg("b", "and m9612 did too")];
    assert.equal(detectGenerationBoundary(s, messages), true);
    assert.equal(readGenerationBoundary(s)?.frontier, "");
});

test("#4305: tag-shaped residue (surviving ACP tags) is detected too", () => {
    const s = sessionWithFrontier(10);
    const tagged = "\x3cacp tokens=\"5\" type=\"text\"\x3em00077\x3c/acp\x3e\nhello";
    const messages = [msg("a", tagged), msg("b", "also saw m00088 quoted earlier")];
    assert.equal(detectGenerationBoundary(s, messages), true);
    assert.equal(readGenerationBoundary(s)?.maxStaleRef, "m00088");
});

test("#4305: prose with a single stray m-shaped word does not trigger", () => {
    const s = sessionWithFrontier(10);
    const messages = [msg("a", "the variable m12345 is out of scope here")];
    assert.equal(detectGenerationBoundary(s, messages), false);
});

test("#4305: already-detected sessions short-circuit — no rescan, still active", () => {
    const s = sessionWithFrontier(10);
    detectGenerationBoundary(s, [msg("a", "m00042 and m00051"), msg("b", "more")]);
    const logs: string[] = [];
    assert.equal(detectGenerationBoundary(s, [], (_l, m) => logs.push(m)), true, "verdict survives with empty history");
    assert.equal(logs.length, 0, "no second detection log");
});

test("#4305: readGenerationBoundary rejects malformed records", () => {
    const s = sessionWithFrontier(10);
    s.metadata!.generationBoundary = { at: "nope" };
    assert.equal(readGenerationBoundary(s), undefined);
    s.metadata!.generationBoundary = {};
    assert.equal(readGenerationBoundary(s), undefined);
    assert.equal(detectGenerationBoundary(s, []), false, "malformed record re-detects instead of trusting it");
});

test("#4305: the note is a static string naming the reset and the authority", () => {
    assert.ok(GENERATION_BOUNDARY_NOTE.length > 100);
    assert.ok(GENERATION_BOUNDARY_NOTE.includes("m00001"), "names the restart point");
    assert.ok(GENERATION_BOUNDARY_NOTE.includes("acp_status"), "points at the live authority");
});

const OPTS: ProxyOptions = {
    port: 0,
    host: "127.0.0.1",
    upstream: "http://127.0.0.1",
    routes: {},
    modelContextLimit: 400_000,
    kernelConfig: defaultConfig(400_000),
    compress: { injectTool: true, injectNudge: false },
    promptCache: { routing: "auto" },
    sessionHeader: "x-acp-session",
    log: false,
    debug: false,
    passthrough: false,
    autoUpdate: false,
    autoRestartOnUpdate: false,
    advisoryCheck: false,
    releaseNotesCheck: false,
    compat: { roles: {} },
    streamErrorShape: "protocol",
    mitm: { enabled: false, domains: [] },
};

test("#4305: injectSystem appends the note only when the boundary is active", () => {
    const parsed = { system: "You are a helpful assistant.", messages: [] };
    const off = injectSystem({ ...parsed }, OPTS, undefined, defaultConfig(400_000), undefined, true, false, false) as string;
    assert.ok(!off.includes(GENERATION_BOUNDARY_NOTE), "inactive: system block unchanged by this feature");
    const on = injectSystem({ ...parsed }, OPTS, undefined, defaultConfig(400_000), undefined, true, false, false, true) as string;
    assert.ok(on.includes(GENERATION_BOUNDARY_NOTE), "active: note rides the ACP standing block");
    assert.ok(on.startsWith("You are a helpful assistant."), "client system block stays byte-exact (appended, never merged)");
    // sysParts order contract: client head, standing prompt (attribution outermost), THEN the note.
    assert.ok(on.indexOf(GENERATION_BOUNDARY_NOTE) > on.indexOf(PROJECT_ATTRIBUTION_LINE), "note sits AFTER the standing prompt, matching every steady prepare* path");
});
