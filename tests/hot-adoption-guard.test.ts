import assert from "node:assert";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";
import {
    hotAdoptionProbe,
    setHotAdoptionProbe,
    hotWritersOf,
    hotAdoptionRefuser,
    describeHotWriter,
} from "../src/adoption-guard.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _setForTest } from "../src/registry.ts";
import { closeServers } from "./server-close-guard.ts";

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

// ---------------------------------------------------------------------------
// plugin plane (HTTP): disk-adoption refusal, tool-execution 409, fork 409.
// startServer wires the probe for real (src/server.ts), so these drive the
// actual gate over HTTP against hand-crafted peer markers — pid is this
// process (provably alive) under a FOREIGN instance id, which keeps the
// liveness verdict deterministic (no crash/timing games).
// ---------------------------------------------------------------------------

interface GuardHarness {
    baseUrl: string;
    upstreamUrl: string;
    storeDir: string;
    markerFile: (instanceId: string) => string;
    stop: () => Promise<void>;
}

// `mode` picks the storage substrate: a cold-adopted non-fork session serves
//  its snapshot ONLY through the unified raw-tail reconstruction (#5140) —
//  legacy mode fail-closes with 409 by design, so the disk-adoption subtest
//  boots "shadow"; the resident-session subtests stay on the legacy default.
async function bootGuardHarness(mode: "shadow" | "legacy" = "legacy"): Promise<GuardHarness> {
    const prevMode = process.env.BILI_STORAGE_UNIFIED;
    process.env.BILI_STORAGE_UNIFIED = mode;
    const dir = mkdtempSync(join(tmpdir(), "hot-adoption-http-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    _setForTest({});
    const storeDir = join(dir, "sessions");
    _setStoreForTest(new SessionStore({ dir: storeDir, enabled: true, debounceMs: 30 }));

    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400_000 } } } }, modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    return {
        baseUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        upstreamUrl,
        storeDir,
        markerFile: (instanceId) => join(dir, "billion-context", "writers", `${instanceId}.json`),
        stop: async () => { getStore().closeQuietly(); await closeServers([proxy, upstream], "hot-adoption-guard harness"); if (prevMode === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevMode; },
    };
}

function writePeerMarker(h: GuardHarness, instanceId: string, sessionIds: string[]): void {
    mkdirSync(dirname(h.markerFile(instanceId)), { recursive: true });
    const servedAt: Record<string, number> = {};
    for (const s of sessionIds) servedAt[s] = Date.now();
    writeFileSync(h.markerFile(instanceId), JSON.stringify({ v: 1, instanceId, pid: process.pid, origin: "test", version: "test", servedAt }));
}

function dropPeerMarker(h: GuardHarness, instanceId: string): void {
    rmSync(h.markerFile(instanceId), { force: true });
}

async function pluginTurn(h: GuardHarness, conversation: string, messages: Record<string, unknown>[]): Promise<void> {
    const res = await fetch(`${h.baseUrl}/bili/${h.upstreamUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conversation },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }),
    });
    assert.equal(res.status, 200, `plugin turn for ${conversation} must succeed`);
    await res.text();
}

function findPersistedFile(root: string, id: string): boolean {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
        const p = join(root, e.name);
        if (e.isDirectory()) { if (findPersistedFile(p, id)) return true; continue; }
        if (!e.name.endsWith(".json") || e.name.includes(".tmp-") || e.name.endsWith(".content-store.json")) continue;
        try { if ((JSON.parse(readFileSync(p, "utf8")) as { id?: string }).id === id) return true; } catch { /* torn read — keep scanning */ }
    }
    return false;
}

async function toolPost(h: GuardHarness, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${h.baseUrl}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function jsonBody(res: Response): Promise<Record<string, unknown> | null> {
    try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
}

function forkRequest(snapshot: { parentRevision: string; orderedMessages: unknown[] }, parent: string, child: string, count = 2) {
    const orderedMessages = snapshot.orderedMessages.slice(0, count);
    return { protocolVersion: 1, parentConversationId: parent, childConversationId: child, parentRevision: snapshot.parentRevision, branchPoint: { messageCount: count, orderHash: createHash("sha256").update(JSON.stringify(orderedMessages)).digest("hex") }, orderedMessages, idempotencyKey: `fork-${child}` };
}

test("#394 plugin plane: disk adoption of a hot session is refused (snapshot 404), uncontested adopts", { timeout: 60_000 }, async () => {
    const h = await bootGuardHarness("shadow");
    try {
        await pluginTurn(h, "guard-disk", [{ role: "user", content: "persist me to disk" }]);
        const resident = peekSession("guard-disk");
        assert.ok(resident, "the turn must leave the session resident");
        assert.ok(getStore().flushSync(resident), "flush must persist the row");
        assert.ok(findPersistedFile(h.storeDir, "guard-disk"), "the row must be on disk");
        _resetSessionsForTest();
        assert.equal(peekSession("guard-disk"), undefined, "precondition: non-resident but stored");

        // Negative direction first: without peer evidence the stored session
        //  adopts from disk exactly as before this guard existed.
        let res = await fetch(`${h.baseUrl}/__bili/plugin/snapshot?conversationId=guard-disk`);
        assert.equal(res.status, 200, `uncontested disk adoption must still work: ${(await res.text()).slice(0, 200)}`);
        _resetSessionsForTest();

        // Contested: the live peer's marker blocks the adoption…
        writePeerMarker(h, "peer-disk", ["guard-disk"]);
        res = await fetch(`${h.baseUrl}/__bili/plugin/snapshot?conversationId=guard-disk`);
        const refused = await jsonBody(res);
        assert.equal(res.status, 404, `a hot stored session must NOT be adopted (got ${res.status})`);
        assert.equal(refused?.code, "PARENT_NOT_FOUND");
        assert.equal(peekSession("guard-disk"), undefined, "the refusal must leave NO residency behind — the next call re-probes from disk");

        // A refused adoption must NOT be swallowed by the fallback-latest
        //  branch and answered with ANOTHER session's state under this id —
        //  name the holder instead (#5716 review finding).
        res = await fetch(`${h.baseUrl}/__bili/plugin/status?conversationId=guard-disk&fallback=latest`);
        const heldStatus = await jsonBody(res);
        assert.equal(res.status, 409, `a refused adoption must NOT fall back to another session (got ${res.status})`);
        assert.equal(heldStatus?.code, "HELD_BY_PEER_INSTANCE");
        assert.match(String(heldStatus?.error), /instance peer-disk/, "the refusal must name the peer");

        // …and is liveness-scoped: drop the evidence and adoption returns.
        dropPeerMarker(h, "peer-disk");
        res = await fetch(`${h.baseUrl}/__bili/plugin/snapshot?conversationId=guard-disk`);
        assert.equal(res.status, 200, "once the peer evidence is gone the session must be adoptable again");
        res = await fetch(`${h.baseUrl}/__bili/plugin/status?conversationId=guard-disk&fallback=latest`);
        const recovered = await jsonBody(res);
        assert.equal(res.status, 200, "status must resolve the session again once clear");
        assert.equal(recovered?.sessionId, "guard-disk", "…to THIS session, not a fallback pick");
    } finally {
        await h.stop();
    }
});

test("#394 plugin plane: proxy tool execution for a hot session answers 409 naming the peer", { timeout: 60_000 }, async () => {
    const h = await bootGuardHarness();
    try {
        await pluginTurn(h, "guard-tool", [{ role: "user", content: "tool routing probe" }]);

        // Uncontested: the guard stays silent and the tool executes.
        let r = await toolPost(h, { tool: "acp_status", conversationId: "guard-tool" });
        assert.equal(r.status, 200, `uncontested tool call must execute (got ${r.status}: ${JSON.stringify(r.json)?.slice(0, 200)})`);
        assert.equal(r.json?.ok, true);

        // Contested: the resident session is still written by a live peer —
        //  executing the tool would write it too, so fail closed.
        writePeerMarker(h, "peer-tool", ["guard-tool"]);
        r = await toolPost(h, { tool: "acp_status", conversationId: "guard-tool" });
        assert.equal(r.status, 409, `a hot session must refuse tool execution (got ${r.status})`);
        assert.match(String(r.json?.error), /being served by another bili instance \(instance peer-tool/, `the refusal must name the peer: ${JSON.stringify(r.json)}`);

        // Liveness-scoped: evidence gone → execution resumes.
        dropPeerMarker(h, "peer-tool");
        r = await toolPost(h, { tool: "acp_status", conversationId: "guard-tool" });
        assert.equal(r.status, 200, "an uncontested session must execute tools again");
    } finally {
        await h.stop();
    }
});

test("#394 plugin plane: a fork POST while the peer holds either side fails closed, then succeeds once clear", { timeout: 60_000 }, async () => {
    const h = await bootGuardHarness();
    try {
        await pluginTurn(h, "guard-parent", [
            { role: "user", content: "first original ".repeat(50) },
            { role: "assistant", content: "second original ".repeat(50) },
            { role: "user", content: "tail original" },
        ]);
        const snapRes = await fetch(`${h.baseUrl}/__bili/plugin/snapshot?conversationId=guard-parent`);
        assert.equal(snapRes.status, 200, "the parent snapshot must be available");
        const snapshot = (await snapRes.json()) as { parentRevision: string; orderedMessages: unknown[] };

        // Idempotent-retry shape: the FIRST attempt already succeeded on the
        //  peer (its marker says so) — this retry must NOT re-create the
        //  child here and clobber the peer's rows.
        writePeerMarker(h, "peer-fork", ["guard-child"]);
        let res = await fetch(`${h.baseUrl}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forkRequest(snapshot, "guard-parent", "guard-child", 2)) });
        let body = await jsonBody(res);
        assert.equal(res.status, 409, `a peer-held child must refuse the fork (got ${res.status}: ${JSON.stringify(body)?.slice(0, 200)})`);
        assert.equal(body?.code, "HELD_BY_PEER_INSTANCE");
        assert.match(String(body?.error), /instance peer-fork/, "the refusal must name the peer");
        assert.equal(resolveConversation("guard-child").session, undefined, "no child may be created on the refusing side");
        assert.ok(!findPersistedFile(h.storeDir, "guard-child"), "no child row may be persisted on the refusing side");

        // Parent-held half of the same gate (defends the flushSync(parent)).
        dropPeerMarker(h, "peer-fork");
        writePeerMarker(h, "peer-fork", ["guard-parent"]);
        res = await fetch(`${h.baseUrl}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forkRequest(snapshot, "guard-parent", "guard-child-2", 2)) });
        body = await jsonBody(res);
        assert.equal(res.status, 409, `a peer-held parent must refuse the fork (got ${res.status})`);
        assert.equal(body?.code, "HELD_BY_PEER_INSTANCE");

        // Once both sides are clear the identical request proceeds.
        dropPeerMarker(h, "peer-fork");
        res = await fetch(`${h.baseUrl}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forkRequest(snapshot, "guard-parent", "guard-child", 2)) });
        body = await jsonBody(res);
        assert.equal(res.status, 201, `an uncontested fork must succeed (got ${res.status}: ${JSON.stringify(body)?.slice(0, 200)})`);
        assert.equal(body?.childConversationId, "guard-child");

        // Replay placement pin (#5716 review finding): an idempotent retry of
        //  the SAME request must still succeed while the peer holds only the
        //  PARENT — replay() is read-only-safe (the child's committed
        //  envelope), so the gate protects the create branch without starving
        //  retries of a conversation whose parent is still live elsewhere.
        writePeerMarker(h, "peer-fork", ["guard-parent"]);
        res = await fetch(`${h.baseUrl}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(forkRequest(snapshot, "guard-parent", "guard-child", 2)) });
        body = await jsonBody(res);
        assert.equal(res.status, 200, `an idempotent replay must succeed while only the parent is peer-held (got ${res.status}: ${JSON.stringify(body)?.slice(0, 200)})`);
        assert.equal(body?.replayed, true);
        dropPeerMarker(h, "peer-fork");
    } finally {
        await h.stop();
    }
});
