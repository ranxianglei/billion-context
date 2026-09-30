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

// #553 follow-up (obs 1): the proxy-side nudge is the PROACTIVE compression
// trigger — preflight only fires at the hard limit. Its decision (kernel
// decideNudge) is driven by tokenCount/limit (usage) and a growth floor whose
// reference falls back to tokenCount itself. Anonymous prefix-affinity forks
// arrive with lastInputTokens == 0 while replaying their FULL raw history, so
// usage read 0% and growth 0 forever: a payload sitting just UNDER the window
// had no compression trigger at all until overflow ("nudge idle: usage=0% ...
// pendingT1=944861/50000" in the incident log). effectiveTokenCount feeds the
// char-count upper bound for exactly this regime. These tests pin it:
//   A. anonymous zero-baseline fork at 90% of window (char measure) → nudge
//      injects, nothing folded, preflight stays silent (estimates under).
//   B. explicit-identity control with the identical conversation → NO nudge
//      (zero baseline there means "new small session", self-heals via the
//      next measured usage report).

const NUDGE_MARKER = "Context limit reached";
const WINDOW = 60_000;

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
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

// 12 messages: 7 OLD code-heavy ones (~5.5k chars each) + 5 tiny recent ones
// (inside the preserveRecentMessages=5 soft zone). Char-count upper bound:
// ~54k/60k ≈ 90% of the window (≥ maxContextLimitPct 0.75 → over-limit for
// decideNudge; T1 pending ≈ 3 ranges × ~1.9k tokens ≥ minPressureBenefit 5k).
// Optimistic chars/4 estimate: < window (< window → preflight must stay
// silent). Kernel thresholds differ from the PR's original pin (min pressure
// benefit 5k) — hence the big-old/tiny-recent shape.
function forkConversation(): Array<{ role: string; content: string }> {
    const line = (i: number) =>
        `const handler_${i} = (req: Request, res: Response) => { res.status(200).json({ status: "ok", id: ${i}, ts: Date.now() }); };`;
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `CODE_${i}_` + (i < 7 ? line(i).repeat(62) : line(i)) });
    }
    return msgs;
}

async function runCase(opts: { anonymous: boolean }): Promise<{
    calls: Array<{ stream: boolean; body: string }>;
    status: number;
}> {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                /* keep {} */
            }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
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
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (!opts.anonymous) headers["x-acp-session"] = "fork-nudge-explicit-sess";
        const body = JSON.stringify({
            model: "claude-small",
            max_tokens: 1024,
            stream: true,
            messages: forkConversation(),
        });
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body,
        });
        await resp.text();
        return { calls, status: resp.status };
    } finally {
        proxy.close();
        upstream.close();
    }
}

test("e2e: anonymous zero-baseline fork below the window → nudge injects (no fold, preflight silent)", async () => {
    const { calls, status } = await runCase({ anonymous: true });
    assert.equal(status, 200);
    assert.equal(calls.filter((c) => !c.stream).length, 0, "preflight must stay silent (optimistic estimate under window)");
    const forward = calls.filter((c) => c.stream).at(-1)!;
    const msgs = msgsOf(forward.body);
    const last = msgs.at(-1)!;
    assert.ok(
        last.role === "user" && msgText(last).includes(NUDGE_MARKER),
        `expected trailing user nudge, got last message: ${JSON.stringify(forward.body.slice(-800))}`,
    );
    for (let i = 0; i < 12; i++) {
        assert.ok(forward.body.includes(`CODE_${i}_`), `CODE_${i}_ must survive un-folded`);
    }
});

test("e2e: explicit-identity zero-baseline session with the same conversation → NO nudge (regime scoping)", async () => {
    const { calls, status } = await runCase({ anonymous: false });
    assert.equal(status, 200);
    assert.equal(calls.filter((c) => !c.stream).length, 0);
    const forward = calls.filter((c) => c.stream).at(-1)!;
    assert.ok(!forward.body.includes(NUDGE_MARKER), "explicit-identity zero baseline must stay at 0 (self-heals via measured usage)");
    const tailMsgs = msgsOf(forward.body);
    const last = tailMsgs.at(-1)!;
    // Strip the outbound ACP anchor tag (proxy-mode wire format, AGENTS.md §2) before comparing.
    const stripped = msgText(last).replace(/^\x3cacp\s[^>]*>[^\x3c]*\x3c\/acp\x3e/, "").trimStart();
    assert.ok(stripped.startsWith("CODE_11_"), `last message must be the original last message (modulo the outbound ACP anchor tag): ${JSON.stringify(last).slice(0, 200)}`);
});

// #1137: the anonymous-branch upper bound must carry the image term. An
// image-heavy fork (client reload replaying screenshot history) reuses the
// A-conversation text (~54k chars — proven T1 mass ~5.7k ≥ minPressureBenefit)
// in a 100k window so the TEXT-only bound sits at ~54%, below every band,
// while the byte-billed image mass (3 × 10k) lifts the total to ~84% — over
// the 75% pressure band. Pre-fix the branch returned the text-only bound and
// the nudge stayed idle until overflow. Bytes billing: ceil(b64 length / 4)
// per image (same shape as silent-backend-nudge.test.ts).
const IMG_WINDOW = 100_000;
const IMG_B64 = "iVBORw0KGgo" + "A".repeat(40_000 - 9); // 10_000 tokens
const imgPart = (): Record<string, unknown> => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: IMG_B64 },
});

function imageForkConversation(): Array<{ role: string; content: unknown }> {
    // forkConversation() verbatim (7 old ~7.3k-char messages + 5 tiny recent)
    // with one recent user message swapped to carry 3 inline screenshots —
    // the recent zone is preserved anyway, so T1 mass is unchanged.
    const msgs = forkConversation().map((m) => ({ ...m })) as Array<{ role: string; content: unknown }>;
    msgs[10] = { role: "user", content: [{ type: "text", text: "tiny question with screenshots" }, imgPart(), imgPart(), imgPart()] };
    return msgs;
}

async function runImageCase(): Promise<Array<{ stream: boolean; body: string }>> {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                /* keep {} */
            }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: IMG_WINDOW } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-small",
                max_tokens: 1024,
                stream: true,
                messages: imageForkConversation(),
            }),
        });
        await resp.text();
        return calls;
    } finally {
        proxy.close();
        upstream.close();
    }
}

test("e2e: #1137 anonymous image-heavy fork → image term crosses the pressure band, nudge injects", async () => {
    const calls = await runImageCase();
    assert.equal(calls.filter((c) => !c.stream).length, 0, "preflight must stay silent (optimistic estimate under window)");
    const forward = calls.filter((c) => c.stream).at(-1)!;
    const msgs = msgsOf(forward.body);
    const last = msgs.at(-1)!;
    assert.ok(
        last.role === "user" && msgText(last).includes(NUDGE_MARKER),
        `expected trailing user nudge — text-only bound (~54%) sits below every band, only the image term (3 × 10k) can cross it; got: ${forward.body.slice(-800)}`,
    );
    assert.ok(forward.body.includes("image/png"), "images must ride along un-folded (nudge is advisory)");
});
