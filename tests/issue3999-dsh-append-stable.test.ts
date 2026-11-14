// #3999 (sub-defect of #3837): in the dsh plugin lane every new runtime-context
// snapshot used to demote the previous one, which carried the BLOCKED sentinel at
// birth and had a fresh ACP tag minted MID-HISTORY the instant it was superseded —
// inserting ~48 bytes of tag into the outbound prefix and breaking the per-round
// prefix cache from that point on. Fix (kernel, decouple ref-blocking from
// fold-protection): durable carriers are NUMBERED at birth while they sit at the
// append-stable tail, so demoting them inserts ZERO bytes. This test drives TWO
// consecutive dsh-shaped requests through the REAL proxy and asserts the outbound
// body stays append-stable: the demoted snapshot keeps identical bytes, the new
// snapshot appends after it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "gpt-test";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.";
const RT_V1 = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

Current DSH file policy: danger-full-access. Approval prompts are disabled in this session.`;
const RT_V2 = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

Current DSH file policy: danger-read-only. Approval prompts are enabled in this session.`;

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server; bodies: string[] };

async function startRig(): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            bodies.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetSessionOrderForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 0,
            compress: { minCompressRange: 500, maxSummaryLength: 20_000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: false },
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
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream, bodies };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

/** Non-system message texts, in wire order: the outbound-body assertion surface. */
function nonSystemTexts(body: string): string[] {
    const msgs = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    return msgs
        .filter((m) => m.role !== "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")));
}

test("#3999: two consecutive dsh runtime-context snapshots keep the outbound prefix byte-stable", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "i3999-append" };
        const post = (messages: Array<{ role: string; content: string }>) =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...messages] }) });

        // Shot 1: the first snapshot arrives at the tail (birth).
        await (await post([{ role: "user", content: RT_V1 }])).text();
        // Shot 2: a NEWER snapshot supersedes it — the old one demotes mid-history.
        await (await post([
            { role: "user", content: RT_V1 },
            { role: "assistant", content: "ack" },
            { role: "user", content: RT_V2 },
        ])).text();

        const t1 = nonSystemTexts(rig.bodies[0]!);
        const t2 = nonSystemTexts(rig.bodies[1]!);
        assert.ok(t1.length >= 1 && t2.length > t1.length, `expected the second shot to grow the history, got ${t1.length}/${t2.length}`);
        // Birth numbering reached the wire: the live snapshot carries a numeric ref
        // on its very first turn (NOT the unaddressable BLOCKED sentinel).
        assert.ok(/m\d{5}/.test(t1[0]!), `first-turn snapshot numbered at birth, got: ${t1[0]}`);
        // Append-stability (the #3837 symptom negated): the demoted snapshot keeps
        // IDENTICAL bytes across the two shots — no tag minted mid-history.
        assert.equal(t2[0]!, t1[0]!, "demoted snapshot bytes are identical across shots (zero mid-history insertion)");
        // The newest snapshot rides at the tail, freshly numbered.
        assert.ok(t2[t2.length - 1]!.includes("danger-read-only"), "newest snapshot appended at the tail");
        assert.ok(/m\d{5}/.test(t2[t2.length - 1]!), "newest snapshot is numbered too");
    } finally {
        await closeRig(rig);
    }
});
