import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defaultConfig, ACP_TOOLS_OPENAI, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_RESPONSES } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { resolveCompressSurface } from "../src/compress-settings.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

// #747 regression: compress-prompt-pack.test.ts asserts applyAcpToolOverrides
// directly against the kernel helper (false coverage of the server wiring);
// these drive the real prepare paths through startServer + a capturing mock
// upstream and assert the pack surface reaches the outbound body. Last test
// covers the sibling gap: injectSystem got no surface either, so pack
// promptSections never reached the Anthropic system block while the #422 loop
// rebuild used them (byte mismatch between original request and re-requests).
// Expectations are read from the installed kernel's builtin lean pack via the
// SAME resolver the server uses, so this pins the wiring (pack values reach
// the outbound body), not any specific kernel version's wording — hardcoded
// copies broke when acp-kernel 0.0.69 reworded lean's paramDescriptions.

function leanToolPrompts() {
    const tp = resolveCompressSurface({ promptPack: "lean" }).toolPrompts;
    assert.ok(tp && Object.keys(tp).length > 0, "builtin lean pack resolves with non-empty toolPrompts");
    assert.ok(tp.compress?.description, "lean compress carries a description override");
    assert.ok(tp.compress?.paramDescriptions?.content, "lean compress carries a content paramDescription");
    return tp;
}

type Captured = { urlPath: string; body: Record<string, any> };
type Harness = { proxyUrl: string; captured: Captured[]; close(): Promise<void> };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

async function startHarness(routeCompress: ProxyOptions["routes"][string]): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ urlPath: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { compress: routeCompress },
        },
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
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`,
        captured,
        close: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

test("#747: openai wire — lean pack toolPrompts applied to injected ACP tools", async () => {
    const h = await startHarness({ promptPack: "lean" });
    try {
        await fetch(`${h.proxyUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "pack-tool-openai" },
            body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(h.captured.length, 1);
        const tp = leanToolPrompts();
        const tools: { type?: string; function?: { name: string; description: string; parameters?: Record<string, any> } }[] = h.captured[0].body.tools;
        assert.ok(Array.isArray(tools) && tools.length > 0, "tools injected");
        for (const [name, overrides] of Object.entries(tp)) {
            const tool = tools.find((t) => t.function?.name === name);
            assert.ok(tool, `${name} injected`);
            if (overrides.description !== undefined) {
                assert.equal(tool.function.description, overrides.description, `${name} description from lean pack`);
            }
        }
        const compress = tools.find((t) => t.function?.name === "compress")!;
        const defaultDesc = ACP_TOOLS_OPENAI.find((t) => t.function.name === "compress")!.function.description;
        assert.notEqual(compress.function.description, defaultDesc, "not the kernel default");
        assert.equal(compress.function.parameters?.properties?.content?.description, tp.compress.paramDescriptions?.content, "paramDescriptions applied");
    } finally {
        await h.close();
    }
});

test("#747: anthropic wire — lean pack toolPrompts applied to injected ACP tools", async () => {
    const h = await startHarness({ promptPack: "lean" });
    try {
        await fetch(`${h.proxyUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "pack-tool-anthropic" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 4096, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(h.captured.length, 1);
        const tp = leanToolPrompts();
        const tools: { name: string; description: string; input_schema?: Record<string, any> }[] = h.captured[0].body.tools;
        assert.ok(Array.isArray(tools) && tools.length > 0, "tools injected");
        for (const [name, overrides] of Object.entries(tp)) {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `${name} injected`);
            if (overrides.description !== undefined) {
                assert.equal(tool.description, overrides.description, `${name} description from lean pack`);
            }
        }
        const compress = tools.find((t) => t.name === "compress")!;
        const defaultDesc = ACP_TOOLS_ANTHROPIC.find((t) => t.name === "compress")!.description;
        assert.notEqual(compress.description, defaultDesc, "not the kernel default");
        assert.equal(compress.input_schema?.properties?.content?.description, tp.compress.paramDescriptions?.content, "paramDescriptions applied");
    } finally {
        await h.close();
    }
});

test("#747: responses wire — lean pack toolPrompts applied to injected ACP tools", async () => {
    const h = await startHarness({ promptPack: "lean" });
    try {
        await fetch(`${h.proxyUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "pack-tool-responses" },
            body: JSON.stringify({ model: "gpt-test", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] }),
        });
        assert.equal(h.captured.length, 1);
        const tp = leanToolPrompts();
        const tools: { name?: string; description?: string; parameters?: Record<string, any> }[] = h.captured[0].body.tools;
        assert.ok(Array.isArray(tools) && tools.length > 0, "tools injected");
        for (const [name, overrides] of Object.entries(tp)) {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `${name} injected`);
            if (overrides.description !== undefined) {
                assert.equal(tool.description, overrides.description, `${name} description from lean pack`);
            }
        }
        const compress = tools.find((t) => t.name === "compress")!;
        const defaultDesc = ACP_TOOLS_RESPONSES.find((t) => t.name === "compress")!.description!;
        assert.notEqual(compress.description, defaultDesc, "not the kernel default");
        assert.equal(compress.parameters?.properties?.content?.description, tp.compress.paramDescriptions?.content, "paramDescriptions applied");
    } finally {
        await h.close();
    }
});

test("#747-sibling: anthropic wire — pack promptSections reach the system block via injectSystem", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-pack-e2e-"));
    const prevCwd = process.cwd();
    try {
        mkdirSync(path.join(dir, ".billion-context", "packs"), { recursive: true });
        writeFileSync(
            path.join(dir, ".billion-context", "packs", "sectionspack.json"),
            JSON.stringify({ promptSections: { acpTags: "PACK-ACP-TAGS-E2E-MARKER" } }),
        );
        process.chdir(dir);
        const h = await startHarness({ promptPack: "sectionspack" });
        try {
            await fetch(`${h.proxyUrl}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "pack-sections-anthropic" },
                body: JSON.stringify({ model: "claude-test", max_tokens: 4096, messages: [{ role: "user", content: "hello" }] }),
            });
            assert.equal(h.captured.length, 1);
            const system: string | Array<{ type: string; text: string }> = h.captured[0].body.system;
            const sysText = typeof system === "string" ? system : Array.isArray(system) ? system.map((b) => b.text).join("\n") : "";
            assert.ok(sysText.includes("PACK-ACP-TAGS-E2E-MARKER"), "pack acpTags section present in outbound system");
        } finally {
            await h.close();
        }
    } finally {
        process.chdir(prevCwd);
        rmrf(dir);
    }
});
