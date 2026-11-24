// #5688 wiring pin: the egress repair (dedupeAdjacentOutputConfig) must actually
// run on the REAL HTTP path — the unit suite pins the helper, this file pins
// the call site. A fold can leave two per-turn effort directives
// ({role:"system", content:[], output_config:{effort}}) adjacent in the
// reconstructed history (the covered span between them is pruned while both
// directive-only survivors stay); OpenRouter rejects that shape with a hard
// 400 ("Two adjacent output_config directives are not allowed") and the
// session dies deterministically on every retry. The mock upstream below
// enforces the SAME validation rule, so a regression at the seam fails twice:
// on the forwarded bytes AND on the 400 the client receives. Assertions are
// structural by design: message text may legally ride ACP render tags
// depending on session maturity, which is orthogonal to the collapse.
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";

type WireMsg = { role: string; content?: unknown; output_config?: unknown };

const directive = (effort: string): WireMsg => ({ role: "system", content: [], output_config: { effort } });

/** OpenRouter's per-turn-effort beta validation rule, enforced verbatim. */
function hasAdjacentDirectives(messages: WireMsg[]): boolean {
    const isDir = (m: WireMsg | undefined): boolean =>
        !!m && m.role === "system" && m.output_config != null && (!Array.isArray(m.content) || m.content.length === 0);
    for (let i = 0; i + 1 < messages.length; i++) {
        if (isDir(messages[i]) && isDir(messages[i + 1])) return true;
    }
    return false;
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string {
    return anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" });
}

interface Rig {
    proxyPort: number;
    portHint(): number;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            upstreamBodies.push(raw);
            const parsed = JSON.parse(raw) as { messages?: WireMsg[] };
            if (parsed.messages && hasAdjacentDirectives(parsed.messages)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: "Invalid Anthropic Messages API request",
                        metadata: { raw: "[{\"code\":\"custom\",\"path\":[\"messages\",2,\"output_config\"],\"message\":\"Two adjacent output_config directives are not allowed\"}]" },
                    },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l5688-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const server = await startServer(opts);
    await listen(server);
    const proxyPort = (server.address() as { port: number }).port;

    return {
        proxyPort,
        portHint: () => upstreamPort,
        upstreamBodies,
        closeAll: async () => {
            await close(server);
            await close(upstream);
        },
    };
}

async function postModel(rig: Rig, sessionId: string, messages: WireMsg[]): Promise<Response> {
    const port = rig.portHint();
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": sessionId },
        body: JSON.stringify({ model: "l5688-model", max_tokens: 8192, stream: true, messages }),
    });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pred(), `timeout waiting for ${what}`);
}

function directivesOf(body: string): WireMsg[] {
    const parsed = JSON.parse(body) as { messages: WireMsg[] };
    return parsed.messages.filter((m) => m.output_config != null);
}

test("#5688: two adjacent effort directives (fold terminal condition) are collapsed to the latter before egress", async () => {
    const rig = await startRig();
    try {
        // The exact shape the fold reconstruction leaves behind: the covered
        // span between two surviving directive-only systems is gone, the two
        // directives sit next to each other.
        const history: WireMsg[] = [
            { role: "user", content: "q1" },
            directive("max"),
            directive("low"),
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
            { role: "user", content: "q3" },
        ];
        // Fresh id per run: the shared state dir persists sessions across
        // local/CI runs, and a replayed id re-encodes history differently.
        const res = await postModel(rig, `5688-a-${randomUUID()}`, history);
        await waitFor(() => rig.upstreamBodies.length >= 1, "forward");

        assert.equal(res.status, 200, `client saw ${res.status} — the validator rejected the forwarded shape`);

        const out = JSON.parse(rig.upstreamBodies[0]) as { messages: WireMsg[] };
        assert.ok(!hasAdjacentDirectives(out.messages), "no adjacent output_config directives survive egress");
        const dirs = directivesOf(rig.upstreamBodies[0]);
        assert.equal(dirs.length, 1, "exactly one directive remains after the collapse");
        assert.deepEqual(dirs[0], directive("low"), "the LATTER effort wins (keep-latter semantics)");
        assert.deepEqual(
            out.messages.map((m) => m.role),
            ["user", "system", "assistant", "user"],
            "5 inbound -> 4 outbound: only the earlier duplicate was removed, survivors keep their order",
        );
        for (const m of out.messages.filter((x) => x.role !== "system")) {
            const blocks = Array.isArray(m.content) ? (m.content as { type?: string }[]) : [];
            assert.ok(blocks.length > 0, "surviving non-directive message keeps its content blocks");
        }
    } finally {
        await rig.closeAll();
    }
});

test("#5688 negative: a healthy pi-shaped history (directives separated by assistants) passes through with every directive intact", async () => {
    const rig = await startRig();
    try {
        // pi's native shape: one directive before every leveled assistant plus
        // one trailing directive for the active level. Nothing adjacent.
        const history: WireMsg[] = [
            { role: "user", content: "u1" },
            directive("max"),
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
            { role: "user", content: "u2" },
            directive("high"),
            { role: "assistant", content: [{ type: "text", text: "a2" }] },
            directive("low"),
        ];
        const res = await postModel(rig, `5688-b-${randomUUID()}`, history);
        await waitFor(() => rig.upstreamBodies.length >= 1, "forward");
        assert.equal(res.status, 200);

        const out = JSON.parse(rig.upstreamBodies[0]) as { messages: WireMsg[] };
        assert.equal(out.messages.length, 7, "clean history is not reshaped (identity fast path)");
        const dirs = directivesOf(rig.upstreamBodies[0]);
        assert.deepEqual(dirs.map((d) => d.output_config), [{ effort: "max" }, { effort: "high" }, { effort: "low" }], "all three directives survive, in order, unmodified");
        assert.ok(!hasAdjacentDirectives(out.messages));
        assert.deepEqual(
            out.messages.map((m) => m.role),
            ["user", "system", "assistant", "user", "system", "assistant", "system"],
            "every non-directive message survives in place",
        );
    } finally {
        await rig.closeAll();
    }
});
