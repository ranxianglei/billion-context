// dsh fork dead-zone repro: a mid-history fork child starts with a fresh
// stats block — no usage-grade baseline, no localInputEstimate — so the
// nudge's sizing feed (effectiveTokenCount) hands the kernel tokenCount 0 on
// the child's first turn. decideNudge is structurally unfireable at 0 (usage
// 0%, growth ref 0): the inherited context can sit at 100%+ of the new
// model's window and NO compression trigger fires, so every request falls
// straight into the preflight summarization marathon (field repro: fork at
// branch point 93, 671 msgs, usage=0% (0/936000), pendingT1 929710/1500000
// idle, 19-round preflight per request, #568 hold). The fork receipt already
// estimates the child's exact next outbound view (stats.contextTokens); this
// file pins that the receipt ALSO seeds the #728 sizing fallback
// (stats.localInputEstimate) so the nudge sees the inherited mass from the
// very first turn — while billing-grade isolation (no inherited usage
// baseline) stays intact. Fork-of-fork (grandchild receipt) must get the
// same seed. #728/#2399 lineage.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { estimateCoreMessagesUpper } from "../src/preflight.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { contentStoreOf } from "../src/store.ts";
import { effectiveTokenCount } from "../src/server.ts";

process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-fork-nudge-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const SMALL_WINDOW = 30_000;

// ~100KB of ASCII filler across the seeded history. For the unit tests the
// exact size does not matter (any mass >= 75% of the small window fires the
// OVER-LIMIT band); the lane proof calibrates `repeats` so the child's
// payload lands INSIDE the band but UNDER the preflight trigger (the window
// itself), isolating the nudge decision from the preflight path.
const filler = (tag: string, repeats = 2_600) => `${tag} `.repeat(repeats);

/** Calibrate the filler repeat count so the child's inbound (prefix + short
 *  tail) and the receipt estimate (prefix alone) both sit in the OVER-LIMIT
 *  band [80%, 98%] of the small window — above maxContextLimitPct (75%) and
 *  safely below the window (preflight trigger). */
function calibrateRepeats(window: number): number {
    const tag = "first original grain ledger line for the fork prefix";
    for (let repeats = 40; repeats <= 4_000; repeats += 10) {
        const msgs = [
            { id: "a", role: "user" as const, contentType: "text" as const, text: filler(tag, repeats) },
            { id: "b", role: "assistant" as const, contentType: "text" as const, text: filler("second original grain ledger line for the fork prefix", repeats) },
            { id: "c", role: "user" as const, contentType: "text" as const, text: filler("third original grain ledger line for the fork prefix", repeats) },
            { id: "d", role: "assistant" as const, contentType: "text" as const, text: filler("fourth original grain ledger line for the fork prefix", repeats) },
        ];
        const inbound = [...msgs, { id: "e", role: "user" as const, contentType: "text" as const, text: "short follow-up on the small-window model" }];
        const est = estimateCoreMessagesUpper(msgs);
        const raw = estimateCoreMessagesUpper(inbound);
        if (est >= window * 0.8 && est <= window * 0.98 && raw >= window * 0.8 && raw <= window * 0.98) return repeats;
    }
    throw new Error(`no repeat count lands the payload in [80%, 98%] of the ${window}-token window`);
}

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    _setForTest({});
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 }, "small-test": { context: SMALL_WINDOW } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: true, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() as Record<string, unknown> };
    };
    const seedParent = async () => {
        const messages = [
            { role: "user", content: filler("first original grain ledger line for the fork prefix") },
            { role: "assistant", content: filler("second original grain ledger line for the fork prefix") },
            { role: "user", content: filler("third original grain ledger line for the fork prefix") },
            { role: "assistant", content: filler("fourth original grain ledger line for the fork prefix") },
            { role: "user", content: "tail original" },
        ];
        const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "parent" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r.status, 200);
        await r.text();
    };
    const forkAt = async (parent: string, child: string, count?: number) => {
        const snapshot = await request(`/__bili/plugin/snapshot?conversationId=${parent}`);
        assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
        const ordered = snapshot.body.orderedMessages as { rawId: string; ref: string; identityHash: string }[];
        const messageCount = count ?? Math.max(1, ordered.length - 1);
        assert.ok(messageCount < ordered.length, "fork must cut mid-history (not full prefix) to hit the dead-zone path");
        const prefix = ordered.slice(0, messageCount);
        return request("/__bili/plugin/fork", { protocolVersion: 1, parentConversationId: parent, childConversationId: child, parentRevision: snapshot.body.parentRevision as string, branchPoint: { messageCount, orderHash: hash(prefix) }, orderedMessages: prefix, idempotencyKey: `fork-${child}` });
    };
    return { request, seedParent, forkAt, dir, upstreamUrl, origin, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("mid-history fork seeds the nudge sizing baseline (dsh fork dead-zone repro)", async () => {
    const h = await harness();
    try {
        await h.seedParent();
        const fork = await h.forkAt("parent", "child");
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const child = resolveConversation("child").session!;

        // The receipt must seed the #728 fallback with the inherited view's
        // estimate — pre-fix this is undefined and the nudge feeds 0.
        assert.ok(child.stats.contextTokens > 0, "receipt estimates the child view");
        assert.equal(child.stats.localInputEstimate, child.stats.contextTokens, "receipt seeds localInputEstimate with the child view estimate");

        // Billing-grade isolation is untouched: no inherited usage baseline
        // masquerading as measured input.
        assert.equal(child.stats.lastInputTokens, 0);
        assert.notEqual(child.stats.lastInputTokensSource, "usage");

        // The sizing feed must see the inherited mass (pre-fix: 0).
        const eff = effectiveTokenCount(child, child.pluginSnapshot!);
        assert.ok(eff.tokens > 0, `effectiveTokenCount must not feed 0 (got ${eff.tokens})`);
        assert.equal(eff.source, "estimate");
        assert.ok(eff.tokens >= SMALL_WINDOW * 0.75, `seeded estimate must reach the OVER-LIMIT band (got ${eff.tokens} vs window ${SMALL_WINDOW})`);

        // With the seeded sizing, the kernel's nudge FIRES on the child's
        // first decision instead of going dark. Mirror the harness compress
        // relaxation (the kernel defaults protect the last 5 messages — the
        // whole 4-message prefix here — which would legitimately zero the
        // compressible mass and suppress the nudge for a different reason).
        const core = createCore();
        const base = defaultConfig(SMALL_WINDOW);
        const turn = core.processTurn({ messages: child.pluginSnapshot!, state: child.state, config: { ...base, preserveRecentMessages: 1, preserveRecentTokens: 0 }, tokenCount: eff.tokens, renderTags: "none", contentStore: contentStoreOf(child) });
        assert.equal(turn.nudge?.shouldInject, true, `nudge must fire at ${Math.round((eff.tokens / SMALL_WINDOW) * 100)}% usage (reason: ${turn.nudge?.reason})`);
        assert.match(turn.nudge?.reason ?? "", /OVER-LIMIT|EMERGENCY/);
    } finally { await h.close(); }
});

test("fork-of-fork: the grandchild receipt seeds the sizing baseline too", async () => {
    const h = await harness();
    try {
        await h.seedParent();
        assert.equal((await h.forkAt("parent", "child")).status, 201);
        assert.equal((await h.forkAt("child", "grandchild")).status, 201, JSON.stringify((await h.forkAt("child", "grandchild")).body));
        const grand = resolveConversation("grandchild").session!;
        assert.ok(grand.stats.contextTokens > 0);
        assert.equal(grand.stats.localInputEstimate, grand.stats.contextTokens);
        const eff = effectiveTokenCount(grand, grand.pluginSnapshot!);
        assert.ok(eff.tokens > 0, `grandchild sizing must not feed 0 (got ${eff.tokens})`);
        assert.equal(grand.stats.lastInputTokens, 0);
    } finally { await h.close(); }
});

test("the child's first wire turn sizes on the seeded baseline, not 0 (lane proof)", async (t) => {
    const h = await harness();
    try {
        const repeats = calibrateRepeats(SMALL_WINDOW);
        const seedMsgs = [
            { role: "user", content: filler("first original grain ledger line for the fork prefix", repeats) },
            { role: "assistant", content: filler("second original grain ledger line for the fork prefix", repeats) },
            { role: "user", content: filler("third original grain ledger line for the fork prefix", repeats) },
            { role: "assistant", content: filler("fourth original grain ledger line for the fork prefix", repeats) },
            { role: "user", content: "tail original" },
        ];
        const r0 = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "parent" }, body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: false, messages: seedMsgs }) });
        assert.equal(r0.status, 200);
        await r0.text();
        const snapshot = await h.request(`/__bili/plugin/snapshot?conversationId=parent`);
        const ordered = snapshot.body.orderedMessages as { rawId: string; ref: string; identityHash: string }[];
        const prefix = ordered.slice(0, 4);
        const fork = await h.request("/__bili/plugin/fork", { protocolVersion: 1, parentConversationId: "parent", childConversationId: "child", parentRevision: snapshot.body.parentRevision as string, branchPoint: { messageCount: 4, orderHash: hash(prefix) }, orderedMessages: prefix, idempotencyKey: "fork-child-lane" });
        assert.equal(fork.status, 201, JSON.stringify(fork.body));
        const child = resolveConversation("child").session!;
        // Model switch onto the small window — the reporter's exact move.
        const messages = [
            ...seedMsgs.slice(0, 4),
            { role: "user", content: "short follow-up on the small-window model" },
        ];
        const r = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "test", "x-bili-plugin-conversation": "child" }, body: JSON.stringify({ model: "small-test", max_tokens: 1024, stream: false, messages }) });
        assert.equal(r.status, 200);
        await r.text();
        // The logger's file leg is an async append stream (src/logger.ts) —
        // under a loaded runner the HTTP response can return before the nudge
        // line has flushed to disk, so a one-shot readFileSync raced the flush
        // and false-red'd on Windows CI (#3147-A). Poll with a bounded
        // deadline instead; the stream preserves write order, so once the
        // nudge line is visible every earlier line of the same request (incl.
        // any preflight warn) is visible too — the negative assertion below
        // stays sound without a separate quiesce wait.
        const logPath = join(h.dir, "billion-context", "bili.log");
        const readLog = (): string => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } };
        const deadline = Date.now() + 5_000;
        let nudgeLine: string | undefined;
        for (;;) {
            // #4205: the [headroom] line also says "nudge" (it names the
            // judge layer) and precedes the decision line on reserving routes —
            // exclude it or the filter grabs the wrong line.
            nudgeLine = readLog().split("\n").filter((l) => l.includes(child.id)).find((l) => l.includes("nudge") && !l.includes("[headroom]"));
            if (nudgeLine || Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(nudgeLine, "child turn must log its nudge decision (waited up to 5s for the async log stream)");
        assert.doesNotMatch(nudgeLine, /usage=0% \(0\//, `dead-zone signature (usage 0% on 0 tokens) must be gone: ${nudgeLine}`);
        assert.match(nudgeLine, /(?:idle|ACTIVE)[^\n]*usage=[1-9]\d*%/);
        const childLines = readLog().split("\n").filter((l) => l.includes(child.id));
        assert.doesNotMatch(childLines.join("\n"), /preflight compressing before forward/, "the in-band payload must not fall into the preflight path");
        t.diagnostic(`lane nudge line: ${nudgeLine?.trim()}`);
    } finally { await h.close(); }
});
