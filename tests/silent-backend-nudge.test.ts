import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

// #728: upstreams that NEVER report usage (ChatGPT-login backends — their
// response.completed carries no usage.input_tokens) leave lastInputTokens == 0
// for the whole session, and the kernel's decideNudge is structurally
// unfireable at tokenCount == 0 (growth reference falls back to tokenCount
// itself → growth ≡ 0; mass-ready and pressure bands all require usage at or
// above their pct lines). Context then grows unbounded until the hard limit —
// incident #726 sat at ~1.32M tokens before preflight finally kicked in. Fix
// (host-side, refined option 1 from the issue triage): prepare* records the
// PREVIOUS turn's LOCAL outbound payload upper bound
// (session.stats.localInputEstimate) each turn, and effectiveTokenCount feeds
// IT — capped by this request's inbound upper bound — only while
// lastInputTokens == 0. Real usage always takes precedence (the estimator only
// errs early, mirroring #604's armFailureShrink exception); the value
// self-corrects after every fold because the post-fold outbound payload
// shrinks. These e2e pins (explicit identity, Anthropic wire):
//   A. silent backend, multi-turn growth → turn 1 idle (nothing measured yet,
//      byte-identical to pre-fix first-turn behavior), turn 2 NUDGES once the
//      recorded estimate crosses the kernel thresholds; preflight stays silent
//      (optimistic estimate under the window).
//   B. same conversation but upstream reports real usage every turn → NO
//      nudge anywhere (real usage always beats the local estimate).
//   C. stale-high cap: after A's nudged turn 2, turn 3 sends a SHRUNKEN
//      history → no nudge (the previous turn's high estimate must not outlive
//      the content it was measured from).
// The anonymous-prefix-affinity regression lives in fork-nudge-trigger.test.ts
// (untouched branch — that regime keeps feeding the raw inbound upper bound).

const NUDGE_MARKER = "Context limit reached";
const WINDOW = 60_000;

const sseLine = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// message_start/message_delta omit `usage` entirely when inputTokens is null —
// the ChatGPT-login wire shape (field absent, not zero).
function okSse(inputTokens: number | null): string {
    const startMsg = inputTokens == null
        ? { type: "message_start", message: { id: "m1", role: "assistant" } }
        : { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } };
    const deltaObj = inputTokens == null
        ? { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } }
        : { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } };
    return (
        sseLine("message_start", startMsg) +
        sseLine("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sseLine("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sseLine("content_block_stop", { type: "content_block_stop", index: 0 }) +
        sseLine("message_delta", deltaObj) +
        sseLine("message_stop", { type: "message_stop" })
    );
}

function msgText(m: { content?: unknown }): string {
    const c = m.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c
        .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
        .join("");
}

function msgsOf(raw: string): Array<{ role?: string; content?: unknown }> {
    try {
        const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
        return parsed.messages ?? [];
    } catch {
        return [];
    }
}

// Same shape as fork-nudge-trigger.test.ts: 7 OLD code-heavy messages (~5.5k
// chars each) + 5 tiny recent ones. Char-count upper bound ≈ 54k/60k ≈ 90% of
// the window (over-limit for decideNudge), optimistic chars/4 estimate well
// under it (preflight stays silent).
const LINE = (i: number) =>
    `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
const HEAVY = (i: number) => `CODE_${i}_` + LINE(i).repeat(62);

function baseConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: i < 7 ? HEAVY(i) : `CODE_${i}_tiny note ${i}` });
    }
    return msgs;
}

async function runCase(opts: { inputTokens: number | null }): Promise<Record<string, unknown>> {
    const streamed: string[] = [];
    let nonStream = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch { /* keep {} */ }
            if (parsed.stream) {
                streamed.push(raw);
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(opts.inputTokens));
            } else {
                nonStream++;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-small",
                    content: [{ type: "text", text: "SUMMARY TEXT" }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: WINDOW } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const post = async (messages: Array<{ role: string; content: string }>): Promise<number> => {
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "silent-backend-sess" },
                body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages }),
            });
            await resp.text();
            return resp.status;
        };

        // Multi-turn: the client re-sends its FULL growing history every turn
        // (the proxy-mode wire contract). Turn 1 = base conversation; turn 2
        // adds an assistant reply + one heavy follow-up user message (~same
        // scale); turn 3 SHRINKS to the recent small tail (a client-side
        // compaction/edit — the stale-estimate regime).
        const base = baseConversation();
        const statuses: number[] = [];
        statuses.push(await post(base));
        statuses.push(await post([
            ...base,
            { role: "assistant", content: "ok, done with step one." },
            { role: "user", content: HEAVY(99) + " now step two" },
        ]));
        statuses.push(await post([
            { role: "user", content: "short recent slice one" },
            { role: "assistant", content: "ok fine" },
            { role: "user", content: "tiny question only" },
        ]));
        return { statuses, streamed, nonStream };
    } finally {
        proxy.close();
        upstream.close();
    }
}

test("#728A: silent-backend explicit session — turn 1 idle, turn 2 nudge via local estimate, preflight silent", async () => {
    const { statuses, streamed, nonStream } = await runCase({ inputTokens: null });
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal(nonStream, 0, "preflight must stay silent (optimistic estimate under window)");
    assert.equal(streamed.length, 3);
    assert.ok(!streamed[0].includes(NUDGE_MARKER), "turn 1 must stay idle — nothing measured yet (pre-fix first-turn behavior)");
    const fwd = msgsOf(streamed[1]);
    const last = fwd.at(-1)!;
    assert.ok(
        last.role === "user" && msgText(last).includes(NUDGE_MARKER),
        `turn 2 must carry the trailing nudge once the recorded local estimate crosses the threshold, got: ${streamed[1].slice(-800)}`,
    );
    for (let i = 0; i < 12; i++) {
        assert.ok(streamed[1].includes(`CODE_${i}_`), `CODE_${i}_ must survive un-folded (nudge is advisory, no fold happened)`);
    }
});

test("#728B: real usage always takes precedence — reported input_tokens beats the local estimate", async () => {
    const { statuses, streamed } = await runCase({ inputTokens: 2000 });
    assert.deepEqual(statuses, [200, 200, 200]);
    for (let i = 0; i < streamed.length; i++) {
        assert.ok(!streamed[i].includes(NUDGE_MARKER), `turn ${i + 1}: reported usage (2000 << ${WINDOW}) must drive tokenCount, not the ~90% payload estimate`);
    }
});

test("#728C: stale-high cap — shrunk history does not re-trigger on the previous turn's estimate", async () => {
    const { statuses, streamed } = await runCase({ inputTokens: null });
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.ok(streamed[1].includes(NUDGE_MARKER), "precondition: turn 2 nudged (see #728A)");
    assert.ok(!streamed[2].includes(NUDGE_MARKER), "turn 3 (shrunk history) must not nudge — the previous turn's high estimate is capped by this request's inbound upper bound");
});
