import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, defaultCountTokens, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated filler output is disposable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

// #987 regression: on a small (often overflow-learned) window the summary call
// must not ask for more output than the window headroom allows — upstreams
// that enforce input+output <= window answer with an EMPTY completion instead
// of an error (observed: muse-spark behind a 9router alias, learned window
// 16898), which made every summary attempt unusable and dead-ended preflight.
// The cap must hold on EVERY summary call: input(system+chunk) + max_tokens <= window.
test("#987 summary max_tokens clamped to window headroom on small windows", async () => {
    const window = 8000;
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const body = JSON.parse(raw);
            bodies.push(body);
            assert.equal(body.stream, false, "fixture relies on the non-stream summary path");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };

    try {
        const session = getSession(`window-clamp-${randomUUID()}`);
        // ~10.5k tokens of filler over the 8k window forces the preflight walk;
        // each chunk is <= 0.6 x window tokens, so input+output genuinely can
        // exceed the window unless clamped.
        const messages: CoreMessage[] = [
            { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
            { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(6000) },
            { id: "last", role: "user", contentType: "text", text: "Continue the task." },
        ];
        const deps: PreflightDeps = {
            core: createCore(), session,
            config: defaultConfig(window, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
            prompts: defaultPrompts, protocol: "openai",
            url: `http://127.0.0.1:${port}/v1/messages`,
            headers: {}, model: "subagent",
            log: () => {},
        };
        await preflightCompress(deps, messages);
        assert.ok(bodies.length >= 1, "at least one summary call");
        let sawClamp = false;
        for (const b of bodies) {
            const msgs = b.messages as { role: string; content: string }[];
            const sysTok = defaultCountTokens(msgs[0].content);
            const cntTok = defaultCountTokens(msgs[1].content);
            const mt = b.max_tokens as number;
            assert.ok(mt >= 64, `clamped output stays above the minimum floor, got ${mt}`);
            assert.ok(mt + sysTok + cntTok <= window, `input+output must fit the window (${mt} + ${sysTok} + ${cntTok} > ${window})`);
            if (mt < 32768) sawClamp = true;
        }
        assert.ok(sawClamp, "the clamp must actually engage on this window (some call below the 32k default)");
    } finally {
        server.close();
        await once(server, "close");
    }
});

// Control: with a large window the headroom exceeds the 32k default cap, so
// the #853 behavior is untouched — no over-clamping on normal models.
test("#987 summary max_tokens keeps the 32k default when headroom is ample", async () => {
    const window = 100_000;
    const bodies: Record<string, unknown>[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            bodies.push(JSON.parse(raw));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };

    try {
        const session = getSession(`window-clamp-large-${randomUUID()}`);
        const messages: CoreMessage[] = [
            { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
            { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(60000) },
            { id: "last", role: "user", contentType: "text", text: "Continue the task." },
        ];
        const deps: PreflightDeps = {
            core: createCore(), session,
            config: defaultConfig(window, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
            prompts: defaultPrompts, protocol: "openai",
            url: `http://127.0.0.1:${port}/v1/messages`,
            headers: {}, model: "big-model",
            log: () => {},
        };
        await preflightCompress(deps, messages);
        assert.ok(bodies.length >= 1, "at least one summary call");
        for (const b of bodies) {
            assert.equal(b.max_tokens, 32768, "ample headroom keeps the full default cap");
        }
    } finally {
        server.close();
        await once(server, "close");
    }
});
