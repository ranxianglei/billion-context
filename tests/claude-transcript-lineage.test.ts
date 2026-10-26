import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { listSessions, detectUnannouncedHistoryRewrite, getSession, REF_FLOOR_RAW_ID, reserveRefsThrough } from "../src/session.ts";
import { claudeTranscriptParent, resolveClaudeTranscriptLineage } from "../src/claude-transcript-lineage.ts";

/**
 * Explicit Claude Code resume lineage (transcript forkedFrom).
 *
 * The live failure: a rate-limited turn was retried after an account switch;
 * opencode-claude forked the Claude session (Agent SDK forkSession) and the
 * resumed request had EXACTLY the parent's last message count with only the
 * tail re-decorated. #1486's prefix resolver requires a strictly longer,
 * byte-exact continuation, so it fell back to a far older ancestor and every
 * block folded since was re-folded. The transcript names the true parent.
 */

function mkConfigDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-cfg-"));
}

function writeTranscript(configDir: string, project: string, sessionId: string, lines: unknown[], trailing = "\n"): string {
    const dir = path.join(configDir, "projects", project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + trailing);
    return file;
}

function forkLine(parent: string, uuid = randomUUID()): Record<string, unknown> {
    return { type: "user", uuid, parentUuid: null, forkedFrom: { sessionId: parent, messageUuid: randomUUID() }, message: { role: "user", content: "hi" } };
}

// ---------------------------------------------------------------- unit: lookup

test("transcript lookup: forkedFrom on the head names the direct parent, any project dir", () => {
    const cfg = mkConfigDir();
    const child = randomUUID();
    const parent = randomUUID();
    writeTranscript(cfg, "-some-very-long-encoded-path-1a2b3c", child, [{ type: "custom-title", title: "x" }, forkLine(parent)]);
    const r = claudeTranscriptParent(child, [cfg]);
    assert.equal(r.kind, "parent");
    assert.equal(r.kind === "parent" && r.parentId, parent);
});

test("transcript lookup: no transcript / no marker / non-UUID id are distinct misses", () => {
    const cfg = mkConfigDir();
    const plain = randomUUID();
    writeTranscript(cfg, "p", plain, [{ type: "user", uuid: randomUUID(), message: { role: "user", content: "hi" } }]);
    assert.deepEqual(claudeTranscriptParent(randomUUID(), [cfg]), { kind: "none", reason: "no-transcript" });
    assert.deepEqual(claudeTranscriptParent(plain, [cfg]), { kind: "none", reason: "no-fork-marker" });
    assert.deepEqual(claudeTranscriptParent("../../etc/passwd", [cfg]), { kind: "none", reason: "invalid-id" });
});

test("transcript lookup: a half-written trailing line is ignored, self-reference rejected", () => {
    const cfg = mkConfigDir();
    const child = randomUUID();
    const parent = randomUUID();
    // Only line is still being written (no newline yet): not trusted.
    writeTranscript(cfg, "p", child, [JSON.stringify(forkLine(parent)).slice(0, 60)], "");
    assert.equal(claudeTranscriptParent(child, [cfg]).kind, "none");
    const self = randomUUID();
    writeTranscript(cfg, "p", self, [forkLine(self)]);
    assert.deepEqual(claudeTranscriptParent(self, [cfg]), { kind: "none", reason: "no-fork-marker" });
});

test("transcript lookup: same id naming different parents in two projects is ambiguous", () => {
    const cfg = mkConfigDir();
    const child = randomUUID();
    writeTranscript(cfg, "p1", child, [forkLine(randomUUID())]);
    writeTranscript(cfg, "p2", child, [forkLine(randomUUID())]);
    assert.deepEqual(claudeTranscriptParent(child, [cfg]), { kind: "none", reason: "ambiguous" });
});

test("transcript lookup: a symlink escaping the projects root is not followed", () => {
    const cfg = mkConfigDir();
    const outside = mkConfigDir();
    const child = randomUUID();
    const target = writeTranscript(outside, "x", child, [forkLine(randomUUID())]);
    fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
    fs.symlinkSync(target, path.join(cfg, "projects", "p", `${child}.jsonl`));
    assert.deepEqual(claudeTranscriptParent(child, [cfg]), { kind: "none", reason: "no-transcript" });
});

test("lineage walk: skips ancestors the proxy never saw, stops on cycles and the depth cap", () => {
    const cfg = mkConfigDir();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    writeTranscript(cfg, "p", c, [forkLine(b)]);
    writeTranscript(cfg, "p", b, [forkLine(a)]);
    assert.deepEqual(resolveClaudeTranscriptLineage(c, (id) => id === a, { configDirs: [cfg] }), { parentId: a, hops: 2 });
    assert.deepEqual(resolveClaudeTranscriptLineage(c, (id) => id === b, { configDirs: [cfg] }), { parentId: b, hops: 1 });

    const [x, y] = [randomUUID(), randomUUID()];
    writeTranscript(cfg, "p", x, [forkLine(y)]);
    writeTranscript(cfg, "p", y, [forkLine(x)]);
    assert.equal(resolveClaudeTranscriptLineage(x, () => false, { configDirs: [cfg] }).parentId, undefined);
    assert.equal(resolveClaudeTranscriptLineage(c, () => false, { configDirs: [cfg], maxDepth: 1 }).parentId, undefined);
});

// ------------------------------------------------- unit: rewrite detection (C)

test("rewrite detection: appending far more new messages than were known is NOT a rewrite", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = getSession(`rw-append-${randomUUID()}`);
    s.state.blocks.push({ blockId: "b1" } as never);
    const known = new Set(Array.from({ length: 900 }, (_, i) => `k${i}`));
    // The live shape: 897 inherited refs, all still present, 1871 new ones.
    const incoming = [...known, ...Array.from({ length: 1900 }, (_, i) => `n${i}`)];
    const r = detectUnannouncedHistoryRewrite(s, known, incoming);
    assert.equal(r.detected, false, "every known message survived — nothing was rewritten");
});

test("rewrite detection: a genuine rewrite (most old history gone) still fires", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = getSession(`rw-real-${randomUUID()}`);
    s.state.blocks.push({ blockId: "b1" } as never);
    const known = new Set(Array.from({ length: 200 }, (_, i) => `k${i}`));
    const incoming = [...Array.from({ length: 10 }, (_, i) => `k${i}`), ...Array.from({ length: 40 }, (_, i) => `n${i}`)];
    assert.equal(detectUnannouncedHistoryRewrite(s, known, incoming).detected, true);
});

test("ref floor: reserveRefsThrough pins the cursor and is ignored by the rewrite ratio", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = getSession(`floor-${randomUUID()}`);
    s.state.messageRefs.byRaw.r1 = "m00003";
    s.state.messageRefs.byRef.m00003 = "r1";
    assert.equal(reserveRefsThrough(s, 2), false, "no-op below the current high-water mark");
    assert.equal(reserveRefsThrough(s, 2944), true);
    assert.equal(s.state.messageRefs.byRaw[REF_FLOOR_RAW_ID], "m02944");
    assert.equal(s.state.messageRefs.byRef.m02944, undefined, "the floor never resolves to a message");
});

// ------------------------------------------------------ end-to-end (anthropic)

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

function anthropicStream(text: string): string {
    return (
        anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" })
    );
}

interface Rig {
    send(sessionId: string, messages: Msg[], header?: string): Promise<string>;
    closeAll(): Promise<void>;
}

type Msg = { role: "user" | "assistant"; content: string };

async function startRig(): Promise<Rig> {
    let n = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            n += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(anthropicStream(`reply ${n}: ${FILLER.repeat(6)}`));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-lineage-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, { preserveRecentMessages: 2, preserveRecentTokens: 400 }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        resumeInheritance: true,
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
    const closeOne = (s: http.Server): Promise<void> => new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        async send(sessionId, messages, header = "x-claude-code-session-id") {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-api-key": "test", [header]: sessionId },
                body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages }),
            });
            const raw = await res.text();
            assert.equal(res.status, 200, raw.slice(0, 300));
            let text = "";
            for (const line of raw.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                    const ev = JSON.parse(line.slice(5)) as { type?: string; delta?: { type?: string; text?: string } };
                    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text ?? "";
                } catch {
                    /* keepalive */
                }
            }
            return text;
        },
        closeAll: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
            if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdg;
        },
    };
}

async function growParent(rig: Rig, parentId: string, turns: number, header?: string): Promise<Msg[]> {
    const history: Msg[] = [];
    let last: Msg[] = [];
    for (let i = 1; i <= turns; i++) {
        history.push({ role: "user", content: `${parentId} user turn ${i}: ${FILLER.repeat(12)}` });
        last = [...history];
        const reply = await rig.send(parentId, history, header);
        history.push({ role: "assistant", content: reply });
    }
    // The parent's LAST request (ends on a user turn), not the history after it.
    return last;
}

/** The live shape: same message count as the parent's last request, only the
 *  final user message re-decorated (skills delta / session_start reminder). */
function redecorate(lastRequest: Msg[]): Msg[] {
    const out = lastRequest.map((m) => ({ ...m }));
    const tail = out[out.length - 1]!;
    tail.content = `${tail.content}\n<system-reminder>The session context was re-read.</system-reminder>`;
    return out;
}

function assertNoRefReuse(parentByRef: Record<string, string>, childByRef: Record<string, string>): void {
    for (const [ref, raw] of Object.entries(childByRef)) {
        const p = parentByRef[ref];
        if (p !== undefined) assert.equal(raw, p, `ref ${ref} must denote the same message in parent and child`);
    }
}

test("e2e: equal-length, tail-rewritten Claude resume inherits from the transcript parent", async () => {
    const cfg = mkConfigDir();
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const rig = await startRig();
    try {
        const parentId = randomUUID();
        const childId = randomUUID();
        const lastRequest = await growParent(rig, parentId, 8);
        const parent = listSessions().find((s) => s.id === parentId);
        assert.ok(parent, "parent session exists");
        const parentByRaw = { ...parent.state.messageRefs.byRaw };
        const parentByRef = { ...parent.state.messageRefs.byRef };
        assert.ok(Object.keys(parentByRaw).length >= 5, "parent numbered its history");

        writeTranscript(cfg, "-home-user-proj", childId, [forkLine(parentId)]);
        const resumed = redecorate(lastRequest);
        const reply = await rig.send(childId, resumed);
        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "child session exists");
        assert.equal(child.metadata.derivedFromSessionId, parentId, "lineage comes from the transcript, not an older ancestor");
        const shared = Object.entries(parentByRaw).filter(([raw]) => raw !== REF_FLOOR_RAW_ID && child.state.messageRefs.byRaw[raw] !== undefined);
        assert.ok(shared.length >= 5, "the shared history's refs are inherited");
        for (const [raw, ref] of shared) assert.equal(child.state.messageRefs.byRaw[raw], ref);

        // Keep talking: fresh numbers must never collide with the parent's.
        const more: Msg[] = [...resumed, { role: "assistant", content: reply }, { role: "user", content: `child turn 2: ${FILLER.repeat(12)}` }];
        const reply2 = await rig.send(childId, more);
        more.push({ role: "assistant", content: reply2 }, { role: "user", content: `child turn 3: ${FILLER.repeat(12)}` });
        await rig.send(childId, more);
        assertNoRefReuse(parentByRef, child.state.messageRefs.byRef);
    } finally {
        await rig.closeAll();
        if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
});

test("e2e: without a transcript the same resume finds no parent (the pre-fix failure shape)", async () => {
    const cfg = mkConfigDir();
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const rig = await startRig();
    try {
        const parentId = randomUUID();
        const childId = randomUUID();
        const lastRequest = await growParent(rig, parentId, 6);
        await rig.send(childId, redecorate(lastRequest));
        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child);
        assert.notEqual(child.metadata.derivedFromSessionId, parentId, "equal-length tail-rewritten resume is invisible to the prefix match");
    } finally {
        await rig.closeAll();
        if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
});

test("e2e: a transcript is only consulted for x-claude-code-session-id identities", async () => {
    const cfg = mkConfigDir();
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const rig = await startRig();
    try {
        const parentId = randomUUID();
        const childId = randomUUID();
        const lastRequest = await growParent(rig, parentId, 6, "x-acp-session");
        writeTranscript(cfg, "p", childId, [forkLine(parentId)]);
        await rig.send(childId, redecorate(lastRequest), "x-acp-session");
        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child);
        assert.notEqual(child.metadata.derivedFromSessionId, parentId, "generic session headers never read Claude transcripts");
    } finally {
        await rig.closeAll();
        if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
});
