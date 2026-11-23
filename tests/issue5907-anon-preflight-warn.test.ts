import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";

process.env.NODE_ENV = "test";

import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { type ProxyOptions } from "../src/config.js";
import { preflightCompressIfNeeded, type Prepared } from "../src/server.js";
import { getSession } from "../src/session.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.js";

// #5907 facet 3: a request that reaches bili WITHOUT any conversation identity
// (no session header, no x-bili-plugin-conversation) is resolved by prefix
// affinity into a pfa-* ANONYMOUS chain whose window comes from the static
// ladder (table / registry / configured / default) — never a host report. When
// such a chain then hits the zero-progress fits-forward branch, the forward can
// die upstream (400 / stream silence) ~20s later with nothing in bili.log
// naming the class; the reporter could only find it by aligning an external
// probe with the log timeline. The fix appends an unattributed-chain note to
// that ONE existing warn when the anonymous flag is set; identified sessions
// keep the original wording verbatim (both directions pinned here, #3617).
//
// Fixture shape mirrors the proven #4288 precondition: a usage baseline
// measured under a PRIOR wider window (300k) trips the trigger on its own
// while the actual payload (~4k tokens) FITS the 40k window, so preflight
// exits at the round boundary with ZERO folds and forward-once applies.

_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0);
    _resetFetchUtilForTest();
});

const WINDOW = 40_000;
const STALE_BASELINE = 300_000;

async function withUpstream(run: (url: string) => Promise<void>) {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output: [] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}/responses`);
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeIdleConnections?.();
        server.closeAllConnections();
        await closed;
    }
}

function fixture(url: string) {
    const session = getSession(`anon-warn-${randomUUID()}`);
    // The #4288 precondition, set explicitly: the trigger fires off the stale
    // high baseline alone; the payload itself fits (see WINDOW above).
    session.stats.lastInputTokens = STALE_BASELINE;
    session.stats.lastInputTokensSource = "usage";
    const core = createCore();
    const config = defaultConfig(WINDOW, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(2000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    // The stale baseline must also drive the kernel's nudge view: without a
    // non-empty compressibleRanges list preflightCompressIfNeeded early-returns
    // on the OTHER fits branch ("no compressible ranges") before ever reaching
    // the zero-progress warn under test.
    const turn = core.processTurn({ messages, state: session.state, config, tokenCount: STALE_BASELINE, renderTags: "text-only" });
    assert.ok(turn.nudge && turn.nudge.compressibleRanges.length > 0, "kernel must see foldable ranges under the stale baseline");
    const prepared: Prepared = {
        body: JSON.stringify({ model: "test-model", stream: true, input: turn.messages.map(m => ({ role: m.role, content: m.text })) }),
        session, processedMessages: turn.messages, originalMessages: messages,
        protocol: "responses", stream: true, compressInjected: false, nudge: turn.nudge,
    };
    const req = new http.IncomingMessage(new net.Socket());
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json" };
    const res = new http.ServerResponse(req);
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: url, routes: {},
        proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: WINDOW, kernelConfig: config,
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, compat: { roles: {} },
        streamErrorShape: "protocol", sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] },
    };
    const logs: string[] = [];
    const log = (_level: string, message: string) => { logs.push(message); };
    return { session, core, config, messages, prepared, req, res, opts, log, logs };
}

type Fixture = ReturnType<typeof fixture>;

function rebuild(f: Fixture): Prepared {
    const turn = f.core.processTurn({ messages: f.messages, state: f.session.state, config: f.config,
        tokenCount: f.session.stats.lastInputTokens, renderTags: "text-only" });
    f.session.stats.requests++;
    return { ...f.prepared, processedMessages: turn.messages,
        body: JSON.stringify({ model: "test-model", stream: true, input: turn.messages.map(m => ({ role: m.role, content: m.text })) }),
    };
}

function gate(f: Fixture, anonymous: boolean) {
    return preflightCompressIfNeeded(f.prepared, async () => rebuild(f), f.req, Buffer.from(f.prepared.body), f.res,
        f.opts, f.core, f.config, f.config.modelContextLimit, "test-model", undefined, undefined, undefined, undefined, anonymous, f.log, "anon-warn-test");
}

test("identified session: zero-progress fits-forward keeps the original warn wording", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const outcome = await gate(f, false);
        assert.equal((outcome as { failFast?: boolean }).failFast, undefined, "zero-progress fits forwards, never fail-fasts");
        const warn = f.logs.find(l => l.includes("preflight made no progress but the payload fits"));
        assert.ok(warn, `expected the zero-progress fits warn, got: ${JSON.stringify(f.logs)}`);
        assert.ok(!warn!.includes("unattributed chain"), "identified sessions keep the original wording verbatim");
    });
});

test("anonymous chain: the same warn names the unattributed class and the remedy (#5907)", async () => {
    await withUpstream(async url => {
        const f = fixture(url);
        const outcome = await gate(f, true);
        assert.equal((outcome as { failFast?: boolean }).failFast, undefined, "zero-progress fits forwards, never fail-fasts");
        const warn = f.logs.find(l => l.includes("preflight made no progress but the payload fits"));
        assert.ok(warn, `expected the zero-progress fits warn, got: ${JSON.stringify(f.logs)}`);
        assert.match(warn!, /unattributed chain \(no conversation identity in this request's headers\)/);
        assert.match(warn!, /static ladder/);
        assert.match(warn!, /identity headers/);
        assert.match(warn!, /#5907/);
    });
});
