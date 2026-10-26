import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, defaultPrompts, leanPack } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { buildAcpTagsOnlyPrompt } from "../src/compress-tool.ts";

// #1881: renderTags runs independent of compress.injectTool — tags keep being
// rendered into history while the tool switch removes the whole compress
// prompt, taking the ACP-TAGS NEVER-echo prohibition with it ("the more you
// switch off, the more it leaks"). Units pin the extraction helper; e2e pins
// the openai-wire injection seam (prohibition present without the tool, full
// prompt unchanged with it, title-gen still gets neither).

test("buildAcpTagsOnlyPrompt: function family extracts exactly the ACP-TAGS section", () => {
    const out = buildAcpTagsOnlyPrompt("function");
    assert.ok(out.length > 0);
    assert.ok(out.startsWith("ACP TAGS"), `section head, got: ${out.slice(0, 40)}`);
    assert.ok(out.includes("NEVER echo"), "the prohibition survives extraction");
    assert.ok(!out.includes("HOW TO COMPRESS"), "rules section excluded");
    assert.ok(!out.includes("Compression Philosophy"), "philosophy section excluded");
});

test("buildAcpTagsOnlyPrompt: hybrid family extracts its own ACP-TAGS variant", () => {
    const out = buildAcpTagsOnlyPrompt("hybrid");
    assert.ok(out.startsWith("ACP TAGS"));
    assert.ok(out.includes("NEVER echo"));
    assert.ok(!out.includes("HOW TO COMPRESS"));
});

test("buildAcpTagsOnlyPrompt: user acpTags override wins verbatim; null disables", () => {
    assert.equal(buildAcpTagsOnlyPrompt("function", undefined, { acpTags: "CUSTOM-TAG-RULES" }), "CUSTOM-TAG-RULES");
    assert.equal(buildAcpTagsOnlyPrompt("hybrid", defaultPrompts, { acpTags: null }), "");
});

test("buildAcpTagsOnlyPrompt: survives packs overriding philosophy/howToCompress (#2335)", () => {
    // #2335 made the two lead blocks tri-state sections. The old hardcoded
    // prompts.* prefix then failed the startsWith guard for any trimming pack
    // and the whole ACP-TAGS prompt vanished (injectTool=false + promptPack=lean).
    const lean = leanPack.surface.promptSections!;
    for (const family of ["function", "hybrid"] as const) {
        const out = buildAcpTagsOnlyPrompt(family, defaultPrompts, lean);
        assert.ok(out.length > 0, `${family}: tags-only prompt must not vanish under the lean pack`);
        assert.ok(out.includes("Never echo the XML tags"), `${family}: lean acpTags rules delivered`);
        assert.ok(!out.includes("Compression Philosophy"), `${family}: dropped philosophy stays out`);
        assert.ok(!out.includes("Your summary is the ONLY record"), `${family}: swapped rules stay out`);
    }
    assert.equal(
        buildAcpTagsOnlyPrompt("function", defaultPrompts, { philosophy: "P", howToCompress: "R", acpTags: "T" }),
        "T",
    );
    assert.equal(
        buildAcpTagsOnlyPrompt("function", defaultPrompts, { philosophy: null, howToCompress: null, acpTags: "T2" }),
        "T2",
    );
});

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function upstreamServer(onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            onBody(req.url ?? "", parsed);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness { port: number; stop: () => Promise<void>; cleanup: () => void }

async function startProxy(upstream: http.Server, injectTool: boolean): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-1881-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(biliConfig, `{"providers":{}}`, "utf8");
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_RENDER_NONE;
    delete process.env.ACP_NO_COMPRESS_PROMPT;
    const upstreamPort = (upstream.address() as { port: number }).port;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        passthroughSource: null,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const CHAT_BODY = (maxTokens: number) => JSON.stringify({
    model: "test",
    max_tokens: maxTokens,
    messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "what did we say?" },
    ],
});

function systemText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Array<{ role?: string; content?: unknown }> | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const sys = msgs.find((m) => m.role === "system");
    assert.ok(sys, "a system message reaches the upstream");
    return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}

function toolNames(fwd: Record<string, unknown>): string[] {
    const tools = fwd.tools as Array<{ function?: { name?: string }; name?: string }> | undefined;
    return (tools ?? []).map((t) => t.function?.name ?? t.name ?? "");
}

test("e2e #1881 A: injectTool=false ⇒ NEVER-echo prohibition still injected, full prompt absent", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue1881-a" },
            body: CHAT_BODY(1000),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const sys = systemText(seen[0]);
        assert.ok(sys.includes("ACP TAGS"), "prohibition section present without the tool");
        assert.ok(sys.includes("NEVER echo"));
        assert.ok(!sys.includes("HOW TO COMPRESS"), "tool-mechanics sections stay out");
        assert.ok(!sys.includes("Compression Philosophy"));
        assert.ok(!toolNames(seen[0]).includes("compress"), "no compress tool registered");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1881 B: injectTool=true ⇒ full compress prompt unchanged (regression guard)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, true);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue1881-b" },
            body: CHAT_BODY(1000),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const sys = systemText(seen[0]);
        assert.ok(sys.includes("HOW TO COMPRESS"), "full prompt intact with the tool");
        assert.ok(sys.includes("NEVER echo"));
        assert.ok(toolNames(seen[0]).includes("compress"), "compress tool registered");
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});

test("e2e #1881 C: title-gen request gets neither full prompt nor tags-only section", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await upstreamServer((_path, body) => seen.push(body as Record<string, unknown>));
    const harness = await startProxy(upstream, false);
    try {
        const res = await fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "issue1881-c" },
            body: CHAT_BODY(100),
        });
        assert.equal(res.status, 200);
        assert.equal(seen.length, 1);
        const sys = systemText(seen[0]);
        assert.ok(!sys.includes("NEVER echo"), "title-gen stays clean");
        assert.ok(!sys.includes("HOW TO COMPRESS"));
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
});
