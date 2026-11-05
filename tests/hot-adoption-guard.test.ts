import assert from "node:assert";
import test from "node:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";

import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";
import {
    hotAdoptionProbe,
    setHotAdoptionProbe,
    hotWritersOf,
    hotAdoptionRefuser,
    describeHotWriter,
} from "../src/adoption-guard.ts";

/**
 * #394/#5624: hot-adoption refusal. Two LIVE bili instances sharing one
 * sessions dir writing the SAME session is the split-brain state — the
 * sessions-row upsert is last-writer-wins, so alternating writers produce
 * digest drift and a frozen envelope. The resolver's inference-driven
 * adoption (prefix / append / simhash) must therefore skip a chain a live
 * peer committed recently and mint fresh instead; the liveness evidence
 * (writer markers) is the same one the #3923 split-brain alarm uses.
 */

// ---------------------------------------------------------------------------
// conversation harness (shape borrowed from prefix-affinity-simhash.test.ts)
// ---------------------------------------------------------------------------

function user(text: string): Record<string, unknown> {
    return { role: "user", content: text };
}

function assistant(text: string): Record<string, unknown> {
    return { role: "assistant", content: text };
}

function buildConversation(turns: number): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [];
    for (let i = 0; i < turns; i++) {
        msgs.push(user(`turn ${i}: please analyze the deployment pipeline for service alpha-${i} and report the latency profile of stage ${i} through stage ${i + 3}, including retry counts and queue depth`));
        msgs.push(assistant(`analysis ${i}: stage ${i} shows a stable latency profile with a p95 of ${120 + i}ms; the retry budget was consumed ${i} times; queue depth stayed under ${10 + i}; overall the pipeline for alpha-${i} is healthy and no intervention is required at this point in time`));
    }
    return msgs;
}

function restampWithModel(msgs: Record<string, unknown>[], model: string): Record<string, unknown>[] {
    return msgs.map((m, i) => {
        if (m.role !== "assistant") {
            if (i % 5 === 0) return { ...m, content: `${(m as { content: string }).content}\n<system-reminder>session migrated to ${model}</system-reminder>` };
            return m;
        }
        return { ...m, content: `You are a coding agent powered by the ${model} model.\n${(m as { content: string }).content}` };
    });
}

/** Establish a chain and return its session id. */
function track(r: PrefixAffinityResolver, msgs: Record<string, unknown>[]): string {
    const a = r.resolve(msgs)!;
    assert.ok(a, "resolve must produce an affinity for a valid conversation");
    r.note(a.sessionId, a.incomingDepth, a.tailHash, a.itemHashes, false, a.sketches, a.userFlags);
    return a.sessionId;
}

/** Incoming request = the stored history plus new turns (the #5624 shape:
 *  instance B's client carries a shared prefix and then goes its own way). */
function extended(original: Record<string, unknown>[]): Record<string, unknown>[] {
    return [
        ...original,
        user("one more thing: check the webhook delivery stage too"),
        assistant("webhook 9: delivery latency is stable; the retry queue drains within one window and no dead letters accumulated"),
    ];
}

// ---------------------------------------------------------------------------
// writer-marker fixtures (shape borrowed from served-markers.test.ts)
// ---------------------------------------------------------------------------

const DEAD_PID = 999_999_999;

function freshDir(): string {
    return mkdtempSync(join(tmpdir(), "hot-adoption-"));
}

function writeMarker(
    dir: string,
    peer: { instanceId: string; pid: number; origin?: string; version?: string },
    servedAt: Record<string, number>,
    extra: Record<string, unknown> = {},
): string {
    const file = join(dir, `${peer.instanceId}.json`);
    writeFileSync(file, JSON.stringify({
        v: 1,
        origin: "stdio",
        version: "test",
        ...peer,
        servedAt,
        ...extra,
    }));
    return file;
}

function backdate(file: string, ageMs: number): void {
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
}

// ---------------------------------------------------------------------------
// resolver-level: refusal falls through to fresh mint, adoption unchanged
// when uncontested
// ---------------------------------------------------------------------------

test("#394 refused prefix adoption falls through to a fresh mint and reports the refused chain", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    const out = r.resolve(extended(original), (id) => id === sessionId)!;
    assert.ok(out, "resolve must still produce an affinity");
    assert.equal(out.via, "new", "a contested chain must not be adopted — mint fresh instead");
    assert.notEqual(out.sessionId, sessionId, "the minted id must differ from the refused chain");
    assert.ok(out.refusedAdoption?.includes(sessionId), `refusedAdoption must list the skipped chain (got ${JSON.stringify(out.refusedAdoption)})`);
    // The same chain is refused in the prefix rung AND (as a simhash
    // candidate) again below — it must appear exactly once.
    assert.equal(out.refusedAdoption?.filter((id) => id === sessionId).length, 1, "refusedAdoption must be deduped");
});

test("#394 uncontested chains adopt exactly as before (no refuser)", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    const out = r.resolve(extended(original))!;
    assert.equal(out.via, "prefix", "an uncontested shared prefix must still adopt");
    assert.equal(out.sessionId, sessionId);
    assert.equal(out.refusedAdoption, undefined, "no refusal diagnostics without a refuser");
});

test("#394 a refuser that declines to refuse changes nothing", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    const out = r.resolve(extended(original), () => false)!;
    assert.equal(out.via, "prefix");
    assert.equal(out.sessionId, sessionId);
});

test("#394 the refuser is consulted only for chains that actually match the incoming history", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const contested = track(r, original);
    const unrelated = track(r, buildConversation(8).map((m, i) => ({
        ...m,
        content: `unrelated ${i}: quantum chromodynamics lattice gauge theory renormalization group flow with fermion determinant ${Math.random().toString(36).slice(2)}`,
    })));

    const consulted: string[] = [];
    const incoming = extended(original);
    const out = r.resolve(incoming, (id) => { consulted.push(id); return id === contested; })!;
    assert.ok(consulted.includes(contested), "the matching chain must be consulted");
    assert.ok(!consulted.includes(unrelated), "a chain that fails the match gates must never reach the refuser");
    assert.equal(out.via, "new");
});

test("#394 refused simhash adoption falls through to a fresh mint", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    // Decorative rewrite breaks the exact chain; only the simhash rung can
    // reach the stored chain — refusing it must mint fresh, not adopt.
    const rewritten = restampWithModel(original, "glm-5.3");
    const out = r.resolve(rewritten, (id) => id === sessionId)!;
    assert.equal(out.via, "new", "a contested chain must not be simhash-adopted");
    assert.notEqual(out.sessionId, sessionId);
    assert.ok(out.refusedAdoption?.includes(sessionId));
});

test("#394 residual, pinned: a pure replay re-mints the SAME deterministic id (containment is the #3923 alarm)", () => {
    const r = new PrefixAffinityResolver();
    const original = buildConversation(8);
    const sessionId = track(r, original);

    const out = r.resolve(original, (id) => id === sessionId)!;
    // pfa ids are deterministic from the tail hash, so a byte-identical
    // replay maps to the same session even after refusal. That shape (a
    // retried request re-routed to a second live instance) is documented in
    // the guard: the write-path contest alarm + freeze remain the containment.
    assert.equal(out.sessionId, sessionId, "deterministic id — refusal cannot rename a pure replay");
    assert.ok(out.refusedAdoption?.includes(sessionId), "the refusal is still reported for the log line");
});

// ---------------------------------------------------------------------------
// probe-level: live peer → contested; dead/stopped/own → adoptable
// ---------------------------------------------------------------------------

test("hotAdoptionProbe: a live peer actively writing the session contests it", () => {
    const dir = freshDir();
    try {
        const sid = "pfa-deadbeefcafe0123";
        writeMarker(dir, { instanceId: "peer-1", pid: process.pid }, { [sid]: Date.now() });
        const probe = hotAdoptionProbe(dir, "self-1");

        const hot = probe(sid);
        assert.equal(hot.length, 1, "the live peer must contest the session");
        assert.equal(hot[0]!.instanceId, "peer-1");
        assert.match(describeHotWriter(hot[0]!), /instance peer-1 \(pid \d+\)/);
        assert.equal(probe("pfa-someotherchain00").length, 0, "an untouched session is uncontested");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("hotAdoptionProbe: this instance's own marker never contests its sessions", () => {
    const dir = freshDir();
    try {
        const sid = "pfa-mine000000000001";
        writeMarker(dir, { instanceId: "self-1", pid: process.pid }, { [sid]: Date.now() });
        const probe = hotAdoptionProbe(dir, "self-1");
        assert.equal(probe(sid).length, 0, "own writes are not split-brain");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("hotAdoptionProbe: a crashed peer stops contesting once its marker goes stale (handoff stays adoptable)", () => {
    const dir = freshDir();
    try {
        const sid = "pfa-crashed0000000001";
        const file = writeMarker(dir, { instanceId: "peer-1", pid: DEAD_PID }, { [sid]: Date.now() - 40_000 });
        const probe = hotAdoptionProbe(dir, "self-1");

        // pid dead AND file older than PEER_FILE_FRESH_MS: the peer is gone,
        // its sessions are adoptable again (restart handoff #4626 shape).
        backdate(file, 40_000);
        assert.equal(probe(sid).length, 0, "dead pid + stale marker must not contest");

        // Fail-closed window: the crash is recent (marker still fresh) — the
        // session stays contested until the marker ages out.
        const fresh = writeMarker(dir, { instanceId: "peer-2", pid: DEAD_PID }, { [sid]: Date.now() - 10_000 });
        assert.equal(probe(sid).length, 1, "recently-dead peer with a fresh marker still contests (fail-closed)");
        void fresh;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("hotAdoptionProbe: a gracefully-stopped peer (stoppedAt/disposedAt) never contests", () => {
    const dir = freshDir();
    try {
        const sid = "pfa-handoff00000000001";
        writeMarker(dir, { instanceId: "peer-1", pid: process.pid }, { [sid]: Date.now() }, {
            stoppedAt: Date.now(),
            disposedAt: Date.now(),
        });
        const probe = hotAdoptionProbe(dir, "self-1");
        assert.equal(probe(sid).length, 0, "dispose() stamps the marker — handoff is not split-brain");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// wiring-level: the module plumbing the server sets up
// ---------------------------------------------------------------------------

test("wiring: setHotAdoptionProbe drives hotWritersOf/hotAdoptionRefuser; unwired reads as uncontested", () => {
    const dir = freshDir();
    try {
        const sid = "pfa-wired000000000001";
        writeMarker(dir, { instanceId: "peer-1", pid: process.pid }, { [sid]: Date.now() });
        setHotAdoptionProbe(hotAdoptionProbe(dir, "self-1"));
        try {
            assert.equal(hotWritersOf(sid).length, 1);
            assert.equal(hotAdoptionRefuser()?.(sid), true, "the refuser must refuse the contested id");
            assert.equal(hotAdoptionRefuser()?.("pfa-untouched000000001"), false);
        } finally {
            setHotAdoptionProbe(undefined);
        }
        // Unwired = inline engine / early boot: adoption behaves exactly as
        // before this guard existed.
        assert.equal(hotWritersOf(sid).length, 0);
        assert.equal(hotAdoptionRefuser(), undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("integration: a live peer on the chain makes the resolver mint fresh via the wired probe", () => {
    const dir = freshDir();
    try {
        const r = new PrefixAffinityResolver();
        const original = buildConversation(8);
        const sessionId = track(r, original);
        writeMarker(dir, { instanceId: "peer-1", pid: process.pid }, { [sessionId]: Date.now() });

        setHotAdoptionProbe(hotAdoptionProbe(dir, "self-1"));
        try {
            const out = r.resolve(extended(original), hotAdoptionRefuser())!;
            assert.equal(out.via, "new", "the contested chain must not be adopted");
            assert.notEqual(out.sessionId, sessionId);
            assert.ok(out.refusedAdoption?.includes(sessionId));
        } finally {
            setHotAdoptionProbe(undefined);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
