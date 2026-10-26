// #1085 e2e: sticky head-system anchor through the REAL proxy. When a client's
// head system text (ambient instructions such as AGENTS.md) changes mid-session,
// the proxy must keep forwarding the FIRST-seen head byte-stable (the provider
// prefix-cache anchor) and append one trailing user note carrying a compact
// line diff of the change — instead of letting the changed head invalidate the
// whole cached prefix. Also covers the interop contract: a third-party client
// that already implements its own version (constant system + in-history update
// messages) must pass through with ZERO bili-side injection — and that
// plugin-mode agents are never anchored at all (owner scope: plain-proxy only).
// Session D (anthropic wire): client-sent cache_control breakpoints must ride
// on the SAME logical blocks across turns and never land on an injected note
// (opencode#43507 class of regression: a breakpoint on a message that can
// never prefix-match silently disables caching for everything after it).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const MARKER = "[System context update]";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function anthropicSse(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (t: string, d: Record<string, unknown>) => res.write(sseBlock(t, { type: t, ...d }));
    ev("message_start", { message: { id: "msg_d", usage: { input_tokens: 10 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
    ev("message_stop", {});
    res.end();
}

function responsesSse(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(sseBlock("response.created", { response: { id: "resp_1", status: "in_progress" } }));
    res.write(sseBlock("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }));
    res.write(sseBlock("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" }));
    res.write(sseBlock("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }));
    res.write(sseBlock("response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } }));
    res.write(sseBlock("response.completed", { response: { id: "resp_1", status: "completed", output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 10, output_tokens: 2 } } }));
    res.end();
}

type ChatMsg = { role: string; content?: unknown };

function leadingSystem(body: string): string {
    const sent = JSON.parse(body) as { messages: ChatMsg[] };
    const m = sent.messages.find((x) => x.role === "system" || x.role === "developer");
    return typeof m?.content === "string" ? m.content : "";
}

function markerMessages(body: string): string[] {
    const sent = JSON.parse(body) as { messages: ChatMsg[] };
    return sent.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter((c) => c.startsWith(MARKER));
}

test("e2e #1085: changed head system stays anchored; updates ride as trailing notes", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push(body);
            if ((req.url ?? "").includes("/responses")) {
                responsesSse(res);
                return;
            }
            if ((req.url ?? "").endsWith("/v1/messages")) {
                anthropicSse(res);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: `reply-${captured.length}` }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
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
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        stableSystemAnchor: true,
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
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const chatUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const respUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    async function chatTurn(sessionId: string, model: string, body: Record<string, unknown>): Promise<string> {
        const res = await fetch(chatUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": sessionId },
            body: JSON.stringify({ model, stream: false, ...body }),
        });
        if (!res.ok) throw new Error(`turn failed: HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
        return json.choices[0]?.message?.content ?? "";
    }

    try {
        // --- Session A: OpenAI wire, head system changes between turns ---
        // Multi-line AGENTS.md-style heads differing in exactly one line: a
        // localized edit that must take the diff-note path (a fully rewritten
        // single-line head would be non-localized → deliberate anchor replace).
        const SYS_V1 = ["# Project rules", "Always run npm test before committing.", "Use TypeScript strict mode.", "Keep diffs minimal."].join("\n");
        const SYS_V2 = ["# Project rules", "Always run npm test AND the e2e suite before committing.", "Use TypeScript strict mode.", "Keep diffs minimal."].join("\n");
        const histA: ChatMsg[] = [];
        let reply = await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V1 }, { role: "user", content: "hello 1" }] });
        histA.push({ role: "user", content: "hello 1" }, { role: "assistant", content: reply });
        reply = await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V2 }, ...histA, { role: "user", content: "hello 2" }] });
        histA.push({ role: "user", content: "hello 2" }, { role: "assistant", content: reply });
        await chatTurn("anchor-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_V2 }, ...histA, { role: "user", content: "hello 3" }] });

        const [a1, a2, a3] = captured.slice(0, 3);
        assert.ok(a1 && a2 && a3, "expected 3 captured OpenAI requests");
        // Turn 1: head anchored, no notes yet.
        assert.ok(leadingSystem(a1!).includes(SYS_V1), "turn 1 head must carry the original system");
        assert.equal(markerMessages(a1!).length, 0, "turn 1 must carry no update notes");
        // Turn 2: head BYTE-STABLE (still V1, never V2), exactly one trailing
        // note carrying a compact diff of the one-line edit.
        assert.equal(leadingSystem(a2!), leadingSystem(a1!), "head system must stay byte-identical after a detected change");
        assert.ok(!leadingSystem(a2!).includes("AND the e2e suite"), "changed head text must NOT replace the anchor");
        const notes2 = markerMessages(a2!);
        assert.equal(notes2.length, 1, "exactly one update note after a single change");
        assert.ok(notes2[0]!.includes("-Always run npm test before committing."), "note must show the removed line");
        assert.ok(notes2[0]!.includes("+Always run npm test AND the e2e suite before committing."), "note must show the added line");
        const sentA2 = JSON.parse(a2!) as { messages: ChatMsg[] };
        assert.equal(sentA2.messages[sentA2.messages.length - 1]?.role, "user", "note must trail the conversation");
        // Turn 3: unchanged head — no duplicated note.
        assert.equal(leadingSystem(a3!), leadingSystem(a1!), "head system must remain byte-identical on steady turns");
        assert.equal(markerMessages(a3!).length, 1, "steady turns must not duplicate the note");

        // --- Session B: interop — a third-party client already keeps its system
        // constant and records instruction changes as ordinary in-history user
        // messages (opencode-style). bili must add NOTHING of its own. ---
        const SYS_T = "THIRD-PARTY-CONSTANT-SYSTEM";
        const TP_UPDATE = "These instructions replace all previously loaded ambient instructions.\n\nNEW-RULES-FROM-CLIENT";
        const histB: ChatMsg[] = [];
        reply = await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, { role: "user", content: "b1" }] });
        histB.push({ role: "user", content: "b1" }, { role: "assistant", content: reply });
        reply = await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, ...histB, { role: "user", content: TP_UPDATE }, { role: "assistant", content: "understood" }, { role: "user", content: "b2" }] });
        histB.push({ role: "user", content: TP_UPDATE }, { role: "assistant", content: "understood" }, { role: "user", content: "b2" }, { role: "assistant", content: reply });
        await chatTurn("interop-e2e", "gpt-test", { messages: [{ role: "system", content: SYS_T }, ...histB, { role: "user", content: "b3" }] });

        const [b1, b2, b3] = captured.slice(3, 6);
        assert.ok(b1 && b2 && b3, "expected 3 captured interop requests");
        for (const [i, body] of [b1!, b2!, b3!].entries()) {
            assert.equal(markerMessages(body).length, 0, `interop request ${i + 1}: bili must not inject its own update notes`);
            assert.equal(leadingSystem(body), leadingSystem(b1!), "interop head system must stay byte-identical across turns");
        }
        // Parse before substring checks: the raw body is JSON, where newlines
        // arrive as two-char \n escapes, not the real 0x0A in the constant.
        const b2Text = (JSON.parse(b2!) as { messages: ChatMsg[] }).messages
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("\n");
        assert.ok(b2Text.includes(TP_UPDATE), "third-party in-history update must pass through untouched");

        // --- Session C: Responses wire (codex-style instructions) ---
        const INST_V1 = ["You are a coding agent.", "Follow repo conventions.", "Run tests before finishing.", "Be concise."].join("\n");
        const INST_V2 = ["You are a coding agent.", "Follow repo conventions and its AGENTS.md.", "Run tests before finishing.", "Be concise."].join("\n");
        const inputC: Array<Record<string, unknown>> = [];
        for (const [inst, userText] of [[INST_V1, "c1"], [INST_V2, "c2"], [INST_V2, "c3"]] as Array<[string, string]>) {
            const res = await fetch(respUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "responses-anchor-e2e" },
                body: JSON.stringify({ model: "gpt-test", stream: true, instructions: inst, input: [...inputC, { type: "message", role: "user", content: userText }] }),
            });
            if (!res.ok) throw new Error(`responses turn failed: HTTP ${res.status}`);
            await res.text();
            inputC.push({ type: "message", role: "assistant", content: "ok" }, { type: "message", role: "user", content: userText });
        }

        const [c1, c2, c3] = captured.slice(6, 9);
        assert.ok(c1 && c2 && c3, "expected 3 captured Responses requests");
        const devOf = (body: string): string => {
            const sent = JSON.parse(body) as { input: Array<{ role?: string; content?: unknown }> };
            const dev = sent.input.find((x) => x.role === "developer");
            return typeof dev?.content === "string" ? dev.content : JSON.stringify(dev?.content ?? "");
        };
        const markerItems = (body: string): string[] => {
            const sent = JSON.parse(body) as { input: Array<{ role?: string; content?: unknown }> };
            return sent.input
                .filter((x) => x.role === "user")
                .map((x) => (typeof x.content === "string" ? x.content : ""))
                .filter((c) => c.startsWith(MARKER));
        };
        assert.ok(devOf(c1!).includes(INST_V1), "responses turn 1 developer message must carry the original instructions");
        assert.equal(markerItems(c1!).length, 0, "responses turn 1 must carry no update notes");
        assert.equal(devOf(c2!), devOf(c1!), "responses developer message must stay byte-identical after a change");
        assert.ok(!devOf(c2!).includes(INST_V2), "changed instructions must NOT replace the anchor");
        const cnotes = markerItems(c2!);
        assert.equal(cnotes.length, 1, "exactly one responses update note after a single change");
        assert.ok(cnotes[0]!.includes("-Follow repo conventions."), "responses note must show the removed line");
        assert.ok(cnotes[0]!.includes("+Follow repo conventions and its AGENTS.md."), "responses note must show the added line");
        assert.equal(devOf(c3!), devOf(c1!), "responses developer message must remain byte-identical on steady turns");
        assert.equal(markerItems(c3!).length, 1, "steady responses turns must not duplicate the note");

        // --- Session D: Anthropic wire — client-sent cache_control breakpoints ---
        // Multi-line heads differing in ONE line: a localized file-style edit
        // (>=70% shared lines) so the anchor is kept and a diff note appended.
        const SYS_D1 = "ANTHROPIC-AMBIENT-V1\nline two\nline three\nline four";
        const SYS_D2 = "ANTHROPIC-AMBIENT-V2\nline two\nline three\nline four";
        const antUrl = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const CC = { type: "ephemeral" };
        let histD: Array<Record<string, unknown>> = [];
        for (const [sysText, userText] of [[SYS_D1, "d-hello-1"], [SYS_D2, "d-hello-2"], [SYS_D2, "d-hello-3"]] as Array<[string, string]>) {
            const newMsg = { role: "user", content: [{ type: "text", text: userText, ...(histD.length === 0 ? { cache_control: CC } : {}) }] };
            const res = await fetch(antUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-acp-session": "anthropic-anchor-e2e" },
                body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, system: [{ type: "text", text: sysText, cache_control: CC }], messages: [...histD, newMsg] }),
            });
            if (!res.ok) throw new Error(`anthropic turn failed: HTTP ${res.status}`);
            await res.text();
            histD.push(newMsg, { role: "assistant", content: [{ type: "text", text: "ok" }] });
        }

        type AntBlock = { type?: string; text?: string; cache_control?: unknown };
        type AntMsg = { role: string; content: string | AntBlock[] };
        const antBody = (body: string): { system: string | AntBlock[]; messages: AntMsg[] } => JSON.parse(body) as { system: string | AntBlock[]; messages: AntMsg[] };
        // String-content messages (how injected notes ride the wire) count as one implicit block.
        const msgBlocks = (m: AntMsg): AntBlock[] => (typeof m.content === "string" ? [{ text: m.content }] : m.content);
        const ccBlocks = (body: string): AntBlock[] => {
            const sent = antBody(body);
            const out: AntBlock[] = [];
            for (const b of Array.isArray(sent.system) ? sent.system : []) if (b.cache_control) out.push(b);
            for (const m of sent.messages) for (const b of msgBlocks(m)) if (b.cache_control) out.push(b);
            return out;
        };
        const antNotes = (body: string): string[] => {
            const sent = antBody(body);
            const out: string[] = [];
            for (const m of sent.messages) for (const b of msgBlocks(m)) if ((b.text ?? "").startsWith(MARKER)) out.push(b.text ?? "");
            return out;
        };
        const sysCc = (body: string): AntBlock | undefined => ccBlocks(body).find((b) => (b.text ?? "").startsWith(SYS_D1));

        const [d1, d2, d3] = captured.slice(9, 12);
        assert.ok(d1 && d2 && d3, "expected 3 captured Anthropic requests");
        // Turn 1: both client breakpoints forwarded as sent.
        assert.equal(ccBlocks(d1!).length, 2, "turn 1: exactly the two client breakpoints");
        assert.ok(sysCc(d1!)!.text!.includes(SYS_D1), "turn 1: system breakpoint rides the original head");
        // ACP tag rendering prefixes stored text with an \x3cacp...\x3e marker; match by containment.
        const hasCcOn = (body: string, needle: string): boolean => ccBlocks(body).some((b) => (b.text ?? "").includes(needle));
        assert.ok(hasCcOn(d1!, "d-hello-1"), "turn 1: history-block breakpoint preserved");
        // Turn 2: head changed — breakpoints stay on the SAME logical blocks
        // (identity-keyed carry-over, not index-based), none on the injected note.
        assert.equal(ccBlocks(d2!).length, 2, "turn 2: breakpoint count unchanged after a head change");
        assert.ok(sysCc(d2!)!.text!.includes(SYS_D1), "turn 2: system breakpoint follows the anchored head");
        assert.ok(!sysCc(d2!)!.text!.includes(SYS_D2), "turn 2: anchored system must not contain the replacement text");
        assert.ok(hasCcOn(d2!, "d-hello-1"), "turn 2: history-block breakpoint still on the same block");
        assert.ok(!ccBlocks(d2!).some((b) => (b.text ?? "").startsWith(MARKER)), "turn 2: no breakpoint may land on an update note");
        const dnotes = antNotes(d2!);
        assert.equal(dnotes.length, 1, "exactly one anthropic update note after a single change");
        assert.ok(dnotes[0]!.includes("+ANTHROPIC-AMBIENT-V2") && dnotes[0]!.includes("-ANTHROPIC-AMBIENT-V1"), "anthropic note must carry the line diff of the change");
        const lastD2 = antBody(d2!).messages[antBody(d2!).messages.length - 1];
        assert.equal(lastD2.role, "user", "anthropic note must trail the conversation");
        // Turn 3: steady — same breakpoint signature, note not duplicated.
        assert.equal(ccBlocks(d3!).length, 2, "turn 3: breakpoint count unchanged on steady turns");
        assert.ok(sysCc(d3!)!.text!.includes(SYS_D1), "turn 3: system breakpoint still on the anchored head");
        assert.ok(hasCcOn(d3!, "d-hello-1"), "turn 3: history-block breakpoint preserved");
        assert.ok(!ccBlocks(d3!).some((b) => (b.text ?? "").startsWith(MARKER)), "turn 3: no breakpoint on a note");
        assert.equal(antNotes(d3!).length, 1, "steady anthropic turns must not duplicate the note");

        // --- Session E: plugin-mode agent — anchoring is plain-proxy scope
        // only (#1085 owner decision); a registered agent keeps full control
        // of its own head, so bili must forward changes verbatim, no notes. ---
        const histE: ChatMsg[] = [];
        async function pluginTurn(body: Record<string, unknown>): Promise<string> {
            const res = await fetch(chatUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "plugin-e2e", "x-bili-plugin": "e2e-agent" },
                body: JSON.stringify({ model: "gpt-test", stream: false, ...body }),
            });
            if (!res.ok) throw new Error(`plugin turn failed: HTTP ${res.status}: ${await res.text()}`);
            const json = (await res.json()) as { choices: Array<{ message: { content?: string } }> };
            return json.choices[0]?.message?.content ?? "";
        }
        reply = await pluginTurn({ messages: [{ role: "system", content: SYS_V1 }, { role: "user", content: "e1" }] });
        histE.push({ role: "user", content: "e1" }, { role: "assistant", content: reply });
        await pluginTurn({ messages: [{ role: "system", content: SYS_V2 }, ...histE, { role: "user", content: "e2" }] });

        const [e1, e2] = captured.slice(12, 14);
        assert.ok(e1 && e2, "expected 2 captured plugin-mode requests");
        assert.ok(leadingSystem(e2!).includes("AND the e2e suite"), "plugin-mode head change must pass through verbatim (no anchoring)");
        assert.notEqual(leadingSystem(e2!), leadingSystem(e1!), "plugin-mode head must NOT be frozen to the first-seen bytes");
        assert.equal(markerMessages(e2!).length, 0, "plugin mode must get zero update notes");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
