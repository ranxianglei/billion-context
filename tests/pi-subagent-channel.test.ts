// #2268: pi-subagents builtin-role channel fallback. Unit coverage for the gate
// (src/server/pi-subagent-channel.ts) plus server-level proof that a tagged,
// ACP-less child request gets proxy-style wire injection while identity stays
// plugin-bound — and that every scope boundary (no tag / any granted bili name /
// non-pi agent) keeps pure plugin mode.
// #2694: the hardening layer — a marker quoted in HISTORY (tool results,
// assistant/user text) must not flip a main session's channel, incomplete
// markers are documentation residue, and namespaced ACP grants count as grants.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import {
    detectPiSubagentChildSignal,
    exposesBiliInjectableTool,
    piSubagentChannelFallback,
} from "../src/server/pi-subagent-channel.ts";

const DELEGATE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
const ORACLE_TOOLS = ["read", "grep", "find", "ls", "bash"];

function anthropicBody(system: string, tools: string[]): Buffer {
    return Buffer.from(JSON.stringify({
        model: "claude-test",
        system,
        messages: [{ role: "user", content: "hi" }],
        tools: tools.map((name) => ({ name, description: `role tool ${name}`, input_schema: { type: "object" } })),
    }));
}

function tagged(role: string): string {
    return `<active_agent name="${role}"/>\n\nYou are the ${role} agent.`;
}

// — marker detection —

test("detectPiSubagentChildSignal: absent on a plain pi session body", () => {
    assert.deepEqual(detectPiSubagentChildSignal(anthropicBody("You are a coding agent.", DELEGATE_TOOLS)), { present: false });
});

test("detectPiSubagentChildSignal: finds the marker in JSON-escaped form and extracts the role", () => {
    const sig = detectPiSubagentChildSignal(anthropicBody(tagged("delegate"), DELEGATE_TOOLS));
    assert.equal(sig.present, true);
    if (sig.present) assert.equal(sig.agent, "delegate");
});

test("detectPiSubagentChildSignal: complex role names and array-form system blocks", () => {
    const arrBody = Buffer.from(JSON.stringify({
        model: "claude-test",
        system: [{ type: "text", text: tagged("evidence-auditor") }],
        messages: [{ role: "user", content: "hi" }],
    }));
    const sig = detectPiSubagentChildSignal(arrBody);
    assert.equal(sig.present, true);
    if (sig.present) assert.equal(sig.agent, "evidence-auditor");
});

test("detectPiSubagentChildSignal: incomplete markers are documentation residue, not identity (#2694)", () => {
    for (const sys of [
        "<active_agent name=",
        '<active_agent name="">',
        '<active_agent name="dele',
        "the docs mention a child marker <active_agent name= stamped on system prompts",
    ]) {
        assert.deepEqual(detectPiSubagentChildSignal(Buffer.from(JSON.stringify({ system: sys }))), { present: false }, sys);
    }
});

test("detectPiSubagentChildSignal: marker quoted in history (not a system carrier) is NOT a child signal (#2694)", () => {
    const chatBuf = Buffer.from(JSON.stringify({
        model: "claude-test",
        system: "plain system",
        messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: [{ type: "text", text: tagged("oracle") }] },
            { role: "tool", content: [{ type: "text", text: "docs say: " + tagged("scout") }] },
            { role: "user", content: "go on" },
        ],
    }));
    assert.deepEqual(detectPiSubagentChildSignal(chatBuf), { present: false });
    // the reported repro shape: responses wire, marker only inside a function_call_output document
    const respBuf = Buffer.from(JSON.stringify({
        model: "gpt-test",
        instructions: "You are a coding agent.",
        input: [
            { type: "function_call", call_id: "c1", name: "agent_task", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "architecture report: children are stamped with " + tagged("delegate") },
        ],
        tools: DELEGATE_TOOLS.map((name) => ({ type: "function", name, description: "" })),
    }));
    assert.deepEqual(detectPiSubagentChildSignal(respBuf), { present: false });
});

test("detectPiSubagentChildSignal: detects the marker in every system carrier shape", () => {
    const carriers: Array<[string, Buffer]> = [
        ["responses.instructions", Buffer.from(JSON.stringify({ model: "gpt-test", instructions: tagged("delegate"), input: [] }))],
        ["google.systemInstruction.parts", Buffer.from(JSON.stringify({ systemInstruction: { parts: [{ text: tagged("oracle") }] }, contents: [] }))],
        ["openai.messages[0].system", Buffer.from(JSON.stringify({ model: "gpt-test", messages: [{ role: "system", content: tagged("scout") }, { role: "user", content: "hi" }] }))],
        ["responses.developer-in-input", Buffer.from(JSON.stringify({ instructions: "base", input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: tagged("evidence-auditor") }] }] }))],
    ];
    for (const [label, buf] of carriers) {
        const sig = detectPiSubagentChildSignal(buf);
        assert.equal(sig.present, true, label);
    }
});

test("detectPiSubagentChildSignal: unparseable or non-object bodies fail closed (#2694)", () => {
    assert.deepEqual(detectPiSubagentChildSignal(Buffer.from('{"system":"<active_agent name="delegate"/>')), { present: false });
    assert.deepEqual(detectPiSubagentChildSignal(Buffer.from("[1,2,3]")), { present: false });
    assert.deepEqual(detectPiSubagentChildSignal(Buffer.from("not json at all")), { present: false });
});

// — exposure walker —

test("exposesBiliInjectableTool: every injectable name in every wire shape", () => {
    const names = ["compress", "decompress", "search_context", "acp_status", "acp_rule", "acp_retrieve", "absorb", "image_full"];
    for (const n of names) {
        assert.equal(exposesBiliInjectableTool([{ name: n }]), true, `top-level ${n}`);
        assert.equal(exposesBiliInjectableTool([{ type: "function", function: { name: n } }]), true, `openai ${n}`);
        assert.equal(exposesBiliInjectableTool([{ functionDeclarations: [{ name: n }] }]), true, `google ${n}`);
        assert.equal(exposesBiliInjectableTool([{ type: "function", name: n, description: "" }]), true, `responses ${n}`);
    }
});

test("exposesBiliInjectableTool: role whitelists expose none; near-miss names do not match", () => {
    assert.equal(exposesBiliInjectableTool(DELEGATE_TOOLS.map((name) => ({ name }))), false);
    assert.equal(exposesBiliInjectableTool(ORACLE_TOOLS.map((name) => ({ type: "function", function: { name } }))), false);
    for (const near of ["compress_x", "x_compress", "COMPRESS", "acp_statuses", "image-full"]) {
        assert.equal(exposesBiliInjectableTool([{ name: near }]), false, near);
    }
});

test("exposesBiliInjectableTool: malformed entries are skipped, never thrown", () => {
    assert.equal(exposesBiliInjectableTool([null, 42, "str", { name: 5 }, { function: null }, { functionDeclarations: "nope" }, {}]), false);
    assert.equal(exposesBiliInjectableTool(undefined), false);
    assert.equal(exposesBiliInjectableTool(null), false);
    assert.equal(exposesBiliInjectableTool([]), false);
    // union across positions: a hidden function.name counts even when top-level differs
    assert.equal(exposesBiliInjectableTool([{ name: "read", function: { name: "decompress" } }]), true);
});

test("exposesBiliInjectableTool: responses namespace wraps expose their members (#2694)", () => {
    const ns = (name: string, members: unknown[]) => ({ type: "namespace", name, tools: members });
    const fn = (name: string) => ({ type: "function", name, description: "" });
    assert.equal(exposesBiliInjectableTool([ns("bili", [fn("compress")])]), true);
    assert.equal(exposesBiliInjectableTool([ns("bili", [{ type: "custom", name: "acp_status", format: {} }])]), true);
    assert.equal(exposesBiliInjectableTool([ns("core", DELEGATE_TOOLS.map(fn))]), false);
    assert.equal(exposesBiliInjectableTool([fn("read"), ns("bili", [fn("search_context")])]), true);
});

// — composition gate —

test("piSubagentChannelFallback: delegate/oracle children fall back; granted roles do not", () => {
    assert.ok(piSubagentChannelFallback(anthropicBody(tagged("delegate"), DELEGATE_TOOLS), null).present);
    assert.ok(piSubagentChannelFallback(anthropicBody(tagged("oracle"), ORACLE_TOOLS), null).present);
    const granted = anthropicBody(tagged("delegate"), [...DELEGATE_TOOLS, "compress"]);
    assert.deepEqual(piSubagentChannelFallback(granted, JSON.parse(granted.toString("utf8"))), { present: false });
    assert.deepEqual(piSubagentChannelFallback(anthropicBody("plain system", DELEGATE_TOOLS), null), { present: false });
});

test("piSubagentChannelFallback: parsed=null re-parses the buffer (marker decides)", () => {
    const buf = anthropicBody(tagged("scout"), ORACLE_TOOLS);
    assert.ok(piSubagentChannelFallback(buf, null).present);
});

test("piSubagentChannelFallback: namespaced grants decide like flat ones (#2694)", () => {
    const nsBody = (members: unknown[]) => Buffer.from(JSON.stringify({
        model: "gpt-test",
        instructions: tagged("delegate"),
        input: [{ type: "message", role: "user", content: [] }],
        tools: [{ type: "namespace", name: "core", tools: members }],
    }));
    const fn = (name: string) => ({ type: "function", name, description: "" });
    // ACP-less role allowlist wrapped in a namespace — the child still falls back.
    assert.ok(piSubagentChannelFallback(nsBody(DELEGATE_TOOLS.map(fn)), null).present);
    // An ACP grant hidden inside a namespace — stays pure plugin mode.
    const granted = nsBody([...DELEGATE_TOOLS.map(fn), fn("compress")]);
    assert.deepEqual(piSubagentChannelFallback(granted, JSON.parse(granted.toString("utf8"))), { present: false });
});

// — server-level: the actual channel decision through the real pipeline —

type Rig = { proxyPort: number; upstreamPort: number; forwards: string[]; proxy: http.Server; upstream: http.Server };

function okAnthropic(): string {
    return JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: "claude-test",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
    });
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            forwards.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okAnthropic());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, forwards, proxy, upstream };
}

async function postAnthropic(rig: Rig, convId: string, body: Record<string, unknown>, agent: string): Promise<number> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": agent,
            "x-bili-plugin-conversation": convId,
        },
        body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
}

function forwardedToolNames(forwards: string[], index: number): string[] {
    const parsed = JSON.parse(forwards[index]) as { tools?: Array<Record<string, unknown>> };
    const out: string[] = [];
    for (const t of parsed.tools ?? []) {
        if (typeof t.name === "string") out.push(t.name);
    }
    return out;
}

const CORE_ACP = ["compress", "decompress", "search_context", "acp_status"];

test("#2268 server-level: tagged ACP-less delegate child gets proxy-style injection; scope boundaries keep plugin mode", async () => {
    const rig = await startRig();
    try {
        const base = {
            model: "claude-test",
            max_tokens: 64_000,
            messages: [{ role: "user", content: "hi" }],
        };
        const toolsOf = (names: string[]) => names.map((name) => ({ name, description: `role tool ${name}`, input_schema: { type: "object" } }));

        // A: unmodified builtin delegate role (the issue repro) — fallback ON.
        assert.equal(await postAnthropic(rig, "sar-2268-a", { ...base, system: tagged("delegate"), tools: toolsOf(DELEGATE_TOOLS) }, "pi"), 200);
        const a = forwardedToolNames(rig.forwards, 0);
        for (const n of CORE_ACP) assert.ok(a.includes(n), `fallback must inject ${n}; got ${a.join(",")}`);
        for (const n of DELEGATE_TOOLS) assert.ok(a.includes(n), `role tools must survive: ${n}`);

        // B: a role that grants ANY bili-injectable name stays pure plugin mode.
        assert.equal(await postAnthropic(rig, "sar-2268-b", { ...base, system: tagged("delegate"), tools: toolsOf([...DELEGATE_TOOLS, "compress"]) }, "pi"), 200);
        const b = forwardedToolNames(rig.forwards, 1);
        for (const n of CORE_ACP) assert.equal(b.filter((x) => x === n).length, n === "compress" ? 1 : 0, `${n} must not be injected twice/added`);

        // C: pi-stamped request WITHOUT the child marker — no fallback.
        assert.equal(await postAnthropic(rig, "sar-2268-c", { ...base, system: "You are a coding agent.", tools: toolsOf(DELEGATE_TOOLS) }, "pi"), 200);
        const c = forwardedToolNames(rig.forwards, 2);
        for (const n of CORE_ACP) assert.ok(!c.includes(n), `untagged request must stay plugin mode (${n})`);

        // D: the marker on a NON-pi plugin agent — scope is pi only.
        assert.equal(await postAnthropic(rig, "sar-2268-d", { ...base, system: tagged("delegate"), tools: toolsOf(DELEGATE_TOOLS) }, "omp"), 200);
        const d = forwardedToolNames(rig.forwards, 3);
        for (const n of CORE_ACP) assert.ok(!d.includes(n), `non-pi agent must stay plugin mode (${n})`);

        // E (#2694): MAIN session whose history merely QUOTES the marker (repo
        // docs about subagents) — channel stays plugin mode, no injection.
        assert.equal(await postAnthropic(rig, "sar-2694-e", {
            ...base,
            system: "You are a coding agent.",
            messages: [
                { role: "user", content: "research the repo" },
                { role: "assistant", content: [{ type: "text", text: "children are stamped with " + tagged("delegate") }] },
                { role: "user", content: "go on" },
            ],
            tools: toolsOf(DELEGATE_TOOLS),
        }, "pi"), 200);
        const e = forwardedToolNames(rig.forwards, 4);
        for (const n of CORE_ACP) assert.ok(!e.includes(n), `history-quoted marker must stay plugin mode (${n})`);
    } finally {
        rig.proxy.close();
        await once(rig.proxy, "close");
        rig.upstream.close();
        await once(rig.upstream, "close");
    }
});
