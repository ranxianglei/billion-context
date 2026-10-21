// #4199: bili's own cumulative cache_control marking (#1637) picks the LAST
// STABLE message with no role filter (computeAnthropicMessageMarks). When that
// message is a mid-conversation system message whose content is a plain
// STRING, rebuildSystemMessage returned the raw sidecar verbatim — a string
// cannot carry a cache_control block, so the mark was silently dropped while
// the id permanently occupied one of the 3 message-mark slots. The kernel now
 // upgrades such a message to the single-text-block form so the breakpoint
// lands. Pinned end-to-end through the steady request path (both directions):
// marked string-content system at the tail → upgraded block WITH the mark;
// unmarked string-content system mid-history → byte-verbatim string.
// ACP_RENDER_NONE=1 keeps the core text byte-identical to the raw label, which
// is exactly when the codec's early-return path runs — under default text-only
// rendering the ref-tag prefix already changes the text, routing through the
// rewrite branch that carried the mark all along. Env is the per-request knob
// seam (env > config file > default), same pattern as issue2483-render-strategy.
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const anthropicSse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const TEXT_SSE = [
    anthropicSse("message_start", { type: "message_start", message: { id: "msg_4199", role: "assistant", usage: { input_tokens: 20 } } }),
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
    anthropicSse("message_stop", { type: "message_stop" }),
].join("");

type Block = { type?: string; text?: string; cache_control?: unknown };
type Body = { system?: string | Block[]; messages: Array<{ role: string; content: string | Block[] }> };

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(TEXT_SSE);
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
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
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

const STRIP_SYS = { role: "system", content: "be brief" };

test("#4199: string-content system at the stable tail carries its mark as a text block", async () => {
    const h = await startHarness();
    process.env.ACP_RENDER_NONE = "1";
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue4199-tail-system" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: [
                    { role: "user", content: [{ type: "text", text: "examine subsystem one and report failure modes." }] },
                    { role: "assistant", content: [{ type: "text", text: "subsystem one shows three failure modes under load." }] },
                    { role: "user", content: [{ type: "text", text: "now check subsystem two." }] },
                    STRIP_SYS,
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.ok(h.captured.length >= 1, "upstream body captured");
        const sent = JSON.parse(h.captured[0]!) as Body;
        const last = sent.messages[sent.messages.length - 1]!;
        assert.deepEqual(last, {
            role: "system",
            content: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
        });
    } finally {
        delete process.env.ACP_RENDER_NONE;
        await h.close();
    }
});

test("#4199 control: unmarked string-content system mid-history stays byte-verbatim", async () => {
    const h = await startHarness();
    process.env.ACP_RENDER_NONE = "1";
    try {
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue4199-mid-system" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: [
                    { role: "user", content: [{ type: "text", text: "examine subsystem one and report failure modes." }] },
                    { role: "assistant", content: [{ type: "text", text: "subsystem one shows three failure modes under load." }] },
                    STRIP_SYS,
                    { role: "user", content: [{ type: "text", text: "now check subsystem two." }] },
                ],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        assert.ok(h.captured.length >= 1, "upstream body captured");
        const sent = JSON.parse(h.captured[0]!) as Body;
        // The string-content system keeps its exact wire shape — no upgrade,
        // no invented block — and the mark rides the actual stable tail.
        const sysIdx = sent.messages.findIndex((m) => m.role === "system");
        assert.ok(sysIdx >= 0, "mid-history system message present");
        assert.deepEqual(sent.messages[sysIdx], STRIP_SYS);
        const last = sent.messages[sent.messages.length - 1]!;
        const lastBlocks = typeof last.content === "string" ? [] : last.content;
        assert.equal(lastBlocks.some((b) => b.cache_control !== undefined), true, "mark landed on the stable tail");
    } finally {
        delete process.env.ACP_RENDER_NONE;
        await h.close();
    }
});
