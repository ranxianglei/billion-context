import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { inspectContextOverflow } from "../src/util.ts";
import { setLogCapture, muteStderrLeg } from "../src/logger.ts";
import { armJudgingWallLogged } from "../src/server.ts";

// #5191: a 900K-token dsh session was rejected on every turn with two
// contradicting windows in the log —
//
//   [headroom] ... nudge/preflight judge input against 1092500
//   (preflight rejects the payload at 792576)
//
// The 792,576 was CORRECT: the upstream had stated, in a 400 body, that it
// bills the completion against the same wall ("841304 in the messages,
// 256000 in the completion" against a 1,048,576 window), so preflight judges
// on min(headroom, statedWall - completionReserve) (#3450). The [headroom]
// line only knows the config-side reservation and, when the arm lands below
// it, silently announces a window nothing judges against. The reporter spent
// the whole appendix chasing config that was never read.
//
// The fix: when the session overflow arm clamps the judging wall BELOW the
// [headroom] window, preflight says so itself — one [arm-judge] line per
// session|model|value naming both numbers — and [headroom] points at it.

const ROUTE_WINDOW = 1_150_000; // config-declared window (#5191's real setting)
const STATED_WINDOW = 1_048_576; // what the upstream's 400 states
const COMPLETION_BILLED = 256_000; // "... 256000 in the completion)"
const ARM_WALL = STATED_WINDOW - COMPLETION_BILLED; // 792,576
const MAX_TOKENS = 64_000; // small output budget → headroom window 1,086,000
const HEADROOM_WINDOW = ROUTE_WINDOW - MAX_TOKENS; // 1,086,000

const REJECT_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1097304 tokens (841304 in the messages, 256000 in the completion). Please reduce the length of the messages or completion.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
    },
});

type Captured = { level: string; msg: string };

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(REJECT_BODY);
    });
}

function proxyOptions(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: ROUTE_WINDOW } } },
        } as ProxyOptions["routes"],
        modelContextLimit: ROUTE_WINDOW,
        kernelConfig: defaultConfig(ROUTE_WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

async function setup(): Promise<{ url: string; close: () => Promise<void> }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    // opts.log must be ON for logMsg to reach the logger (and thus the
    // capture hook); mute the stderr leg so the traffic under test stays
    // out of this file's test-runner output.
    muteStderrLeg();
    const upstream = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOptions(upstreamPort));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/chat/completions`,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            upstream.close();
            upstream.closeIdleConnections?.();
            await Promise.allSettled([once(proxy, "close"), once(upstream, "close")]);
        },
    };
}

const post = (url: string, session: string) =>
    fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({
            model: "gpt-test",
            stream: true,
            max_tokens: MAX_TOKENS,
            messages: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "hi" },
                { role: "user", content: "continue" },
            ],
        }),
    });

const armJudgeLines = (captured: Captured[]): Captured[] =>
    captured.filter((e) => e.level === "info" && e.msg.startsWith("[arm-judge]"));

test("the overflow arm's judging wall logs below [headroom] instead of contradicting it (#5191)", async (t) => {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    armJudgingWallLogged.clear();
    t.after(() => setLogCapture(null));

    // The 400 body really parses as #3450 completion-share proof.
    const info = inspectContextOverflow(400, REJECT_BODY);
    assert.equal(info.isOverflow, true);
    assert.equal(info.window, STATED_WINDOW);

    const { url, close } = await setup();
    try {
        // Turn 1: no arm yet — the 400 arms the session (wall + completion share).
        await post(url, "arm-judge-5191");
        const s = getSession("arm-judge-5191");
        assert.ok(s, "session exists after the upstream 400");
        assert.equal(s.stats.overflowArmTokens, STATED_WINDOW, "arm wall is the upstream-stated window");
        assert.equal(
            s.stats.overflowArmCompletionReserve,
            COMPLETION_BILLED,
            "completion share parsed from the rejection body",
        );
        // [headroom] announced the config-side reservation...
        const headroom = captured.find((e) => e.level === "info" && e.msg.includes("[headroom]"));
        assert.ok(headroom, "[headroom] line present");
        assert.match(headroom.msg, new RegExp(`judge input against ${HEADROOM_WINDOW}`));
        // ...and, since the fix, no longer claims to be the only judge.
        assert.match(headroom.msg, /\[arm-judge\]/, "[headroom] points at the arm override");
        // Turn 1's post-400 recovery pass arms mid-turn: the arm wall (792,576)
        // is already below the announced window (1,086,000) on THIS request's
        // retry — the #5191 story, now self-explaining in the log.
        let lines = armJudgeLines(captured);
        assert.equal(lines.length, 1, "the mid-turn arm on the very first request logs");
        assert.match(lines[0].msg, new RegExp(`judge input against ${ARM_WALL}`));
        assert.match(lines[0].msg, new RegExp(`BELOW the \\[headroom\\] window ${HEADROOM_WINDOW}`));
        assert.match(lines[0].msg, new RegExp(`${COMPLETION_BILLED} billed to completion`));

        // Turn 2: the #3450 provider-lifetime proof clamps [headroom] itself
        // (1,086,000 → 894,000) — a NEW announcement, so the arm note fires
        // again against the new number.
        await post(url, "arm-judge-5191");
        lines = armJudgeLines(captured);
        assert.equal(lines.length, 2, "the proven-clamped headroom gets its own arm note");
        assert.match(lines[1].msg, new RegExp(`judge input against ${ARM_WALL}`));
        assert.match(lines[1].msg, /BELOW the \[headroom\] window 894000/);

        // Turn 3: same numbers — the line must not repeat.
        await post(url, "arm-judge-5191");
        assert.equal(armJudgeLines(captured).length, 2, "[arm-judge] is once per value pair");

        // A different session arms separately and gets its own lines.
        await post(url, "arm-judge-5191-b");
        await post(url, "arm-judge-5191-b");
        assert.equal(armJudgeLines(captured).length, 4, "per-session dedup, not global silence");
    } finally {
        await close();
    }
});
