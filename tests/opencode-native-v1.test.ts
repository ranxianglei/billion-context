import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { z } from "zod";

import {
    createV1ServerHooks,
    extractV1Windows,
    jsonSchemaToZodShape,
    rewriteV1Providers,
    type V1Config,
    type V1ProviderOptions,
} from "../src/agent/opencode-native.js";

// Minimal structural stand-in for the host's zod module: only the builders
// jsonSchemaToZodShape touches. Real zod (4.1.8) is exercised implicitly by
// the shape assertions below via the actual import.
const fakeZ = {
    any: () => ({ __fake: "any" }),
    string: () => ({ __fake: "string", describe: (d: string) => ({ __fake: "string", desc: d }) }),
    number: () => ({ __fake: "number" }),
    boolean: () => ({ __fake: "boolean" }),
    array: (item: unknown) => ({ __fake: "array", item }),
    enum: (values: [string, ...string[]]) => ({ __fake: "enum", values }),
} as unknown as typeof z;

describe("jsonSchemaToZodShape", () => {
    it("maps primitive, enum, array and unknown fields", () => {
        const shape = jsonSchemaToZodShape(
            {
                type: "object",
                properties: {
                    range: { type: "string", description: "refs" },
                    limit: { type: "number" },
                    force: { type: "boolean" },
                    mode: { type: "string", enum: ["auto", "manual"] },
                    keep: { type: "array", items: { type: "string" } },
                    nested: { type: "object", properties: { x: { type: "string" } } },
                    weird: { anyOf: [{ type: "string" }, { type: "number" }] },
                },
            },
            fakeZ,
        );
        assert.equal((shape.range as { __fake: string }).__fake, "string");
        assert.equal((shape.limit as { __fake: string }).__fake, "number");
        assert.equal((shape.force as { __fake: string }).__fake, "boolean");
        assert.deepEqual((shape.mode as { values: string[] }).values, ["auto", "manual"]);
        assert.equal((shape.keep as { item: { __fake: string } }).item.__fake, "string");
        assert.equal((shape.nested as { __fake: string }).__fake, "any");
        assert.equal((shape.weird as { __fake: string }).__fake, "any");
    });

    it("tolerates non-object schemas", () => {
        assert.deepEqual(jsonSchemaToZodShape(undefined, fakeZ), {});
        assert.deepEqual(jsonSchemaToZodShape({ type: "string" }, fakeZ), {});
        assert.deepEqual(jsonSchemaToZodShape({ properties: "nope" }, fakeZ), {});
    });

    it("produces fields the real host zod accepts in z.object()", async () => {
        // The v1 registry wraps our shape with the HOST's zod: simulate with
        // the real zod dependency (4.1.8) to prove cross-instance interop.
        const real = (await import("zod")) as typeof z;
        const shape = jsonSchemaToZodShape(
            { type: "object", properties: { range: { type: "string" }, limit: { type: "number" } } },
            real,
        );
        const parsed = real.object(shape).safeParse({ range: "m1-m5", limit: 3 });
        assert.equal(parsed.success, true);
        const bad = real.object(shape).safeParse({ range: 7, limit: 3 });
        assert.equal(bad.success, false);
    });
});

describe("rewriteV1Providers", () => {
    const origin = "http://127.0.0.1:19199";

    it("rewrites http(s) baseURLs and preserves provider entries", () => {
        const cfg: V1Config = {
            provider: {
                openai: { options: { baseURL: "https://api.openai.com/v1", apiKey: "sk-x" } },
                local: { options: { baseURL: "http://127.0.0.1:8199/v1" } },
            },
        };
        const n = rewriteV1Providers(cfg, origin);
        assert.equal(n, 2);
        const openai = (cfg.provider?.openai?.options ?? {}) as V1ProviderOptions;
        const local = (cfg.provider?.local?.options ?? {}) as V1ProviderOptions;
        assert.equal(openai.baseURL, `${origin}/bili/https://api.openai.com/v1`);
        assert.equal(local.baseURL, `${origin}/bili/http://127.0.0.1:8199/v1`);
        // untouched sibling keys
        assert.equal(openai.apiKey, "sk-x");
    });

    it("is idempotent for already-wrapped URLs", () => {
        const cfg: V1Config = {
            provider: { wrapped: { options: { baseURL: `${origin}/bili/https://api.openai.com/v1` } } },
        };
        assert.equal(rewriteV1Providers(cfg, origin), 0);
        assert.equal(cfg.provider?.wrapped?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
    });

    it("skips non-http and missing baseURLs, handles absent provider table", () => {
        const cfg: V1Config = {
            provider: {
                weird: { options: { baseURL: "file:///nope" } },
                none: { options: {} },
                empty: { options: { baseURL: "   " } },
            },
        };
        assert.equal(rewriteV1Providers(cfg, origin), 0);
        assert.deepEqual(rewriteV1Providers({}, origin), 0);
        const broken: V1Config = { provider: "not-a-table" };
        assert.equal(rewriteV1Providers(broken, origin), 0);
    });

    it("unwraps double-wrapped upstreams instead of nesting", () => {
        const cfg: V1Config = {
            provider: { x: { options: { baseURL: `http://other:1/bili/https://api.anthropic.com` } } },
        };
        const n = rewriteV1Providers(cfg, origin);
        assert.equal(n, 1);
        assert.equal(cfg.provider?.x?.options?.baseURL, `${origin}/bili/https://api.anthropic.com`);
    });

    it("disables compaction.auto while merging existing settings", () => {
        const cfg: V1Config = {
            provider: { x: { options: { baseURL: "https://api.openai.com/v1" } } },
            compaction: { threshold: 0.8 },
        };
        rewriteV1Providers(cfg, origin);
        assert.deepEqual(cfg.compaction, { threshold: 0.8, auto: false });
    });
});

describe("extractV1Windows", () => {
    it("collects finite positive limits keyed by provider/model and floors them", () => {
        const cfg: V1Config = {
            provider: {
                openai: { models: { gpt: { limit: { context: 128_000.9 } } } },
                anthropic: { models: { claude: { limit: { context: 200_000 } } } },
            },
        };
        const m = extractV1Windows(cfg);
        assert.equal(m.get("openai/gpt"), 128000);
        assert.equal(m.get("anthropic/claude"), 200000);
    });

    it("drops non-finite, non-positive and non-numeric limits", () => {
        const cfg: V1Config = {
            provider: {
                p: {
                    models: {
                        zero: { limit: { context: 0 } },
                        neg: { limit: { context: -5 } },
                        nan: { limit: { context: Number.NaN } },
                        str: { limit: { context: "big" } },
                        empty: { limit: {} },
                        nolimit: {},
                    },
                },
            },
        };
        assert.deepEqual(extractV1Windows(cfg), new Map());
    });

    it("returns an empty map for missing or broken provider tables", () => {
        assert.deepEqual(extractV1Windows({}), new Map());
        assert.deepEqual(extractV1Windows({ provider: "nope" }), new Map());
        assert.deepEqual(extractV1Windows({ provider: { p: {} } }), new Map());
        assert.deepEqual(extractV1Windows({ provider: { p: { models: "nope" } } }), new Map());
    });
});

describe("createV1ServerHooks", () => {
    const origin = "http://127.0.0.1:19199";

    function makeDeps() {
        const forwarded: Array<{ conversationId: string; tool: string; args: unknown }> = [];
        return {
            z: fakeZ,
            forward: async (o: string, conversationId: string, tool: string, args: unknown) => {
                forwarded.push({ conversationId, tool, args });
                assert.equal(o, origin);
                return `panel:${tool}`;
            },
            forwarded,
        };
    }

    it("registers /acp command, rewrites providers, stamps headers and tools when zod present", async () => {
        const deps = makeDeps();
        const hooks = createV1ServerHooks(() => origin, {}, deps);
        assert.ok(hooks.config);
        assert.ok(hooks["chat.headers"]);
        assert.ok(hooks["command.execute.before"]);
        const names = Object.keys(hooks.tool ?? {});
        assert.ok(names.includes("compress"), `tools include compress, got ${names.join(",")}`);

        const cfg: V1Config = { provider: { o: { options: { baseURL: "https://api.openai.com/v1" } } } };
        await hooks.config?.(cfg);
        assert.equal(cfg.provider?.o?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
        assert.ok(cfg.command?.acp);

        const headers: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_1" }, { headers });
        assert.equal(headers["x-bili-plugin"], "opencode");
        assert.equal(headers["x-bili-plugin-conversation"], "ses_1");

        const compress = hooks.tool?.compress;
        assert.ok(compress);
        const out = await compress.execute({ range: "m1-m2" }, { sessionID: "ses_1" });
        assert.equal(out, "panel:compress");
        assert.deepEqual(deps.forwarded, [{ conversationId: "ses_1", tool: "compress", args: { range: "m1-m2" } }]);
    });

    it("degrades to proxy mode (no headers, no tools) when zod is unavailable", async () => {
        const hooks = createV1ServerHooks(() => origin, {}, {});
        assert.equal(hooks["chat.headers"], undefined);
        assert.equal(hooks.tool, undefined);
        assert.ok(hooks.config);
        const cfg: V1Config = { provider: { o: { options: { baseURL: "https://api.openai.com/v1" } } } };
        await hooks.config?.(cfg);
        assert.equal(cfg.provider?.o?.options?.baseURL, `${origin}/bili/https://api.openai.com/v1`);
    });

    it("stamps x-bili-plugin-context-window from config-declared model limits (omits when absent)", async () => {
        const deps = makeDeps();
        const hooks = createV1ServerHooks(() => origin, {}, deps);
        assert.ok(hooks["chat.headers"]);
        const cfg: V1Config = {
            provider: {
                openai: { options: { baseURL: "https://api.openai.com/v1" }, models: { gpt: { limit: { context: 128_000.9 } } } },
            },
        };
        await hooks.config?.(cfg);
        const h1: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_w", model: { providerID: "openai", id: "gpt" } }, { headers: h1 });
        assert.equal(h1["x-bili-plugin-context-window"], "128000");
        const h2: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_w", model: { providerID: "openai", id: "other" } }, { headers: h2 });
        assert.equal(h2["x-bili-plugin-context-window"], undefined);
        const h3: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_w" }, { headers: h3 });
        assert.equal(h3["x-bili-plugin-context-window"], undefined);
    });

    it("command.execute.before only reacts to /acp", async () => {
        const deps = makeDeps();
        const hooks = createV1ServerHooks(() => origin, {}, deps);
        await hooks["command.execute.before"]?.({ command: "other", sessionID: "s" });
        // /acp path throws the sentinel after rendering — assert the sentinel shape
        await assert.rejects(
            hooks["command.execute.before"]?.({ command: "acp", sessionID: "ses_x" }),
            /__BILI_ACP_HANDLED__/,
        );
    });

    it("#1135: tool forwards follow the origin across a runtime recovery", async () => {
        const forwarded: string[] = [];
        let live: string | undefined = "http://127.0.0.1:19199";
        const deps = makeDeps();
        deps.forward = async (o: string) => {
            forwarded.push(o);
            return "ok";
        };
        const hooks = createV1ServerHooks(() => live, {}, deps);
        await hooks.tool?.compress?.execute({}, { sessionID: "s" });
        live = "http://127.0.0.1:19200";
        await hooks.tool?.compress?.execute({}, { sessionID: "s" });
        assert.deepEqual(forwarded, ["http://127.0.0.1:19199", "http://127.0.0.1:19200"]);
    });

    it("#1135: a transiently undefined origin skips stamping and degrades tools to a notice", async () => {
        let live: string | undefined;
        const hooks = createV1ServerHooks(() => live, {}, makeDeps());
        const headers: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_1" }, { headers });
        assert.equal(headers["x-bili-plugin"], undefined);
        assert.equal(headers["x-bili-plugin-conversation"], undefined);
        const out = await hooks.tool?.compress?.execute({}, { sessionID: "ses_1" });
        assert.match(out, /no live proxy/);
        live = "http://127.0.0.1:19199";
        const h2: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_1" }, { headers: h2 });
        assert.equal(h2["x-bili-plugin"], "opencode");
    });
});

// ---------------------------------------------------------------------------
// #920 legacy lane routing: absorbed opencode-acp serves pre-migration
// sessions; new sessions go to the proxy.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    callLegacyAcpConfig,
    isLegacyAcpSession,
    legacyAcpStatePath,
    type LegacyAcpModule,
} from "../src/agent/opencode-legacy.js";

function fakeLegacyModule(events: string[]): LegacyAcpModule {
    const hooks: Record<string, unknown> = {
        config: async (cfg: Record<string, unknown>) => {
            events.push(`legacy-config:${JSON.stringify(Object.keys(cfg))}`);
            cfg.permission = { deny: ["dcp_*"] };
        },
        "command.execute.before": async (input: { command: string; sessionID: string }, output?: { parts?: unknown[] }) => {
            events.push(`legacy-command:${input.command}:${input.sessionID}:${output === undefined ? "no-output" : "output"}`);
        },
        "experimental.chat.system.transform": async (input: { sessionID: string }, output?: { system?: unknown[] }) => {
            events.push(`legacy-system:${input.sessionID}:${output === undefined ? "no-output" : "output"}`);
        },
        "experimental.chat.messages.transform": async (_i: unknown, output: { messages: unknown[] }) => {
            const last = output.messages[output.messages.length - 1] as { info?: { sessionID?: string } };
            events.push(`legacy-messages:${last?.info?.sessionID}`);
        },
        "experimental.text.complete": async (input: { sessionID: string }, output?: { text?: unknown }) => {
            events.push(`legacy-text:${input.sessionID}:${output === undefined ? "no-output" : "output"}`);
        },
        tool: {
            compress: {
                description: "legacy compress",
                args: { content: { __fake: "string" } },
                execute: async (args: Record<string, unknown>, ctx: { sessionID: string }) => {
                    events.push(`legacy-compress:${ctx.sessionID}`);
                    return "legacy-compressed";
                },
            },
            acp_status: {
                description: "legacy status",
                args: {},
                execute: async (_a: Record<string, unknown>, ctx: { sessionID: string }) => {
                    events.push(`legacy-status:${ctx.sessionID}`);
                    return "legacy-status";
                },
            },
        },
    };
    return { hooks, tools: hooks.tool as LegacyAcpModule["tools"], configHook: hooks.config as LegacyAcpModule["configHook"], commandHook: hooks["command.execute.before"] as LegacyAcpModule["commandHook"], source: "/fake/opencode-acp/dist/index.js" };
}

describe("createV1ServerHooks legacy routing (#920)", () => {
    it("routes tools, headers, command and transforms per session lane", async () => {
        const events: string[] = [];
        const legacy = fakeLegacyModule(events);
        const forwarded: { sid: string; tool: string; args: unknown }[] = [];
        const hooks = createV1ServerHooks(() => "http://127.0.0.1:19999", {}, {
            z: fakeZ,
            legacy,
            isLegacy: (sid) => sid === "ses_legacy",
            forward: async (_o, sid, tool, args) => {
                forwarded.push({ sid, tool, args });
                return "proxied";
            },
            log: () => {},
        });

        // legacy session: tool executes via absorbed acp
        const r1 = await hooks.tool?.compress.execute({ content: [] }, { sessionID: "ses_legacy" });
        assert.equal(r1, "legacy-compressed");
        assert.deepEqual(forwarded, []);
        // new session: forwarded to the proxy
        const r2 = await hooks.tool?.compress.execute({ content: [] }, { sessionID: "ses_new" });
        assert.equal(r2, "proxied");
        assert.deepEqual(forwarded, [{ sid: "ses_new", tool: "compress", args: { content: [] } }]);

        // headers: legacy bypasses, new stamps plugin mode
        const h1: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_legacy" } as never, { headers: h1 });
        assert.equal(h1["x-bili-plugin"], undefined);
        assert.equal(h1["x-bili-plugin-bypass"], "1");
        const h2: Record<string, string> = {};
        await hooks["chat.headers"]?.({ sessionID: "ses_new" } as never, { headers: h2 });
        assert.equal(h2["x-bili-plugin"], "opencode");
        assert.equal(h2["x-bili-plugin-conversation"], "ses_new");
        assert.equal(h2["x-bili-plugin-bypass"], undefined);

        // /acp command: legacy session -> acp handler (no throw); new -> bili handler (throws __BILI_ACP_HANDLED__ after render)
        // output must reach the absorbed acp handler (its handlers are two-arg (input, output))
        await hooks["command.execute.before"]?.({ command: "acp", sessionID: "ses_legacy", arguments: "" }, { parts: [] });
        assert.ok(events.includes("legacy-command:acp:ses_legacy:output"));
        events.length = 0;
        await assert.rejects(hooks["command.execute.before"]?.({ command: "acp", sessionID: "ses_new", arguments: "" }), /__BILI_ACP_HANDLED__/);
        assert.equal(events.filter((e) => e.startsWith("legacy-command")).length, 0);

        // transforms gated to legacy sessions only; output reaches acp on the legacy lane
        await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_new" }, { system: [] });
        assert.equal(events.filter((e) => e.startsWith("legacy-system:ses_new")).length, 0);
        await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_legacy" }, { system: [] });
        assert.ok(events.includes("legacy-system:ses_legacy:output"));
        await hooks["experimental.chat.messages.transform"]?.({}, { messages: [{ role: "user" }, { role: "assistant", info: { sessionID: "ses_new" } }] });
        assert.equal(events.filter((e) => e === "legacy-messages:ses_new").length, 0);
        await hooks["experimental.chat.messages.transform"]?.({}, { messages: [{ info: { sessionID: "ses_legacy" } }] });
        assert.ok(events.includes("legacy-messages:ses_legacy"));
        await hooks["experimental.text.complete"]?.({ sessionID: "ses_new" }, { text: "" });
        await hooks["experimental.text.complete"]?.({ sessionID: "ses_legacy" }, { text: "" });
        assert.equal(events.filter((e) => e.startsWith("legacy-text:ses_new")).length, 0);
        assert.ok(events.includes("legacy-text:ses_legacy:output"));
    });

    it("/acp-cache on a legacy session renders an unavailable notice without touching the absorbed acp (#1146)", async () => {
        const events: string[] = [];
        const prompts: Array<{ sid: string; text: string }> = [];
        const ctx = {
            client: {
                session: {
                    prompt: async ({ path, body }: { path: { id: string }; body: { noReply: boolean; parts: Array<{ text: string }> } }) => {
                        prompts.push({ sid: path.id, text: body.parts[0].text });
                    },
                },
            },
        };
        const hooks = createV1ServerHooks(() => "http://127.0.0.1:19999", ctx, {
            z: fakeZ,
            legacy: fakeLegacyModule(events),
            isLegacy: (sid) => sid === "ses_legacy",
            forward: async () => "proxied",
            log: () => {},
        });
        await assert.rejects(
            hooks["command.execute.before"]?.({ command: "acp-cache", sessionID: "ses_legacy" }),
            /__BILI_ACP_HANDLED__/,
        );
        assert.equal(prompts.length, 1);
        assert.match(prompts[0].text, /unavailable for this legacy DCP session/);
        assert.equal(events.filter((e) => e.startsWith("legacy-command")).length, 0);
    });

    it("config hook hides providers from absorbed acp and still rewrites", async () => {
        const events: string[] = [];
        const legacy = fakeLegacyModule(events);
        const cfg: V1Config = {
            provider: { testprov: { options: { baseURL: "http://127.0.0.1:19998/v1" } } },
        };
        await createV1ServerHooks(() => "http://127.0.0.1:19999", {}, {
            z: fakeZ,
            legacy,
            isLegacy: () => false,
            forward: async () => "proxied",
            log: () => {},
        }).config?.(cfg);
        // legacy saw no provider key (shadow had provider: undefined)
        assert.ok(events.some((e) => e.startsWith("legacy-config:") && !e.includes("provider")));
        // its permission write survived the merge
        assert.deepEqual(cfg.permission, { deny: ["dcp_*"] });
        // and the rewrite still happened
        assert.equal((cfg.provider.testprov?.options as V1ProviderOptions).baseURL, "http://127.0.0.1:19999/bili/http://127.0.0.1:19998/v1");
    });
});

describe("legacy session state file (#920)", () => {
    it("detects legacy sessions by acp state file and sanitizes ids", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-legacy-state-"));
        process.env.XDG_DATA_HOME = path.join(home, "data");
        try {
            fs.mkdirSync(path.dirname(legacyAcpStatePath("ses_old")), { recursive: true });
            fs.writeFileSync(legacyAcpStatePath("ses_old"), "{}");
            assert.equal(isLegacyAcpSession("ses_old"), true);
            assert.equal(isLegacyAcpSession("ses_fresh"), false);
            assert.equal(isLegacyAcpSession(undefined), false);
            assert.equal(isLegacyAcpSession(""), false);
            assert.equal(isLegacyAcpSession("../../etc"), false);
        } finally {
            delete process.env.XDG_DATA_HOME;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it("callLegacyAcpConfig merges only owned top-level keys", async () => {
        const cfg: Record<string, unknown> = { provider: { p: 1 }, agent: { keep: true } };
        await callLegacyAcpConfig(async (shadow) => {
            assert.equal((shadow as { provider?: unknown }).provider, undefined);
            shadow.experimental = { replaced: true }; // reference change → owned
            (shadow as { permission?: unknown }).permission = { deny: ["x"] };
        }, cfg);
        assert.equal((cfg.provider as { p?: number }).p, 1); // untouched
        assert.deepEqual(cfg.agent, { keep: true }); // not an owned key
        assert.deepEqual(cfg.experimental, { replaced: true });
        assert.deepEqual(cfg.permission, { deny: ["x"] });
    });
});

import http from "node:http";
import { once } from "node:events";

describe("derived-session inheritance report (#1362)", () => {
    type Register = { conversationId?: string; agent?: string; identity?: boolean; parentConversationId?: string };

    async function startProxy(failFirst = 0): Promise<{ origin: string; registers: Register[]; close(): Promise<void> }> {
        const registers: Register[] = [];
        let failuresLeft = failFirst;
        const server = http.createServer((req, res) => {
            if (req.url === "/__bili/plugin/register" && req.method === "POST") {
                let body = "";
                req.on("data", (c) => (body += c));
                req.on("end", () => {
                    registers.push(JSON.parse(body));
                    if (failuresLeft > 0) {
                        failuresLeft -= 1;
                        res.writeHead(500);
                        res.end("{}");
                    } else {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ ok: true }));
                    }
                });
            } else {
                res.writeHead(404);
                res.end("{}");
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        return { origin, registers, close: () => new Promise<void>((r) => server.close(() => r())) };
    }

    async function waitFor(label: string, pred: () => boolean, timeoutMs = 5000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.ok(pred(), `timeout waiting for ${label}`);
    }

    function v1Deps(extra: Record<string, unknown> = {}) {
        return { z: fakeZ, forward: async () => "", ...extra };
    }

    it("reports a child's parentID once through the identity register channel", async () => {
        const proxy = await startProxy();
        try {
            let gets = 0;
            const client = { session: { get: async () => { gets += 1; return { data: { id: "ses_child", parentID: "ses_parent" } }; } } };
            const hooks = createV1ServerHooks(() => proxy.origin, { client }, v1Deps());
            const headers: Record<string, string> = {};
            await hooks["chat.headers"]?.({ sessionID: "ses_child" }, { headers });
            assert.equal(headers["x-bili-plugin-conversation"], "ses_child");
            await waitFor("register", () => proxy.registers.length >= 1);
            assert.deepEqual(proxy.registers[0], { conversationId: "ses_child", agent: "opencode", identity: true, parentConversationId: "ses_parent" });
            await hooks["chat.headers"]?.({ sessionID: "ses_child" }, { headers: {} });
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(proxy.registers.length, 1, "no repeat register");
            assert.equal(gets, 1, "SDK lookup cached per session");
        } finally {
            await proxy.close();
        }
    });

    it("root sessions (no parentID) send nothing extra", async () => {
        const proxy = await startProxy();
        try {
            const client = { session: { get: async () => ({ data: { id: "ses_root" } }) } };
            const hooks = createV1ServerHooks(() => proxy.origin, { client }, v1Deps());
            await hooks["chat.headers"]?.({ sessionID: "ses_root" }, { headers: {} });
            await hooks["chat.headers"]?.({ sessionID: "ses_root" }, { headers: {} });
            await new Promise((r) => setTimeout(r, 80));
            assert.deepEqual(proxy.registers, []);
        } finally {
            await proxy.close();
        }
    });

    it("self-parent and absent SDK seam are inert", async () => {
        const proxy = await startProxy();
        try {
            const selfParent = createV1ServerHooks(() => proxy.origin, { client: { session: { get: async () => ({ data: { id: "ses_self", parentID: "ses_self" } }) } } }, v1Deps());
            await selfParent["chat.headers"]?.({ sessionID: "ses_self" }, { headers: {} });
            await new Promise((r) => setTimeout(r, 80));
            assert.deepEqual(proxy.registers, []);
            const bare = createV1ServerHooks(() => proxy.origin, {}, v1Deps());
            await bare["chat.headers"]?.({ sessionID: "ses_bare" }, { headers: {} });
            await new Promise((r) => setTimeout(r, 80));
            assert.deepEqual(proxy.registers, []);
        } finally {
            await proxy.close();
        }
    });

    it("a failed register retries after the cooldown window", async () => {
        const proxy = await startProxy(1);
        try {
            const client = { session: { get: async () => ({ data: { id: "ses_c", parentID: "ses_p" } }) } };
            const hooks = createV1ServerHooks(() => proxy.origin, { client }, v1Deps({ derivedRetryMs: 60 }));
            await hooks["chat.headers"]?.({ sessionID: "ses_c" }, { headers: {} });
            await waitFor("failed register attempt", () => proxy.registers.length >= 1);
            await hooks["chat.headers"]?.({ sessionID: "ses_c" }, { headers: {} });
            assert.equal(proxy.registers.length, 1, "throttled during cooldown");
            await new Promise((r) => setTimeout(r, 100));
            await hooks["chat.headers"]?.({ sessionID: "ses_c" }, { headers: {} });
            await waitFor("retry register", () => proxy.registers.length >= 2);
            assert.deepEqual(proxy.registers[1], { conversationId: "ses_c", agent: "opencode", identity: true, parentConversationId: "ses_p" });
        } finally {
            await proxy.close();
        }
    });

    it("an SDK failure backs off, then recovers on a later request", async () => {
        const proxy = await startProxy();
        try {
            let failNext = true;
            const client = { session: { get: async () => { const fail = failNext; failNext = false; if (fail) throw new Error("sdk down"); return { data: { id: "ses_s", parentID: "ses_sp" } }; } } };
            const hooks = createV1ServerHooks(() => proxy.origin, { client }, v1Deps({ derivedRetryMs: 60 }));
            await hooks["chat.headers"]?.({ sessionID: "ses_s" }, { headers: {} });
            await new Promise((r) => setTimeout(r, 30));
            assert.deepEqual(proxy.registers, [], "no register while the SDK is down");
            await new Promise((r) => setTimeout(r, 60));
            await hooks["chat.headers"]?.({ sessionID: "ses_s" }, { headers: {} });
            await waitFor("recovered register", () => proxy.registers.length >= 1);
            assert.equal(proxy.registers[0]?.parentConversationId, "ses_sp");
        } finally {
            await proxy.close();
        }
    });

    it("legacy sessions never trigger derivation reporting", async () => {
        const proxy = await startProxy();
        try {
            let gets = 0;
            const client = { session: { get: async () => { gets += 1; return { data: { parentID: "ses_p" } }; } } };
            const hooks = createV1ServerHooks(() => proxy.origin, { client }, v1Deps({ isLegacy: () => true }));
            const headers: Record<string, string> = {};
            await hooks["chat.headers"]?.({ sessionID: "ses_legacy" }, { headers });
            assert.equal(headers["x-bili-plugin-bypass"], "1");
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(gets, 0, "session.get never consulted for legacy traffic");
            assert.deepEqual(proxy.registers, []);
        } finally {
            await proxy.close();
        }
    });
});
