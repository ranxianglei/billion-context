// #5542 regression: ref-ledger generation resets (persona fork / native-
// compaction rebase) were invisible — no log marker at the split moment, the
// standing note only after residue detection (which never fires when the reset
// discarded the citing text too), no acp_status section, and a decompress
// not-found that reads like a typo and invites retry loops on ids that can
// never resolve. These tests pin the witnessed surfaces: the [acp-gen-reset]
// log line + metadata record seeded at the split, first-wins semantics, the
// fork-witness gates, the rebase witness carrying the pre-rebase frontier,
// the acp_status GENERATION BOUNDARY section, the decompress receipt naming
// the discarded generation, and the note's execution-tail compensation clause.

process.env.BILI_PERSIST = "0";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, defaultConfig } from "acp-kernel";
import type { CoreMessage } from "acp-kernel";
import { createSession, getSession, reconcileNativeCompactionBoundary, type Session } from "../src/session.js";
import { detectGenerationBoundary, GENERATION_BOUNDARY_NOTE, readGenerationBoundary, witnessForkedGeneration, witnessGenerationReset } from "../src/generation-boundary.js";
import { handleAcpStatus } from "../src/acp-status.js";
import { resolveDecompress } from "../src/decompress-shared.js";

const rand = (): string => Math.random().toString(36).slice(2);

function seedRefs(s: Session, n: number): void {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    for (let i = 1; i <= n; i++) {
        const ref = `m${String(i).padStart(5, "0")}`;
        byRaw[`raw-${i}`] = ref;
        byRef[ref] = `raw-${i}`;
    }
    s.state.messageRefs.byRaw = byRaw;
    s.state.messageRefs.byRef = byRef;
}

test("#5542: witnessed reset seeds the boundary record and logs [acp-gen-reset]", () => {
    const s = getSession(`g5542-seed-${rand()}`);
    const logs: string[] = [];
    const seeded = witnessGenerationReset(s, { reason: "persona-fork", detail: "conversation raw-1 forked onto raw-1|sub:task:abc12345", frontier: 42 }, (_l, m) => logs.push(m));
    assert.equal(seeded, true);
    const rec = readGenerationBoundary(s);
    assert.ok(rec, "record persisted in session metadata");
    assert.equal(rec!.frontier, "m00042");
    assert.equal(rec!.reason, "persona-fork");
    assert.equal(logs.length, 1, "witness logged exactly once");
    assert.match(logs[0]!, /\[acp-gen-reset\]/);
    assert.match(logs[0]!, /persona-fork/);
    assert.match(logs[0]!, /m00042/);
});

test("#5542: witness is first-wins — a residue-detected record is not overwritten by a later witness", () => {
    const s = getSession(`g5542-first-${rand()}`);
    seedRefs(s, 10);
    const staleMsgs: CoreMessage[] = [
        { id: "a", role: "user", contentType: "text", text: "old receipt compress m00042–m00051" },
        { id: "b", role: "assistant", contentType: "text", text: "and m00060 was listed too" },
    ];
    assert.equal(detectGenerationBoundary(s, staleMsgs), true, "fixture sanity: residue detected");
    const before = readGenerationBoundary(s)!;
    const overwritten = witnessGenerationReset(s, { reason: "persona-fork", frontier: 7 });
    assert.equal(overwritten, false);
    const after = readGenerationBoundary(s)!;
    assert.equal(after.at, before.at, "earliest boundary kept");
    assert.equal(after.maxStaleRef, before.maxStaleRef);
    assert.equal(after.reason, undefined, "detection record shape untouched");
});

test("#5542: fork witness gates on fresh fork + raw session with minted refs", () => {
    const rawId = `g5542-fork-raw-${rand()}`;
    const raw = getSession(rawId);
    seedRefs(raw, 33);
    const forkId = `${rawId}|sub:task:deadbeef`;
    const fork = getSession(forkId);
    const logs: string[] = [];
    assert.equal(witnessForkedGeneration(fork, rawId, forkId, (_l, m) => logs.push(m)), true, "fresh fork off a ref-minting raw session witnesses");
    assert.equal(readGenerationBoundary(fork)!.frontier, "m00033", "frontier is the RAW session's high-water mark");
    assert.match(logs[0]!, /\[acp-gen-reset\]/);
    assert.equal(witnessForkedGeneration(fork, rawId, forkId), false, "repeat call: first-wins");

    const rawEmpty = getSession(`g5542-empty-raw-${rand()}`);
    const fork2 = getSession(`${rawEmpty.id}|sub:task:cafebabe`);
    assert.equal(witnessForkedGeneration(fork2, rawEmpty.id, fork2.id), false, "#2156 sidecar shape: raw session minted nothing — no previous generation to lose");
    assert.equal(readGenerationBoundary(fork2), undefined);

    const rawBusy = getSession(`g5542-busy-raw-${rand()}`);
    seedRefs(rawBusy, 5);
    const fork3 = getSession(`${rawBusy.id}|sub:task:feedface`);
    seedRefs(fork3, 2);
    assert.equal(witnessForkedGeneration(fork3, rawBusy.id, fork3.id), false, "non-fresh fork was already witnessed on birth");
    assert.equal(readGenerationBoundary(fork3), undefined);
});

test("#5542: native-compaction rebase witnesses the reset with the pre-rebase frontier", () => {
    const s = getSession(`g5542-rebase-${rand()}`);
    seedRefs(s, 33);
    s.metadata!.nativeCompactionBoundary = { at: Date.now(), pendingRebase: true };
    assert.equal(reconcileNativeCompactionBoundary(s), true, "rebase lands");
    const rec = readGenerationBoundary(s);
    assert.ok(rec, "rebase seeds the boundary record at the split moment");
    assert.equal(rec!.reason, "native-compaction-rebase");
    assert.equal(rec!.frontier, "m00033", "pre-rebase high-water mark captured before the reset wiped the map");
});

function statusCtx(session: Session) {
    return { core: createCore(), config: defaultConfig(200_000), messages: [] as CoreMessage[], session, log: () => { } };
}

test("#5542: acp_status renders the GENERATION BOUNDARY section for a witnessed boundary", () => {
    const s = createSession(`g5542-status-${rand()}`);
    witnessGenerationReset(s, { reason: "persona-fork", detail: "conversation X forked onto Y", frontier: 12 });
    const report = handleAcpStatus({}, statusCtx(s)).text;
    assert.ok(report.includes("GENERATION BOUNDARY"), `section missing: ${report.slice(0, 400)}`);
    assert.ok(report.includes("persona-fork"), "witness reason surfaced");
    assert.ok(report.includes("m00012"), "previous-generation frontier named");
    assert.ok(report.includes("PERMANENTLY INERT"), "inertness stated so retry loops stop");
    assert.ok(report.includes("verify disk/git state"), "execution-tail compensation order present");
});

test("#5542: acp_status section falls back to residue wording for detection records and stays absent otherwise", () => {
    const s = createSession(`g5542-status-det-${rand()}`);
    s.metadata!.generationBoundary = { at: Date.now(), frontier: "m00010", maxStaleRef: "m09631" };
    const report = handleAcpStatus({}, statusCtx(s)).text;
    assert.ok(report.includes("GENERATION BOUNDARY"), "detection-shaped record renders too");
    assert.ok(report.includes("residue detected"), "fallback wording names the detection path");
    const bare = createSession(`g5542-status-none-${rand()}`);
    assert.ok(!handleAcpStatus({}, statusCtx(bare)).text.includes("GENERATION BOUNDARY"), "no boundary: report unchanged");
});

type DecompressCtx = Parameters<typeof resolveDecompress>[1];

function decompressCtx(session: Session): DecompressCtx {
    return { core: createCore(), config: defaultConfig(200_000), messages: [], session, log: () => { } } as unknown as DecompressCtx;
}

test("#5542: decompress not-found names the discarded generation when a boundary is active", () => {
    const s = getSession(`g5542-dec-${rand()}`);
    witnessGenerationReset(s, { reason: "persona-fork", frontier: 5 });
    const out = resolveDecompress({ blockId: "b7" }, decompressCtx(s)).text;
    assert.ok(out.startsWith("[Block b7 not found]"), out);
    assert.ok(out.includes("previous generation"), out);
    assert.ok(out.includes("PERMANENTLY INERT"), out);
    assert.ok(out.includes("do not retry variations"), out);
});

test("#5542: decompress not-found stays bare without a boundary (typo case byte-unchanged)", () => {
    const s = getSession(`g5542-dec-none-${rand()}`);
    const out = resolveDecompress({ blockId: "b7" }, decompressCtx(s)).text;
    assert.equal(out, "[Block b7 not found]");
});

test("#5542: the standing note carries the execution-tail compensation clause", () => {
    assert.ok(GENERATION_BOUNDARY_NOTE.includes("UNVERIFIED"), "earlier completion reports demoted to unverified");
    assert.ok(GENERATION_BOUNDARY_NOTE.includes("execution tail"), "names the failure mode");
    assert.ok(GENERATION_BOUNDARY_NOTE.includes("Check the real state"), "orders verification before claiming completion");
});
