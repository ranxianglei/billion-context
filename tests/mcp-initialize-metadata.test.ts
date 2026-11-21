import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

type Reply = {
    id: number;
    result?: {
        protocolVersion?: string;
        tools?: Array<{ name: string }>;
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
    };
};

type Options = {
    meta?: Record<string, unknown>;
    envId?: string | null;
    callMeta?: Record<string, unknown>;
    perCall?: string;
    expectedId: string;
    expectedRegistration?: string | null;
    native?: boolean;
};

async function exercise(t: TestContext, options: Options): Promise<void> {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const server = http.createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
        requests.push({ path: req.url ?? "", body });
        res.setHeader("content-type", "application/json");
        if (req.url === "/__bili/plugin/manifest") {
            res.end(JSON.stringify({ tools: { anthropic: [{ name: "acp_status", input_schema: { type: "object" } }] } }));
        } else if (req.url === "/__bili/plugin/tool") {
            res.end(JSON.stringify({ ok: true, result: `status for ${body?.conversationId}`, outcome: "success" }));
        } else {
            res.end(JSON.stringify({ ok: true }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env: NodeJS.ProcessEnv = { ...process.env, BILI_MCP_PROXY: `http://127.0.0.1:${address.port}` };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.BILI_CONVERSATION_ID;
    const envId = options.envId === undefined ? "stable-env-session" : options.envId;
    if (envId !== null) env.BILI_CONVERSATION_ID = envId;
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/mcp.ts", import.meta.url))], { env, stdio: "pipe" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => { stderr += text; });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    t.after(async () => {
        if (child.exitCode === null) child.kill();
        await closed;
        lines.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const call = async (id: number, method: string, params?: Record<string, unknown>): Promise<Reply> => {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const line = await Promise.race([
                iterator.next(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`MCP ${method} response timeout: ${stderr}`)), 10_000);
                }),
            ]);
            assert.equal(line.done, false, `MCP closed before ${method} response: ${stderr}`);
            const reply = JSON.parse(line.value) as Reply;
            assert.equal(reply.id, id);
            return reply;
        } finally {
            clearTimeout(timer);
        }
    };

    const initialized = await call(0, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "metadata-test", version: "1" },
        ...(options.meta === undefined ? {} : { _meta: options.meta }),
    });
    assert.equal(initialized.result?.protocolVersion, "2025-06-18");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.deepEqual((await call(1, "ping")).result, {});
    assert.equal((await call(2, "tools/list")).result?.tools?.[0]?.name, "acp_status");
    const result = await call(3, "tools/call", {
        name: "acp_status",
        arguments: { detail: "unchanged", ...(options.perCall ? { conversation_id: options.perCall } : {}) },
        ...(options.callMeta ? { _meta: options.callMeta } : {}),
    });
    assert.equal(result.result?.isError, false);
    assert.equal(result.result?.content?.[0]?.text, `status for ${options.expectedId}`);
    const posts = requests.filter((r) => r.path === "/__bili/plugin/tool");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body?.conversationId, options.expectedId);
    assert.deepEqual(posts[0].body?.args, { detail: "unchanged" });
    assert.equal(posts[0].body?.nativeCaller, options.native ? true : undefined);
    const registers = requests.filter((r) => r.path === "/__bili/plugin/register");
    const registered = options.expectedRegistration === undefined ? "stable-env-session" : options.expectedRegistration;
    assert.equal(registers.length, registered === null ? 0 : 1);
    if (registered !== null) assert.deepEqual(registers[0].body, { conversationId: registered, agent: "mcp", identity: false });
    assert.equal(child.exitCode, null, stderr);
}

for (const [name, sessionId] of [
    ["number", 42], ["zero", 0], ["boolean", false], ["array", ["other-session"]], ["object", { id: "other-session" }],
] as const) {
    test(`MCP initialize ignores ${name} session metadata and keeps its tool service alive`, async (t) => {
        await exercise(t, { meta: { ui: { sessionId } }, expectedId: "stable-env-session" });
    });
}

for (const [name, meta] of [
    ["missing metadata", undefined], ["null ui", { ui: null }], ["primitive ui", { ui: 42 }],
    ["null session ID", { ui: { sessionId: null } }], ["blank session ID", { ui: { sessionId: " \t " } }],
] as const) {
    test(`MCP initialize retains environment binding with ${name}`, async (t) => {
        await exercise(t, { meta, expectedId: "stable-env-session" });
    });
}

test("MCP initialize still trims a usable metadata ID without an environment binding", async (t) => {
    await exercise(t, { meta: { ui: { sessionId: "  metadata-session\t" } }, envId: null, expectedId: "metadata-session", expectedRegistration: "metadata-session" });
});

test("MCP initialize keeps the environment binding ahead of a usable metadata ID", async (t) => {
    await exercise(t, { meta: { ui: { sessionId: "other-session" } }, expectedId: "stable-env-session" });
});

test("MCP per-call conversation routing still outranks the initialization binding", async (t) => {
    await exercise(t, { meta: { ui: { sessionId: "other-session" } }, perCall: "per-call-session", expectedId: "per-call-session" });
});

test("MCP host-native thread routing still outranks environment and copied arguments", async (t) => {
    await exercise(t, { meta: { ui: { sessionId: "other-session" } }, perCall: "copied-session", callMeta: { threadId: " native-session " }, expectedId: "native-session", native: true });
});

test("MCP ignored initialization metadata leaves unbound host-native routing available", async (t) => {
    await exercise(t, { meta: { ui: { sessionId: { opaque: true } } }, envId: null, callMeta: { threadId: "native-session" }, expectedId: "native-session", expectedRegistration: null, native: true });
});
