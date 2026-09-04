import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.NODE_ENV = "test";

import biliPlugin from "../src/agent/pi.ts";

const REAL_FETCH = globalThis.fetch;

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

type RecordedTool = { name: string };
type FakePi = {
    events: Map<string, (event: unknown, ctx: unknown) => unknown>;
    tools: RecordedTool[];
    on: (event: string, handler: (event: never, ctx: never) => unknown) => void;
    registerTool: (tool: RecordedTool) => void;
    registerCommand: () => void;
};

function makeFakePi(): FakePi {
    const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const tools: RecordedTool[] = [];
    return {
        events,
        tools,
        on: (event, handler) => events.set(event, handler as (event: never, ctx: never) => unknown),
        registerTool: (tool) => {
            const i = tools.findIndex((t) => t.name === tool.name);
            if (i >= 0) tools[i] = tool;
            else tools.push(tool);
        },
        registerCommand: () => {},
    };
}

function plainCtx(sessionId = "native-sess"): Record<string, unknown> {
    return {
        sessionManager: { getSessionId: () => sessionId },
        model: { contextWindow: 1000000, baseUrl: "https://api.example.com/v1" },
        cwd: "/tmp",
    };
}

async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50));
}

async function waitForTools(pi: FakePi, count: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pi.tools.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} registered tools; got ${pi.tools.length}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function startManifestProxy(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ tools: { anthropic: [
                { name: "compress", description: "Compress context ranges", input_schema: { type: "object", properties: { content: { type: "array" } }, required: ["content"] } },
                { name: "acp_status", description: "Status", input_schema: { type: "object", properties: {} } },
            ] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function writeMarker(stateDir: string, agents: Record<string, boolean>): void {
    fs.mkdirSync(path.join(stateDir, "billion-context"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "billion-context", "native.json"), JSON.stringify(agents, null, 2) + "\n");
}

// NODE_ENV is deleted inside these scopes so startDaemon gets past its test
// guard and exercises the real marker/kill-switch/entry logic.
test("native mode stays inert without a marker", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-native-state-"));
    try {
        await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined, NODE_ENV: undefined }, async () => {
            const pi = makeFakePi();
            biliPlugin(pi as never);
            const headers: Record<string, string> = {};
            pi.events.get("before_provider_headers")!({ headers }, plainCtx());
            assert.deepEqual(headers, {}, "no header stamped without a proxy");
            await pi.events.get("session_start")!({}, plainCtx());
            await flush();
            assert.equal(pi.tools.length, 0);
            assert.equal(globalThis.fetch, REAL_FETCH, "no interceptor installed");
        });
    } finally {
        fs.rmSync(state, { recursive: true, force: true });
    }
});

test("BILLION_CONTEXT_PLUGIN=0 wins over an enabled marker", async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-native-state-"));
    try {
        writeMarker(state, { pi: true });
        await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: "0", NODE_ENV: undefined }, async () => {
            const pi = makeFakePi();
            biliPlugin(pi as never);
            await pi.events.get("session_start")!({}, plainCtx());
            await flush();
            assert.equal(pi.tools.length, 0);
            assert.equal(globalThis.fetch, REAL_FETCH, "kill switch blocks daemon spawn");
        });
    } finally {
        fs.rmSync(state, { recursive: true, force: true });
    }
});

test("a launcher-provided proxy beats native spawning (marker ignored)", async () => {
    const proxy = await startManifestProxy();
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-native-state-"));
    try {
        writeMarker(state, { pi: true });
        await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined, NODE_ENV: undefined }, async () => {
            const pi = makeFakePi();
            biliPlugin(pi as never);
            const ctx = {
                sessionManager: { getSessionId: () => "native-sess" },
                model: { contextWindow: 1000000, baseUrl: `${proxy.origin}/bili/https://api.example.com/v1` },
                cwd: "/tmp",
            };
            await pi.events.get("session_start")!({}, ctx);
            await waitForTools(pi, 2);
            assert.equal(globalThis.fetch, REAL_FETCH, "no interceptor when a launcher proxy is detected");
            const headers: Record<string, string> = {};
            pi.events.get("before_provider_headers")!({ headers }, ctx);
            assert.equal(headers["x-bili-plugin"], "pi", "normal plugin path intact");
            await pi.events.get("session_shutdown")!({}, ctx);
        });
    } finally {
        fs.rmSync(state, { recursive: true, force: true });
        await proxy.close();
    }
});

test("marker enabled but package entry absent → warn and stay inert", async (t) => {
    // With dist/index.js present this scope would spawn a REAL daemon, so the
    // test only runs where the entry genuinely cannot exist (fresh checkout, CI).
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
    if (fs.existsSync(entry)) {
        t.skip("dist/index.js present — would spawn a real daemon");
        return;
    }
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "bili-native-state-"));
    try {
        writeMarker(state, { pi: true });
        const origErr = console.error;
        const errs: string[] = [];
        console.error = (...args: unknown[]): void => { errs.push(args.map(String).join(" ")); };
        try {
            await withEnv({ XDG_STATE_HOME: state, BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined, NODE_ENV: undefined }, async () => {
                const pi = makeFakePi();
                biliPlugin(pi as never);
                await pi.events.get("session_start")!({}, plainCtx());
                await flush();
                assert.equal(pi.tools.length, 0);
                assert.equal(globalThis.fetch, REAL_FETCH);
            });
        } finally {
            console.error = origErr;
        }
        assert.ok(errs.some((e) => e.includes("package entry not found")), `expected entry-missing warning, got: ${errs.join(" | ")}`);
    } finally {
        fs.rmSync(state, { recursive: true, force: true });
    }
});
