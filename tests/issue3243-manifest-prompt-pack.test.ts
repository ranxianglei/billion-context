// #3243 regression: the plugin manifest (/__bili/plugin/manifest) must serve
// the pack surface's tool descriptions. Before the fix handlePluginManifest
// built every tool array from kernel constants and never applied toolPrompts —
// a configured compress.promptPack shaped each request's system prompt (proxy
// AND plugin mode) while registered native-lane tools (pi/omp/dsh/opencode/MCP)
// always saw kernel-default descriptions. The manifest resolves the surface
// from the GLOBAL compress settings only (#1192 conservative rule: hosts fetch
// it before any request arrives, no route/model context); route/model-level
// promptPack still shapes per-request system prompts but never the manifest.
// Expectations come from the installed kernel's builtin lean pack via the SAME
// resolver the server uses, so this pins the wiring, not any wording.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { resolveCompressSurface } from "../src/compress-settings.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { CompressSettings, ProxyOptions } from "../src/config.ts";

type GlobalCompress = CompressSettings & { injectTool?: boolean; injectNudge?: boolean };
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function leanToolPrompts() {
    const tp = resolveCompressSurface({ promptPack: "lean" }).toolPrompts;
    assert.ok(tp && Object.keys(tp).length > 0, "builtin lean pack resolves with non-empty toolPrompts");
    assert.ok(tp.compress?.description, "lean compress carries a description override");
    assert.ok(tp.compress?.paramDescriptions?.content, "lean compress carries a content paramDescription");
    return tp;
}

type Harness = { proxyPort: number; close(): Promise<void> };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

async function startHarness(globalCompress: GlobalCompress, routeCompress?: CompressSettings): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { compress: routeCompress } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: globalCompress,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await listen(proxy);
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        close: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

async function fetchManifest(h: Harness): Promise<Record<string, unknown[]>> {
    const res = await fetch(`http://127.0.0.1:${h.proxyPort}/__bili/plugin/manifest`);
    assert.equal(res.status, 200, "manifest endpoint reachable on loopback");
    const doc = (await res.json()) as { ok: boolean; tools: Record<string, unknown[]> };
    assert.ok(doc.ok, "manifest reports ok");
    return doc.tools;
}

function findTool(tools: unknown[], name: string): Record<string, any> {
    const t = tools.find((x) => {
        const o = x as Record<string, any>;
        return o?.name === name || o?.function?.name === name;
    });
    assert.ok(t, `${name} advertised`);
    return t as Record<string, any>;
}

function descriptionOf(t: Record<string, any>): string {
    return typeof t.description === "string" ? t.description : t.function.description;
}

function parametersOf(t: Record<string, any>): Record<string, any> | undefined {
    return t.input_schema ?? t.parameters ?? t.function?.parameters;
}

const WIRES = [["anthropic", ACP_TOOLS_ANTHROPIC], ["openai", ACP_TOOLS_OPENAI], ["responses", ACP_TOOLS_RESPONSES]] as const;

test("#3243: global promptPack reaches plugin-manifest tool descriptions on all three wires", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, promptPack: "lean" });
    try {
        const tools = await fetchManifest(h);
        const tp = leanToolPrompts();
        for (const [wire, defaults] of WIRES) {
            for (const [name, overrides] of Object.entries(tp)) {
                const tool = findTool(tools[wire], name);
                if (overrides.description !== undefined) {
                    // #3252 appends the calling-convention binding note AFTER the pack
                    // description — the pack text must be the PREFIX, not the whole string.
                    assert.ok(descriptionOf(tool)?.startsWith(overrides.description), `${wire}.${name} description from lean pack`);
                }
            }
            // CCR is off in this rig, so decompress here is the NO_RANGE variant —
            // the pack override must land on it too (matched by tool name).
            const compress = findTool(tools[wire], "compress");
            const kernelDefault = (defaults as readonly Record<string, any>[]).find((d) => d.name === "compress" || d.function?.name === "compress")!;
            const defaultDesc = typeof kernelDefault.description === "string" ? kernelDefault.description : kernelDefault.function.description;
            assert.notEqual(descriptionOf(compress), defaultDesc, `${wire}.compress not the kernel default`);
            assert.equal(parametersOf(compress)?.properties?.content?.description, tp.compress.paramDescriptions?.content, `${wire}.compress paramDescriptions applied`);
        }
    } finally {
        await h.close();
    }
});

test("#3243: no promptPack — manifest keeps kernel-default compress descriptions", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true });
    try {
        const tools = await fetchManifest(h);
        for (const [wire, defaults] of WIRES) {
            const compress = findTool(tools[wire], "compress");
            const kernelDefault = (defaults as readonly Record<string, any>[]).find((d) => d.name === "compress" || d.function?.name === "compress")!;
            const defaultDesc = typeof kernelDefault.description === "string" ? kernelDefault.description : kernelDefault.function.description;
            // #3252: the binding note rides along after the kernel default text.
            assert.ok(descriptionOf(compress)?.startsWith(defaultDesc), `${wire}.compress stays kernel default`);
        }
    } finally {
        await h.close();
    }
});

test("#3243: route-level promptPack never leaks into the manifest (#1192 conservative boundary)", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true }, { promptPack: "lean" });
    try {
        const tools = await fetchManifest(h);
        for (const [wire, defaults] of WIRES) {
            const compress = findTool(tools[wire], "compress");
            const kernelDefault = (defaults as readonly Record<string, any>[]).find((d) => d.name === "compress" || d.function?.name === "compress")!;
            const defaultDesc = typeof kernelDefault.description === "string" ? kernelDefault.description : kernelDefault.function.description;
            assert.ok(descriptionOf(compress)?.startsWith(defaultDesc), `${wire}.compress unaffected by route-level pack (#3252 binding note appended)`);
        }
    } finally {
        await h.close();
    }
});
