// Unified wire-contract gate (#1304 item 3). Consolidates:
//   - tests/kernel-pin-wire-schema.test.ts (#1302, kernel-export layer)
//   - tests/issue1299-anthropic-top-level.test.ts (#1301, bili served-surface layer)
// into one module with four layers:
//   A. kernel exports — every tool constant the pinned acp-kernel ships, per wire
//   B. bili surfaces — everything bili itself builds/serves (BILI_* tools, synthesized
//      variants, retrieveToolsFor, IMAGE_FULL_TOOL_GOOGLE)
//   C. plugin manifest — what handlePluginManifest advertises (default + opt-in configs)
//   D. live forward matrix — scripted client request -> proxy -> validation-parity fake
//      upstream, one lane per protocol (item 1 + item 4 phase (a)): the forwarded body
//      must be ACCEPTED by the fake (it enforces the real upstream's strictest known
//      validation) and must carry exactly the tools bili intends to serve.
//
// Rule provenance lives in WIRE_RULES (tests/wire-contract-fakes.ts). Institutional
// rule (AGENTS.md "Wire-constraint ledger"): every new upstream rejection or documented
// constraint becomes a permanent entry there + a validator clause in THIS module,
// inside the fixing PR. The ledger only grows.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import * as K from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import {
    BILI_ACP_TOOLS_ANTHROPIC,
    BILI_ACP_TOOLS_OPENAI,
    BILI_ACP_TOOLS_RESPONSES,
    BILI_ACP_TOOLS_GOOGLE,
    BILI_ACP_READONLY_TOOLS_RESPONSES,
    BILI_SEARCH_CONTEXT_TOOL,
    BILI_SEARCH_CONTEXT_TOOL_OPENAI,
    BILI_SEARCH_CONTEXT_TOOL_RESPONSES,
    BILI_SEARCH_CONTEXT_TOOL_GOOGLE,
    BILI_DECOMPRESS_TOOL,
    BILI_DECOMPRESS_TOOL_OPENAI,
    BILI_DECOMPRESS_TOOL_RESPONSES,
    BILI_DECOMPRESS_TOOL_GOOGLE,
    ABSORB_TOOL_RESPONSES,
    RULE_TOOL,
    RULE_TOOL_OPENAI,
    RULE_TOOL_RESPONSES,
    RULE_TOOL_GOOGLE,
    retrieveToolsFor,
    IMAGE_FULL_TOOL_GOOGLE,
} from "../src/compress-tool.ts";
import { WIRE_RULES, VALIDATORS, startFakeUpstream, type Wire } from "./wire-contract-fakes.ts";

type ToolShape = Record<string, unknown>;

function syntheticBody(wire: Wire, tool: unknown): Record<string, unknown> {
    if (wire === "google") return { tools: [{ functionDeclarations: [tool] }] };
    return { tools: [tool] };
}

function toolNameOf(wire: Wire, t: ToolShape): string | undefined {
    if (wire === "openai-chat") {
        const fn = t.function;
        return fn && typeof fn === "object" ? (fn as ToolShape).name as string | undefined : undefined;
    }
    return typeof t.name === "string" ? t.name : undefined;
}

const COMPRESS_FORM_PROPS = ["topic", "content", "startId", "endId", "startRef", "endRef", "summary"];

function assertCompressFormsKept(tool: ToolShape | undefined, source: string): void {
    assert.ok(tool, `${source}: compress tool present`);
    const schema = tool.input_schema as ToolShape | undefined;
    const props = schema?.properties as ToolShape | undefined;
    assert.ok(props, `${source}:compress: properties kept`);
    for (const p of COMPRESS_FORM_PROPS) {
        assert.ok(p in props, `${source}:compress: advertised form property "${p}" kept`);
    }
}

// ---------------------------------------------------------------------------
// Ledger self-check: every rule must have a live enforcement clause.
// ---------------------------------------------------------------------------

test("wire-contract ledger: every rule has a live enforcement clause", () => {
    const probes: Record<Wire, unknown[]> = {
        anthropic: [
            { tools: [{ name: "t", input_schema: { type: "object", properties: {}, anyOf: [] } }] },
            { tools: [{ name: "t", input_schema: { properties: {} } }] },
            { tools: [{ name: "bad name!", input_schema: { type: "object", properties: {} } }] },
            { model: "m", max_tokens: 1, messages: [], prompt_cache_key: "sess" },
        ],
        "openai-chat": [
            { tools: [{ type: "function", function: { name: "x".repeat(65), parameters: { type: "object", properties: {} } } }] },
            { tools: [{ type: "function", function: { name: "ok", parameters: { anyOf: [] } } }] },
        ],
        responses: [
            { tools: [{ type: "function", name: "bad name", parameters: { type: "object", properties: {} } }] },
            { tools: [{ type: "function", name: "ok", parameters: { type: "array" } }] },
            { tools: [{ type: "function", name: "ok", parameters: { type: "object", properties: {}, anyOf: [] } }] },
        ],
        google: [
            { tools: [{ functionDeclarations: [{ name: "bad-name", parameters: { type: "object", properties: {} } }] }] },
            { tools: [{ functionDeclarations: [{ name: "ok", parameters: { anyOf: [] } }] }] },
        ],
    };
    for (const rule of WIRE_RULES) {
        const enforced = probes[rule.wire].some((body) =>
            VALIDATORS[rule.wire](body).some((v) => v.startsWith(rule.id)),
        );
        assert.ok(enforced, `rule ${rule.id} (${rule.summary}) has no live enforcement clause in the fakes`);
    }
});

// ---------------------------------------------------------------------------
// Layer A: kernel exports (supersedes tests/kernel-pin-wire-schema.test.ts #1302)
// ---------------------------------------------------------------------------

const KERNEL_ARRAYS: Array<[string, Wire]> = [
    ["ACP_TOOLS_ANTHROPIC", "anthropic"],
    ["ACP_TOOLS_OPENAI", "openai-chat"],
    ["ACP_TOOLS_RESPONSES", "responses"],
    ["ACP_READONLY_TOOLS_RESPONSES", "responses"],
    ["ACP_TOOLS_GOOGLE", "google"],
];

const KERNEL_INDIVIDUALS: Array<[string, Wire]> = [
    ["COMPRESS_TOOL", "anthropic"], ["COMPRESS_TOOL_OPENAI", "openai-chat"], ["COMPRESS_TOOL_RESPONSES", "responses"], ["COMPRESS_TOOL_GOOGLE", "google"],
    ["DECOMPRESS_TOOL", "anthropic"], ["DECOMPRESS_TOOL_OPENAI", "openai-chat"], ["DECOMPRESS_TOOL_RESPONSES", "responses"], ["DECOMPRESS_TOOL_GOOGLE", "google"],
    ["SEARCH_CONTEXT_TOOL", "anthropic"], ["SEARCH_CONTEXT_TOOL_OPENAI", "openai-chat"], ["SEARCH_CONTEXT_TOOL_RESPONSES", "responses"], ["SEARCH_CONTEXT_TOOL_GOOGLE", "google"],
    ["ACP_STATUS_TOOL", "anthropic"], ["ACP_STATUS_TOOL_OPENAI", "openai-chat"], ["ACP_STATUS_TOOL_RESPONSES", "responses"], ["ACP_STATUS_TOOL_GOOGLE", "google"],
    ["ACP_CACHE_TOOL", "anthropic"], ["ACP_CACHE_TOOL_OPENAI", "openai-chat"], ["ACP_CACHE_TOOL_RESPONSES", "responses"],
    // opt-in tools the kernel ships individually (host-registered)
    ["ABSORB_TOOL", "anthropic"], ["ABSORB_TOOL_OPENAI", "openai-chat"], ["ABSORB_TOOL_GOOGLE", "google"],
    ["IMAGE_FULL_TOOL", "anthropic"], ["IMAGE_FULL_TOOL_OPENAI", "openai-chat"], ["IMAGE_FULL_TOOL_RESPONSES", "responses"],
    ["RETRIEVE_TOOL", "anthropic"], ["RETRIEVE_TOOL_OPENAI", "openai-chat"], ["RETRIEVE_TOOL_RESPONSES", "responses"],
];

test("wire-contract A: every kernel-exported tool passes its wire validator", () => {
    const failures: string[] = [];
    for (const [constName, wire] of KERNEL_ARRAYS) {
        const arr = (K as Record<string, unknown>)[constName];
        assert.ok(Array.isArray(arr), `${constName}: expected array`);
        for (const t of arr as ToolShape[]) {
            failures.push(...VALIDATORS[wire](syntheticBody(wire, t)).map((s) => `${constName}[${t.name ?? "?"}]: ${s}`));
        }
    }
    for (const [constName, wire] of KERNEL_INDIVIDUALS) {
        const t = (K as Record<string, unknown>)[constName] as ToolShape;
        assert.ok(t && typeof t === "object", `${constName}: expected tool object`);
        failures.push(...VALIDATORS[wire](syntheticBody(wire, t)).map((s) => `${constName}: ${s}`));
    }
    assert.equal(failures.length, 0, `pinned kernel serves wire-illegal tool schemas:\n${failures.join("\n")}\nDo NOT pin this kernel version — fix the kernel first.`);
});

// ---------------------------------------------------------------------------
// Layer B: bili surfaces (supersedes tests/issue1299-anthropic-top-level.test.ts #1301)
// ---------------------------------------------------------------------------

const BILI_ARRAYS: Array<[string, Wire]> = [
    ["BILI_ACP_TOOLS_ANTHROPIC", "anthropic"],
    ["BILI_ACP_TOOLS_OPENAI", "openai-chat"],
    ["BILI_ACP_TOOLS_RESPONSES", "responses"],
    ["BILI_ACP_TOOLS_GOOGLE", "google"],
    ["BILI_ACP_READONLY_TOOLS_RESPONSES", "responses"],
];

const BILI_INDIVIDUALS: Array<[string, Wire]> = [
    ["BILI_SEARCH_CONTEXT_TOOL", "anthropic"], ["BILI_SEARCH_CONTEXT_TOOL_OPENAI", "openai-chat"], ["BILI_SEARCH_CONTEXT_TOOL_RESPONSES", "responses"], ["BILI_SEARCH_CONTEXT_TOOL_GOOGLE", "google"],
    ["BILI_DECOMPRESS_TOOL", "anthropic"], ["BILI_DECOMPRESS_TOOL_OPENAI", "openai-chat"], ["BILI_DECOMPRESS_TOOL_RESPONSES", "responses"], ["BILI_DECOMPRESS_TOOL_GOOGLE", "google"],
    ["ABSORB_TOOL_RESPONSES", "responses"],
    ["RULE_TOOL", "anthropic"], ["RULE_TOOL_OPENAI", "openai-chat"], ["RULE_TOOL_RESPONSES", "responses"], ["RULE_TOOL_GOOGLE", "google"],
    ["IMAGE_FULL_TOOL_GOOGLE", "google"],
];

const BILI_CONSTANTS: Record<string, unknown> = {
    BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_READONLY_TOOLS_RESPONSES,
    BILI_SEARCH_CONTEXT_TOOL, BILI_SEARCH_CONTEXT_TOOL_OPENAI, BILI_SEARCH_CONTEXT_TOOL_RESPONSES, BILI_SEARCH_CONTEXT_TOOL_GOOGLE,
    BILI_DECOMPRESS_TOOL, BILI_DECOMPRESS_TOOL_OPENAI, BILI_DECOMPRESS_TOOL_RESPONSES, BILI_DECOMPRESS_TOOL_GOOGLE,
    ABSORB_TOOL_RESPONSES, RULE_TOOL, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, RULE_TOOL_GOOGLE, IMAGE_FULL_TOOL_GOOGLE,
    RETRIEVE_TOOLS: retrieveToolsFor("acp_retrieve"),
};

test("wire-contract B: every bili-built tool surface passes its wire validator", () => {
    const failures: string[] = [];
    for (const [constName, wire] of BILI_ARRAYS) {
        const arr = BILI_CONSTANTS[constName] as ToolShape[];
        for (const t of arr) {
            failures.push(...VALIDATORS[wire](syntheticBody(wire, t)).map((s) => `${constName}[${toolNameOf(wire, t) ?? "?"}]: ${s}`));
        }
    }
    for (const [constName, wire] of BILI_INDIVIDUALS) {
        const t = BILI_CONSTANTS[constName] as ToolShape;
        failures.push(...VALIDATORS[wire](syntheticBody(wire, t)).map((s) => `${constName}: ${s}`));
    }
    // retrieveToolsFor keys are {anthropic, openai, responses, google} — map onto this module's Wire names.
    const r = BILI_CONSTANTS.RETRIEVE_TOOLS as { anthropic: ToolShape; openai: ToolShape; responses: ToolShape; google: ToolShape };
    const retrieve: [Wire, ToolShape][] = [["anthropic", r.anthropic], ["openai-chat", r.openai], ["responses", r.responses], ["google", r.google]];
    for (const [wire, t] of retrieve) {
        failures.push(...VALIDATORS[wire](syntheticBody(wire, t)).map((s) => `retrieveToolsFor(acp_retrieve).${wire}: ${s}`));
    }
    assert.equal(failures.length, 0, `bili serves wire-illegal tool schemas:\n${failures.join("\n")}`);
});

test("wire-contract B: compress keeps every advertised call-form property", () => {
    const compress = BILI_ACP_TOOLS_ANTHROPIC.find((t) => t.name === "compress") as ToolShape;
    assertCompressFormsKept(compress, "served");
});

// ---------------------------------------------------------------------------
// Layer C: plugin manifest (the MCP bridge's verbatim schema source)
// ---------------------------------------------------------------------------

interface ManifestDoc {
    ok: boolean;
    protocolVersion: number;
    version: string;
    toolNames: string[];
    tools: { anthropic: ToolShape[]; openai: ToolShape[]; responses: ToolShape[] };
}

function captureManifest(config: Parameters<typeof handlePluginManifest>[1]): ManifestDoc {
    let raw: unknown;
    const res = {
        writeHead(): void { /* noop */ },
        end(b: unknown): void { raw = b; },
    } as unknown as http.ServerResponse;
    handlePluginManifest(res, config);
    return JSON.parse(String(raw)) as ManifestDoc;
}

function assertManifestLegal(m: ManifestDoc, label: string): void {
    assert.equal(m.ok, true, `${label}: manifest ok`);
    const failures: string[] = [];
    for (const t of m.tools.anthropic) failures.push(...VALIDATORS.anthropic(syntheticBody("anthropic", t)).map((s) => `manifest[${label}].anthropic[${t.name ?? "?"}]: ${s}`));
    for (const t of m.tools.openai) failures.push(...VALIDATORS["openai-chat"](syntheticBody("openai-chat", t)).map((s) => `manifest[${label}].openai[${toolNameOf("openai-chat", t) ?? "?"}]: ${s}`));
    for (const t of m.tools.responses) failures.push(...VALIDATORS.responses(syntheticBody("responses", t)).map((s) => `manifest[${label}].responses[${t.name ?? "?"}]: ${s}`));
    assert.equal(failures.length, 0, failures.join("\n"));
}

test("wire-contract C: default manifest serves only legal base tools", () => {
    const m = captureManifest(defaultConfig(100_000));
    assertManifestLegal(m, "default");
    const anthNames = new Set(m.tools.anthropic.map((t) => t.name));
    for (const n of BILI_ACP_TOOLS_ANTHROPIC.map((t) => t.name)) assert.ok(anthNames.has(n), `default manifest: base tool ${n} present`);
    for (const optIn of ["absorb", "acp_rule", "acp_retrieve"]) assert.ok(!anthNames.has(optIn), `default manifest: ${optIn} absent when disabled (#1192)`);
    assertCompressFormsKept(m.tools.anthropic.find((t) => t.name === "compress") as ToolShape, "manifest-default");
});

test("wire-contract C: opt-in manifest advertises absorb/acp_rule/acp_retrieve legally", () => {
    const config = { ...defaultConfig(100_000), absorb: { ...K.DEFAULT_ABSORB_CONFIG, enabled: true }, rules: { enabled: true }, ccr: { ...K.DEFAULT_CCR_CONFIG, enabled: true } };
    const m = captureManifest(config);
    assertManifestLegal(m, "optin");
    const anthNames = new Set(m.tools.anthropic.map((t) => t.name));
    const openAiNames = new Set(m.tools.openai.map((t) => toolNameOf("openai-chat", t)));
    const respNames = new Set(m.tools.responses.map((t) => t.name));
    for (const n of ["absorb", "acp_rule", "acp_retrieve"]) {
        assert.ok(anthNames.has(n), `optin manifest: anthropic advertises ${n}`);
        assert.ok(openAiNames.has(n), `optin manifest: openai advertises ${n}`);
    }
    for (const n of ["absorb", "acp_rule"]) assert.ok(respNames.has(n), `optin manifest: responses advertises ${n}`);
    assert.ok(!respNames.has("acp_retrieve"), "optin manifest: responses does NOT advertise acp_retrieve (#1271)");
    assertCompressFormsKept(m.tools.anthropic.find((t) => t.name === "compress") as ToolShape, "manifest-optin");
});

// ---------------------------------------------------------------------------
// Layer D: live forward matrix — 4 protocols x proxy mode (items 1 + 4a)
// ---------------------------------------------------------------------------

interface Lane {
    wire: Wire;
    model: string;
    path: string;
    clientBody: Record<string, unknown>;
    clientToolNames: string[];
}

const LANES: Lane[] = [
    {
        wire: "anthropic",
        model: "claude-test",
        path: "/v1/messages",
        clientBody: {
            model: "claude-test",
            max_tokens: 1024,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
            tools: [{ name: "client_tool", description: "client-owned", input_schema: { type: "object", properties: {} } }],
        },
        clientToolNames: ["client_tool"],
    },
    {
        wire: "openai-chat",
        model: "gpt-test",
        path: "/v1/chat/completions",
        clientBody: { model: "gpt-test", max_tokens: 64_000, stream: true, messages: [{ role: "user", content: "hello" }] },
        clientToolNames: [],
    },
    {
        wire: "responses",
        model: "resp-test",
        path: "/v1/responses",
        clientBody: {
            model: "resp-test",
            stream: true,
            instructions: "wire-contract smoke",
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
        clientToolNames: [],
    },
    {
        wire: "google",
        model: "gemini-test",
        path: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
        clientBody: { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 4096 } },
        clientToolNames: [],
    },
];

const BASE_EXPECTED: Record<Wire, string[]> = {
    anthropic: BILI_ACP_TOOLS_ANTHROPIC.map((t) => t.name),
    "openai-chat": BILI_ACP_TOOLS_OPENAI.map((t) => t.function.name),
    responses: BILI_ACP_TOOLS_RESPONSES.map((t) => t.name),
    google: BILI_ACP_TOOLS_GOOGLE.map((t) => t.name),
};

function extractForwardedNames(wire: Wire, body: unknown): string[] {
    const b = body as ToolShape;
    if (!Array.isArray(b.tools)) return [];
    if (wire === "google") {
        const out: string[] = [];
        for (const entry of b.tools as ToolShape[]) {
            const decls = entry.functionDeclarations;
            if (!Array.isArray(decls)) continue;
            for (const d of decls) out.push(typeof (d as { name?: unknown }).name === "string" ? (d as { name: string }).name : "");
        }
        return out;
    }
    return (b.tools as ToolShape[]).map((t) => toolNameOf(wire, t)).filter((n): n is string => typeof n === "string");
}

interface Rig {
    proxyUrl: string;
    close(): Promise<void>;
}

// Opt-in features arm through bili's CompressSettings namespace (`opts.compress`),
// resolved per request by resolveCompress + applyCompressSettings — not through
// the raw kernelConfig (server.ts stamps effectiveCcr from compressCfg.ccr only).
async function startRig(fakeUrl: string, model: string, compressOverrides: Record<string, unknown>): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: fakeUrl,
        routes: { [fakeUrl]: { models: { [model]: { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: `http://127.0.0.1:${port}/bili/${fakeUrl}`,
        close: () => new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve()))),
    };
}

for (const lane of LANES) {
    test(`wire-contract D: proxied ${lane.wire} turn is accepted by the validation-parity fake`, async () => {
        const fake = await startFakeUpstream(lane.wire);
        let rig: Rig | undefined;
        try {
            rig = await startRig(fake.url, lane.model, {});
            const res = await fetch(`${rig.proxyUrl}${lane.path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": `wc-${lane.wire}` },
                body: JSON.stringify(lane.clientBody),
            });
            assert.equal(res.status, 200, `${lane.wire}: turn completed (a fake-upstream 400 would relay here)`);
            const text = await res.text();
            assert.ok(text.includes("ok"), `${lane.wire}: reply round-tripped`);

            assert.equal(fake.requests.length, 1, `${lane.wire}: exactly one upstream request`);
            assert.equal(fake.violations.length, 0, `${lane.wire}: fake upstream rejected the forwarded body:\n${fake.violations.join("\n")}`);

            const fwdNames = extractForwardedNames(lane.wire, fake.requests[0].body);
            const expected = [...BASE_EXPECTED[lane.wire], ...lane.clientToolNames].sort();
            assert.deepEqual(fwdNames.sort(), expected, `${lane.wire}: forwarded tool set is exactly bili's intended surface (+ client tools)`);
        } finally {
            if (rig) await rig.close();
            await fake.close();
        }
    });
}

test("wire-contract D: opt-in lane (absorb+rules+ccr) forwards the extended surface legally", async () => {
    const lane = LANES[0];
    const fake = await startFakeUpstream(lane.wire);
    let rig: Rig | undefined;
    try {
        rig = await startRig(fake.url, lane.model, { absorb: { enabled: true }, rules: true, ccr: { enabled: true } });
        const res = await fetch(`${rig.proxyUrl}${lane.path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test", "x-acp-session": "wc-anth-optin" },
            body: JSON.stringify(lane.clientBody),
        });
        assert.equal(res.status, 200, "opt-in turn completed");
        await res.text();
        assert.equal(fake.violations.length, 0, `opt-in fake violations:\n${fake.violations.join("\n")}`);
        const fwdNames = extractForwardedNames(lane.wire, fake.requests[0].body);
        const expected = [...BASE_EXPECTED[lane.wire], ...lane.clientToolNames, "absorb", "acp_rule", "acp_retrieve"].sort();
        assert.deepEqual(fwdNames.sort(), expected, "opt-in lane forwards base + absorb/acp_rule/acp_retrieve + client tools");
        const fwdTools = (fake.requests[0].body as ToolShape).tools;
        const compress = (Array.isArray(fwdTools) ? fwdTools : []).find((t) => (t as ToolShape).name === "compress") as ToolShape;
        assert.ok(compress, "opt-in forwarded body carries compress");
        assertCompressFormsKept(compress, "forwarded-optin");
    } finally {
        if (rig) await rig.close();
        await fake.close();
    }
});
