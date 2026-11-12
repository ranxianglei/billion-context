// #3252: code-mode/PTC harnesses (dsh "PTC" preset, Cloudflare-style code mode)
// collapse every registered tool behind ONE directly callable `run_code` tool.
// The two serving sites answer with description-side notes so the model never
// has to rediscover the calling convention by trial and error:
//  - proxy lane (injectTool & co): when the client's own tools array carries
//    a known code-mode omnibus (run_code / code_run — #3884), the injected
//    ACP entries get PTC_EXEMPT_NOTE ("this tool is the exception — call it
//    DIRECTLY; the proxy executes it server-side"), because bili's tools have
//    no omnibus SDK binding and the proxy tool loop executes direct calls
//    upstream of the harness.
//  - plugin lane (handlePluginManifest): every wire gets PTC_BINDING_NOTE (the
//    conditional both-conventions sentence) since one manifest serves native
//    and code-mode hosts alike.
// PROJECT_URL_NOTE (billion-context attribution + issue tracker) rides on
// compress in BOTH lanes unconditionally (owner request in #3252).

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { handlePluginManifest } from "../src/plugin.ts";
import type { ProxyOptions } from "../src/config.ts";
import { CODEX_EXEC_EXEMPT_NOTE, injectGoogleTool, injectOpenaiTool, injectResponsesTool, injectTool, injectSystem } from "../src/server/inject.ts";
import { PROJECT_URL_NOTE, PTC_BINDING_NOTE, PTC_EXEMPT_NOTE, PROJECT_ATTRIBUTION_LINE, withProjectAttribution } from "../src/compress-tool.ts";

const RUN_CODE = { name: "run_code", description: "Run a program in the sandbox." };
const BASH = { name: "bash", description: "Shell out." };

function flat(tools: unknown[]): Map<string, string> {
    return new Map(tools.map((t) => {
        const o = t as { name?: unknown; description?: unknown };
        return [String(o?.name), typeof o?.description === "string" ? o.description : ""];
    }));
}

function openaiShape(tools: { function: { name?: string; description?: string } }[]): Map<string, string> {
    return new Map(tools.map((t) => [String(t.function.name), t.function.description ?? ""] as const));
}

// — proxy lane: exempt note appears only when the client tools carry run_code —

test("injectTool: run_code client → exempt note on ACP entries, URL note on compress", () => {
    const out = flat(injectTool([RUN_CODE, BASH] as unknown[]));
    assert.equal(out.get("run_code"), RUN_CODE.description, "client entry untouched");
    assert.equal(out.get("bash"), BASH.description, "non-ACP client entry untouched");
    for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
        const desc = out.get(name) ?? "";
        assert.ok(desc.includes(PTC_EXEMPT_NOTE), `${name} carries the exempt note`);
        assert.ok(!desc.includes(PTC_BINDING_NOTE), `${name} must not carry the binding note on the proxy lane`);
        if (name === "compress") assert.ok(desc.includes(PROJECT_URL_NOTE), "compress carries the project URL note");
        else assert.ok(!desc.includes(PROJECT_URL_NOTE), `${name} must not carry the URL note`);
    }
});

test("injectTool: pack description override lands verbatim — notes skipped for that tool only", () => {
    const pack = { compress: { description: "Lean compress wording." }, acp_status: { paramDescriptions: { verbose: "v" } } };
    const out = flat(injectTool([RUN_CODE] as unknown[], undefined, pack));
    assert.equal(out.get("compress"), "Lean compress wording.", "pack owns the wording wholesale, notes included only if authored");
    // paramDescriptions-only overrides do NOT own the description → notes still ride
    assert.ok((out.get("acp_status") ?? "").includes(PTC_EXEMPT_NOTE), "paramDescriptions-only override keeps the note");
    assert.ok((out.get("decompress") ?? "").includes(PTC_EXEMPT_NOTE), "untouched tools keep the note");
});

test("injectTool: no run_code → no exempt note, URL note still on compress", () => {
    const out = flat(injectTool([BASH] as unknown[]));
    for (const [name, desc] of out) {
        assert.ok(!desc.includes(PTC_EXEMPT_NOTE), `${name} must not carry the exempt note`);
        assert.ok(!desc.includes(PTC_BINDING_NOTE), `${name} must not carry the binding note`);
    }
    assert.ok((out.get("compress") ?? "").includes(PROJECT_URL_NOTE), "compress carries the URL note unconditionally");
});

test("injectTool: output is byte-stable for the same input (#3 prefix-cache discipline)", () => {
    const a = JSON.stringify(injectTool([RUN_CODE] as unknown[]));
    const b = JSON.stringify(injectTool([RUN_CODE] as unknown[]));
    assert.equal(a, b);
});

test("injectOpenaiTool: run_code client → exempt note under function.description", () => {
    const out = openaiShape(injectOpenaiTool([
        { type: "function", function: { name: "run_code", description: "prog", parameters: { type: "object" } } },
    ]) as { function: { name?: string; description?: string } }[]);
    assert.ok((out.get("compress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((out.get("compress") ?? "").includes(PROJECT_URL_NOTE));
    assert.ok((out.get("acp_status") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok(!(out.get("acp_status") ?? "").includes(PROJECT_URL_NOTE));
});

test("injectResponsesTool: run_code client → exempt note, flat shape", () => {
    const out = flat(injectResponsesTool([RUN_CODE] as unknown[]));
    assert.ok((out.get("decompress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((out.get("compress") ?? "").includes(PROJECT_URL_NOTE));
    assert.equal(out.get("run_code"), RUN_CODE.description, "client entry untouched");
});

const CODEX_EXEC = { type: "custom", name: "exec", description: "Run JavaScript code to orchestrate tool calls." };

test("injectResponsesTool: qualified Codex exec teaches direct calls without changing host tools (#5592)", () => {
    const shapes = [
        [{ ...CODEX_EXEC, name: "functions.exec" }],
        [{ ...CODEX_EXEC, type: "function", name: "functions.exec" }],
        [{ type: "namespace", name: "functions", tools: [CODEX_EXEC] }],
        [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: [CODEX_EXEC] }] }],
    ];
    for (const tools of shapes) {
        const before = JSON.stringify(tools);
        const out = injectResponsesTool(tools);
        const descriptions = flat(out);
        assert.equal(out[0], tools[0], "host declarations retain object identity");
        assert.equal(JSON.stringify(tools), before, "host declarations remain byte-exact");
        for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
            assert.ok(descriptions.get(name)?.includes(CODEX_EXEC_EXEMPT_NOTE), name);
            assert.ok(!descriptions.get(name)?.includes(PTC_BINDING_NOTE), name);
        }
        assert.equal(JSON.stringify(out), JSON.stringify(injectResponsesTool(tools)), "stable prompt bytes");
        assert.deepEqual(injectResponsesTool(out), out, "repeated injection does not duplicate notes");
    }
});

test("injectResponsesTool: ordinary exec and unrelated namespaces do not acquire Codex hints (#5592)", () => {
    const shapes: unknown[][] = [
        [CODEX_EXEC],
        [{ type: "function", name: "exec", description: "Run a shell command." }],
        [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "shell" }] }],
        [{ type: "namespace", name: "other", tools: [CODEX_EXEC] }],
        [{ type: "namespace", name: "functions", tools: [{ type: "namespace", name: "exec", tools: [] }] }],
        [{ type: "namespace", name: "functions", tools: null }],
        [{ type: "namespace", name: "functions.exec", tools: [] }],
        [{ type: "function", name: "functions", tools: [CODEX_EXEC] }],
        [{ type: "namespace", name: "other", tools: [{ ...CODEX_EXEC, name: "functions.exec" }] }],
        [null, undefined, "functions.exec"],
    ];
    for (const tools of shapes) {
        for (const description of flat(injectResponsesTool(tools)).values()) {
            assert.ok(!description.includes(CODEX_EXEC_EXEMPT_NOTE));
        }
    }
});

test("injectResponsesTool: Codex notes preserve native MCP tools and pack-owned descriptions (#5592)", () => {
    const native = { type: "namespace", name: "mcp__bili", tools: [{ type: "function", name: "compress", description: "Native MCP binding" }] };
    const tools = [{ type: "namespace", name: "functions", tools: [CODEX_EXEC] }, native];
    const pack = { compress: { description: "Pack-owned compress wording." } };
    const out = injectResponsesTool(tools, undefined, pack);
    assert.equal(out[1], native);
    assert.equal(flat(out).get("compress"), pack.compress.description);
    assert.ok(flat(out).get("acp_status")?.includes(CODEX_EXEC_EXEMPT_NOTE));
    for (const entries of Object.values(readManifestTools())) {
        assert.ok(entries.get("compress")?.includes(PTC_BINDING_NOTE));
        assert.ok(!entries.get("compress")?.includes(CODEX_EXEC_EXEMPT_NOTE));
    }
});

test("injectGoogleTool: run_code declaration → exempt note on appended declarations", () => {
    const out = injectGoogleTool([{ functionDeclarations: [{ name: "run_code", description: "prog" }] }] as never);
    const decls = new Map(out.flatMap((t) => (t.functionDeclarations ?? []).map((d) => [d.name, d.description] as const)) as [string, string][]);
    assert.ok((decls.get("compress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((decls.get("compress") ?? "").includes(PROJECT_URL_NOTE));
    assert.ok(!(decls.get("search_context") ?? "").includes(PROJECT_URL_NOTE));
    assert.equal(decls.get("run_code"), "prog", "client declaration untouched");
});

test("injectGoogleTool: no run_code → no exempt note", () => {
    const out = injectGoogleTool([{ functionDeclarations: [{ name: "bash", description: "sh" }] }] as never);
    const decls = new Map(out.flatMap((t) => (t.functionDeclarations ?? []).map((d) => [d.name, d.description] as const)) as [string, string][]);
    assert.ok(!(decls.get("compress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((decls.get("compress") ?? "").includes(PROJECT_URL_NOTE));
});

// #3884: DSH 0.2.x code-mode transport is named `code_run` (dsh-codemode
// plugin; the reserved name `run_code` belongs to dsh-tools). ptcNoteMode must
// read it code-mode-shaped too, or proxy-lane injections for such clients lose
// the exempt note and the model may refuse direct bili calls under the
// harness's only-omnibus rule — silent compression failure, same family as the
// lane-decisions miss. Positive rows below; the negative direction is pinned by
// the bash-only rows above (#3617 bidirectional discipline).
const CODE_RUN = { name: "code_run", description: "Run a program in the sandbox." };

test("injectTool: code_run client → exempt note on ACP entries (#3884)", () => {
    const out = flat(injectTool([CODE_RUN, BASH] as unknown[]));
    assert.equal(out.get("code_run"), CODE_RUN.description, "client entry untouched");
    for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
        assert.ok((out.get(name) ?? "").includes(PTC_EXEMPT_NOTE), `${name} carries the exempt note`);
    }
});

test("injectOpenaiTool: code_run client → exempt note under function.description (#3884)", () => {
    const out = openaiShape(injectOpenaiTool([
        { type: "function", function: { name: "code_run", description: "prog", parameters: { type: "object" } } },
    ]) as { function: { name?: string; description?: string } }[]);
    assert.ok((out.get("compress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((out.get("acp_status") ?? "").includes(PTC_EXEMPT_NOTE));
});

test("injectResponsesTool: code_run client → exempt note, flat shape (#3884)", () => {
    const out = flat(injectResponsesTool([CODE_RUN] as unknown[]));
    assert.ok((out.get("decompress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.ok((out.get("compress") ?? "").includes(PROJECT_URL_NOTE));
});

test("injectGoogleTool: code_run declaration → exempt note on appended declarations (#3884)", () => {
    const out = injectGoogleTool([{ functionDeclarations: [{ name: "code_run", description: "prog" }] }] as never);
    const decls = new Map(out.flatMap((t) => (t.functionDeclarations ?? []).map((d) => [d.name, d.description] as const)) as [string, string][]);
    assert.ok((decls.get("compress") ?? "").includes(PTC_EXEMPT_NOTE));
    assert.equal(decls.get("code_run"), "prog", "client declaration untouched");
});

// — plugin lane: manifest always carries the binding note (no per-request signal) —

function readManifestTools(): { anthropic: Map<string, string>; openai: Map<string, string>; responses: Map<string, string> } {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as unknown as Parameters<typeof handlePluginManifest>[0];
    handlePluginManifest(res, defaultConfig(200_000));
    const parsed = JSON.parse(body) as { tools: { anthropic: unknown[]; openai: { function: { name: string; description: string } }[]; responses: unknown[] } };
    const openai = new Map<string, string>();
    for (const t of parsed.tools.openai) openai.set(t.function.name, t.function.description);
    return { anthropic: flat(parsed.tools.anthropic), openai, responses: flat(parsed.tools.responses) };
}

test("handlePluginManifest: binding note on every ACP entry, exempt note absent, URL on compress", () => {
    const m = readManifestTools();
    for (const [wire, entries] of Object.entries(m)) {
        for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
            const desc = entries.get(name) ?? "";
            assert.ok(desc.includes(PTC_BINDING_NOTE), `${wire}/${name} carries the binding note`);
            assert.ok(!desc.includes(PTC_EXEMPT_NOTE), `${wire}/${name} must not carry the exempt note`);
            if (name === "compress") assert.ok(desc.includes(PROJECT_URL_NOTE), `${wire}/compress carries the URL note`);
            else assert.ok(!desc.includes(PROJECT_URL_NOTE), `${wire}/${name} must not carry the URL note`);
        }
    }
});

test("handlePluginManifest: openai wire notes live under function.description", () => {
    const openai = readManifestTools().openai;
    for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
        const desc = openai.get(name) ?? "";
        assert.ok(desc.includes(PTC_BINDING_NOTE), `openai/${name} carries the binding note`);
    }
    assert.ok((openai.get("compress") ?? "").includes(PROJECT_URL_NOTE));
});

// #3252 (owner request): the injected compress system prompt must name the
// project and its issue tracker — in BOTH lanes (plugin mode skips only tool
// injection; the system prompt still rides the request).
test("project attribution: injectSystem appends the billion-context line to the system prompt", () => {
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
    const system = injectSystem({ system: "You are a helpful assistant.", messages: [] }, opts, undefined, defaultConfig(400_000));
    assert.ok(typeof system === "string", "string system in, string system out");
    const text = system as string;
    assert.ok(text.includes(PROJECT_ATTRIBUTION_LINE), "attribution line reaches the system block");
    assert.match(text, /github\.com\/ranxianglei\/billion-context/);
    assert.ok(text.startsWith("You are a helpful assistant."), "client system block stays byte-exact (appended, never merged)");
});

test("project attribution: helper output is a static string (byte-stable across turns)", () => {
    assert.equal(withProjectAttribution("PROMPT"), "PROMPT\n\n" + PROJECT_ATTRIBUTION_LINE);
    assert.equal(withProjectAttribution("PROMPT"), withProjectAttribution("PROMPT"));
});
