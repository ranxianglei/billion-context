import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, cacheBlockContent } from "../src/session.ts";
import { exportSession, listSessions, renderHandoff } from "../src/export.ts";
import { parseArgs } from "../src/cli.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

function makeSession(id: string, title: string, label: string | undefined): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title, ...(label ? { label } : {}) },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("bili export lists sessions and renders a handoff doc with summaries and originals", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-export-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    const s = makeSession("abc123", "Fix auth bug", "ses_abc");
    s.state.blocks.push({
        blockId: "b0", runId: "r0", tier: 1, topic: "auth debug",
        summary: "Debugged the auth flow; root cause was a stale token in config.ts:12.",
        directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 4200, createdAt: Date.now(), survivedCount: 2, generation: "young", active: true,
    });
    cacheBlockContent(s, "b0", {
        one: { text: "summary text", count: 1 },
        full: { text: "user: help me fix auth\nassistant: checking config.ts:12", count: 2 },
    });
    await store.writeNow(s);

    try {
        const list = await listSessions({ dir });
        assert.equal(list.length, 1);
        assert.equal(list[0]!.title, "Fix auth bug");
        assert.equal(list[0]!.blocks, 1);

        const listing = await exportSession(undefined, { dir });
        assert.match(listing, /abc123/);
        assert.match(listing, /ses_abc/);
        assert.match(listing, /Fix auth bug/);

        const md = await exportSession("abc123", { dir });
        assert.match(md, /# billion-context session handoff/);
        assert.match(md, /Fix auth bug/);
        assert.match(md, /b0 — auth debug/);
        assert.match(md, /stale token in config\.ts:12/);
        assert.doesNotMatch(md, /help me fix auth/);

        const mdFull = await exportSession("ses_abc", { dir, full: true });
        assert.match(mdFull, /help me fix auth/);
        assert.match(mdFull, /Original messages \(2\)/);

        const out = path.join(dir, "handoff.md");
        const written = await exportSession("abc123", { dir, full: true, output: out });
        assert.match(written, /handoff\.md/);
        assert.match(readFileSync(out, "utf8"), /help me fix auth/);

        await assert.rejects(() => exportSession("nope", { dir }), /no session matches/);
    } finally {
        store.closeQuietly();
        rmrf(dir);
    }
});

test("handoff preserves the latest tool call outside request pruning and across storage reloads", async () => {
    const previous = process.env.BILI_STORAGE_UNIFIED;
    try {
        for (const mode of ["legacy", "full"]) {
            process.env.BILI_STORAGE_UNIFIED = mode;
            const dir = mkdtempSync(path.join(tmpdir(), "bili-handoff-reply-"));
            const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            try {
                const s = makeSession("latest-tool", "Latest reply", undefined);
                s.lastMessages = [{ id: "request", role: "user", contentType: "text", text: "read config" }];
                s.metadata.handoffResponse = {
                    request: s.stats.requests,
                    messages: [{ id: "reply", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call1", text: '{"path":"config.ts"}' }],
                };
                const before = JSON.stringify(s.lastMessages);
                for (const full of [false, true]) {
                    const md = renderHandoff(s, full);
                    assert.match(md, /### assistant\n/);
                    assert.match(md, /read\(call1\)/);
                    assert.match(md, /config\.ts/);
                    assert.match(md, /1 (?:client )?messages/);
                }
                assert.equal(JSON.stringify(s.lastMessages), before, "export does not alter the request snapshot");
                await store.writeNow(s);
                const restored = store.loadSync(s.id);
                assert.ok(restored);
                assert.match(renderHandoff(restored, false), /read\(call1\)/);
                restored.stats.requests++;
                assert.doesNotMatch(renderHandoff(restored, false), /read\(call1\)/);
            } finally {
                store.closeQuietly();
                rmrf(dir);
            }
        }
    } finally {
        if (previous === undefined) delete process.env.BILI_STORAGE_UNIFIED;
        else process.env.BILI_STORAGE_UNIFIED = previous;
    }
});

test("handoff ignores malformed reply metadata and exports a reply without a request snapshot", () => {
    const s = makeSession("reply-only", "Reply only", undefined);
    s.metadata.handoffResponse = { request: s.stats.requests, messages: [{ id: "reply", role: "assistant", contentType: "text", text: "latest answer" }] };
    assert.match(renderHandoff(s, false), /latest answer/);
    for (const messages of [[null], [{ role: "assistant", contentType: "text", text: {} }]]) {
        s.metadata.handoffResponse = { request: s.stats.requests, messages };
        assert.doesNotThrow(() => renderHandoff(s, false));
        assert.doesNotMatch(renderHandoff(s, false), /latest answer|### assistant/);
    }
});

test("parseArgs recognizes bili export forms", () => {
    const a = parseArgs(["export"]);
    assert.equal(a.command, "export");
    assert.equal(a.exportSelector, undefined);
    const b = parseArgs(["export", "abc123", "--full"]);
    assert.equal(b.command, "export");
    assert.equal(b.exportSelector, "abc123");
    assert.equal(b.exportFull, true);
    const c = parseArgs(["export", "--output", "/tmp/h.md", "abc"]);
    assert.equal(c.command, "export");
    assert.equal(c.exportSelector, "abc");
    assert.equal(c.exportOutput, "/tmp/h.md");
    const d = parseArgs(["--port", "9000"]);
    assert.equal(d.command, "start");
    const e = parseArgs(["export", "abc123", "--jsonl"]);
    assert.equal(e.command, "export");
    assert.equal(e.exportSelector, "abc123");
    assert.equal(e.exportJsonl, true);
    assert.equal(e.exportFull, false);
});
