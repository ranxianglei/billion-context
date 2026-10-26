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

type TurnMsg = { role: string; content: string | Array<Record<string, unknown>> };

// #1119: the stale-high cap in effectiveTokenCount (the min() against THIS
// request's inbound upper bound) used to be TEXT-ONLY — estimateCoreMessagesUpper
// sums m.text, and the wire codecs move images out of CoreMessage.text into
// sidecars. Whenever the previous turn's image contribution exceeded the current
// turn's text growth, the image term was capped away and the nudge numerator went
// blind to exactly the byte-billed multimodal sessions #728 restored. Fix: the
// bound carries the current request's image term (resolved billing).
// Window is 80k (not the shared 60k): the kernel's absolute-token zones
// (preserveRecentTokens 5k + minPressureBenefit 5k ⇒ ≥ ~10k tokens of compressible
// text mass) squeeze a 60k window so thin that pre-fix/post-fix states collide.
// Pins:
//   turn 1: 6 heavy + 4 medium code messages (~50k chars total) plus two 10k-token
//           inline images (ceil(b64/4) @ bytes) → idle (nothing measured yet) but
//           records an estimate carrying a 20k-token image term.
//   turn 2: same history + small additions → text-only bound sits at ~63% of the
//           window, below EVERY band (45% first-sight / 70% host emergency
//           escalation / 75% pressure), yet the image-aware numerator must reach
//           ~88% ≥ 75% maxContextLimitPct → NUDGE.
//           Pre-fix: numerator = text-only bound (~63%) → no nudge (the bug).
//           Compressible mass: the 4 oldest heavies survive the preserveRecentTokens
//           walk ≈ 7.3k tokens ≥ minPressureBenefit 5k.
//   turn 3: shrunk history WITHOUT images → no nudge (a client-side shrink
//           shrinks the bound in BOTH terms — stale-high invariant preserved).
const IMG_B64 = "iVBORw0KGgo" + "A".repeat(40_000 - 9); // bytes billing: ceil(40000/4) = 10_000 tokens
const MED = (i: number) => `NOTE_${i}_` + LINE(i).repeat(12);

const imgPart = (): Record<string, unknown> => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: IMG_B64 },
});

async function runCase(opts: { inputTokens: number | null; sessionId?: string; turns?: TurnMsg[][]; window?: number }): Promise<{ statuses: number[]; streamed: string[]; nonStream: number }> {
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
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: opts.window ?? WINDOW } } } },
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const post = async (messages: TurnMsg[]): Promise<number> => {
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": opts.sessionId ?? "silent-backend-sess" },
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
        const turns = opts.turns ?? (() => {
            const base = baseConversation();
            return [
                base,
                [
                    ...base,
                    { role: "assistant", content: "ok, done with step one." },
                    { role: "user", content: HEAVY(99) + " now step two" },
                ],
                [
                    { role: "user", content: "short recent slice one" },
                    { role: "assistant", content: "ok fine" },
                    { role: "user", content: "tiny question only" },
                ],
            ];
        })();
        const statuses: number[] = [];
        for (const t of turns) statuses.push(await post(t));
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

test("#1119: silent-backend image term survives the stale-high cap — inline images count toward the nudge numerator", async () => {
    const turn1: TurnMsg[] = [
        { role: "user", content: HEAVY(0) },
        { role: "assistant", content: HEAVY(1) },
        { role: "user", content: HEAVY(2) },
        { role: "assistant", content: HEAVY(3) },
        { role: "user", content: HEAVY(4) },
        { role: "assistant", content: HEAVY(5) },
        { role: "user", content: MED(6) },
        { role: "assistant", content: MED(7) },
        { role: "user", content: MED(8) },
        { role: "assistant", content: MED(9) },
        { role: "user", content: [{ type: "text", text: "analyze these screenshots" }, imgPart(), imgPart()] },
    ];
    const turn2: TurnMsg[] = [
        ...turn1,
        { role: "assistant", content: "ok, done with step one." },
        { role: "user", content: "now step two" },
    ];
    const turn3: TurnMsg[] = [
        { role: "user", content: "short recent slice one" },
        { role: "assistant", content: "ok fine" },
        { role: "user", content: "tiny question only" },
    ];
    const { statuses, streamed, nonStream } = await runCase({ inputTokens: null, sessionId: "silent-backend-img-sess", turns: [turn1, turn2, turn3], window: 80_000 });
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal(nonStream, 0, "preflight must stay silent (optimistic estimate under window)");
    assert.equal(streamed.length, 3);
    assert.ok(!streamed[0].includes(NUDGE_MARKER), "turn 1 must stay idle — nothing measured yet");
    assert.ok(streamed[1].includes('"media_type":"image/png"'), "images must ride along un-folded (nudge is advisory, no fold happened)");
    const fwd = msgsOf(streamed[1]);
    const last = fwd.at(-1)!;
    assert.ok(
        last.role === "user" && msgText(last).includes(NUDGE_MARKER),
        `turn 2 must carry the trailing nudge — the text-only bound (~63%) sits below every band, so only the recorded estimate's image term (2 x 10k tokens) can push the numerator over the 75% pressure band; pre-fix the text-only bound capped it away, got: ${streamed[1].slice(-800)}`,
    );
    assert.ok(!streamed[2].includes(NUDGE_MARKER), "turn 3 (shrunk history, no images) must not nudge — a client-side shrink shrinks the bound in BOTH terms");
});
