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
import { ensureUserTail, TRAILING_ASSISTANT_NUDGE } from "../src/server/prepare-anthropic.ts";

// #5604 (second mechanism): a preflight overflow fold can take the trailing
// tool pair (here a `Read` listed in neverPreserveRecentTools, the same shape
// the soft-protection relax to 0 produces) and leave the outbound array
// ending on the previous assistant turn. Anthropic and Bedrock reject that as
// assistant prefill ("This model does not support assistant message prefill"
// / "final assistant content cannot end with trailing whitespace").

const WINDOW = 24_000;
const SUMMARY_TEXT = "PREFLIGHT SUMMARY: earlier file reads covered the module layout and the failing test.";

function okSse(): string {
    const ev = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return (
        ev("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } }) +
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
        ev("message_stop", { type: "message_stop" })
    );
}

const filler = (seed: string, chars: number): string => {
    const unit = `${seed}: the module under review exposes a small service with two adapters and one repository. `;
    return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
};

type Msg = { role: string; content: unknown };

function readSession(sizes: number[]): Msg[] {
    const msgs: Msg[] = [{ role: "user", content: "Fix the failing build in this repository." }];
    for (let i = 0; i < sizes.length; i++) {
        msgs.push({ role: "assistant", content: [
            { type: "text", text: `Reading file ${i}.` },
            { type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `/repo/src/File${i}.java` } },
        ] });
        msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: filler(`file ${i}`, sizes[i]!) }] });
    }
    return msgs;
}

const lastNonSystemRole = (messages: Msg[]): string | undefined => messages.findLast((m) => m.role !== "system")?.role;

test("#5604 e2e: preflight fold of the trailing Read pair never sends an outbound body that ends on an assistant turn", async () => {
    const forwards: Array<{ messages: Msg[] }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; messages: Msg[] };
            if (parsed.stream) {
                forwards.push({ messages: parsed.messages });
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_summary", type: "message", role: "assistant", model: "claude-small", content: [{ type: "text", text: SUMMARY_TEXT }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 50 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: { ...defaultConfig(WINDOW), neverPreserveRecentTools: ["Read"] },
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const messages = readSession([2_000, 2_000, 120_000]);
        assert.equal(lastNonSystemRole(messages), "user", "fixture: the client body ends on a user tool_result");
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s5604-read-tail" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages }),
        });
        const text = await res.text();
        assert.equal(res.status, 200, text.slice(0, 400));
        const forward = forwards.at(-1);
        assert.ok(forward, "the request was forwarded upstream");
        assert.ok(JSON.stringify(forward.messages).includes(SUMMARY_TEXT), "a preflight fold rode the forwarded body");
        assert.equal(lastNonSystemRole(forward.messages), "user", `outbound tail: ${JSON.stringify(forward.messages.slice(-2)).slice(0, 400)}`);
        assert.deepEqual(forward.messages.at(-1), { role: "user", content: TRAILING_ASSISTANT_NUDGE }, "the tail is closed by the single thin nudge");
        assert.equal(forward.messages.at(-2)?.role, "assistant", "everything before the nudge is the folded body as rebuilt");

        const next = [...messages, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "Continue." }];
        const res2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s5604-read-tail" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: next }),
        });
        assert.equal(res2.status, 200, (await res2.text()).slice(0, 400));
        const forward2 = forwards.at(-1)!;
        assert.notEqual(forward2, forward, "the second turn was forwarded");
        const folded = forward.messages.slice(0, -1);
        assert.deepEqual(forward2.messages.slice(0, folded.length - 1), folded.slice(0, -1), "the next turn re-sends the same prefix: the nudge never entered cache-stable content");
        const lastAssistant = folded.at(-1)!.content as unknown[];
        assert.deepEqual((forward2.messages[folded.length - 1]!.content as unknown[]).slice(0, lastAssistant.length), lastAssistant, "the surviving assistant turn is re-sent unchanged, the client reply only extends it");
        assert.ok(!JSON.stringify(forward2.messages).includes(TRAILING_ASSISTANT_NUDGE), "the nudge is ephemeral and not replayed once the tail is a real user turn");
    } finally {
        proxy.close();
        upstream.close();
    }
});

const sys = (text: string): Msg => ({ role: "system", content: text });
const USER_TAIL = [{ role: "user", content: "q" }] as never[];

test("#5604 ensureUserTail: assistant tail gets one nudge appended, prefix untouched", () => {
    const base = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a ", cache_control: { type: "ephemeral" } }] }] as never[];
    const out = ensureUserTail(base, USER_TAIL);
    assert.equal(out.length, base.length + 1);
    base.forEach((m, i) => assert.equal(out[i], m, `message ${i} is the same object`));
    assert.deepEqual(out.at(-1), { role: "user", content: TRAILING_ASSISTANT_NUDGE });
});

test("#5604 ensureUserTail: nudge goes before the trailing system run, after all cache-stable content", () => {
    const base = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, sys("s1"), sys("s2")] as never[];
    const out = ensureUserTail(base, USER_TAIL) as Msg[];
    assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "system", "system"]);
    assert.equal(out[0], base[0]);
    assert.equal(out[1], base[1]);
    assert.equal(out[2]!.content, TRAILING_ASSISTANT_NUDGE);
    assert.deepEqual(out.slice(3), [sys("s1"), sys("s2")]);
});

test("#5604 ensureUserTail: user tail returns the same array (no change, no prefix churn)", () => {
    const plain = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "next" }] as never[];
    assert.equal(ensureUserTail(plain, plain), plain);
    const withSystemTail = [...plain, sys("s")] as never[];
    assert.equal(ensureUserTail(withSystemTail, withSystemTail), withSystemTail);
    const allSystem = [sys("only")] as never[];
    assert.equal(ensureUserTail(allSystem, allSystem), allSystem);
});

test("#5604 ensureUserTail: a client-authored assistant tail (deliberate prefill) passes through unchanged", () => {
    const prefill = [{ role: "user", content: "q" }, { role: "assistant", content: "Answer:" }] as never[];
    assert.equal(ensureUserTail(prefill, prefill), prefill);
});
