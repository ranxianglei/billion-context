import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startFakeUpstream } from "./wire-contract-fakes.ts";

// Regression for #5392: Claude-family models routed through Google's v1internal /
// Cloud Code Assist wire translate role:"user" parts into Anthropic content blocks
// IN ORDER, and Anthropic requires every tool_result block to LEAD the user message
// that follows an assistant tool_use turn — the OPPOSITE of the WC-018 text-first
// rule (#3159) that fixes Gemini/Vertex. Bili's unconditional part-order normalize
// reordered such a body to [text, functionResponse] and upstream 400'd ("Each
// 'tool_use' block must have a corresponding 'tool_result' block in the next
// message"). coreToGoogle (and the host boundaries) now skip the reorder when the
// target model matches /claude/i, keeping the natural responses-first order; the
// validation-parity fake skips WC-018 for the same Claude targets.

const CLAUDE_MODEL = "claude-opus-4-8";

interface Harness {
    proxyUrl: string;
    close(): Promise<void>;
}

async function startHarness(fakeUrl: string): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: fakeUrl,
        routes: { [fakeUrl]: { models: { [CLAUDE_MODEL]: { context: 1_000_000 } } } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: true },
        stableSystemAnchor: true,
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
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: `http://127.0.0.1:${port}/bili/${fakeUrl}`,
        close: () => new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve()))),
    };
}

const TURN_1_CONTENTS = [{ role: "user", parts: [{ text: "What is 37 plus 29?" }] }];
const MODEL_TURN = { role: "model", parts: [{ functionCall: { name: "add", args: { a: 37, b: 29 }, id: "call_1" } }] };
const TOOL_RESPONSE_PART = { functionResponse: { name: "add", response: { result: 66 }, id: "call_1" } };

async function sendTurn(h: Harness, sessionId: string, contents: unknown[]): Promise<number> {
    const res = await fetch(`${h.proxyUrl}/v1beta/models/${CLAUDE_MODEL}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } }),
    });
    await res.text();
    return res.status;
}

test("#5392 claude-via-google: a user turn carrying a tool response forwards tool_result(functionResponse) FIRST", async () => {
    const fake = await startFakeUpstream("google");
    let h: Harness | undefined;
    try {
        h = await startHarness(fake.url);
        assert.equal(await sendTurn(h, "issue5392-claude", TURN_1_CONTENTS), 200, "turn 1 baseline completes");
        // No system instruction ⇒ no anchor notes; tiny session ⇒ nudge idle.
        // Nothing appends — the forwarded shape is the pure rebuild of the
        // client's own [functionResponse, text] order, which a Claude-behind-
        // Google backend REQUIRES (tool_result-first). Pre-fix bili reordered
        // this to [text, functionResponse], the exact bytes that 400'd upstream.
        assert.equal(
            await sendTurn(
                h,
                "issue5392-claude",
                [...TURN_1_CONTENTS, MODEL_TURN, { role: "user", parts: [TOOL_RESPONSE_PART, { text: "carry on" }] }],
            ),
            200,
            "turn 2 completes",
        );
        assert.equal(fake.violations.length, 0, `fake upstream violations:\n${fake.violations.join("\n")}`);

        const capturedBody = fake.requests[1]?.body as
            | { contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
            | undefined;
        const last = capturedBody?.contents?.[capturedBody.contents.length - 1];
        assert.ok(last, "forwarded body has contents");
        assert.equal(last.role, "user");
        const parts = last.parts ?? [];
        assert.ok(parts.length >= 2, `expected functionResponse + text parts, got ${JSON.stringify(parts)}`);
        // THE regression assertion: tool_result(functionResponse) leads the
        // user message that follows the assistant tool_use turn.
        assert.equal((parts[0]?.functionResponse as { id?: string } | undefined)?.id, "call_1", "forwarded user content LEADS with the functionResponse (tool_result) part");
        const t1 = typeof parts[1]?.text === "string" ? parts[1].text : "";
        assert.ok(t1.endsWith("carry on"), "the client text trails the functionResponse part");
    } finally {
        if (h) await h.close();
        await fake.close();
    }
});

test("#5392 claude-via-google: the SAME turn on a non-Claude target still normalizes text-first (WC-018 preserved)", async () => {
    // Guard against the carve-out overreaching: a Gemini-style target must keep
    // getting the WC-018 text-first reorder, or #3159 regresses.
    const fake = await startFakeUpstream("google");
    let h: Harness | undefined;
    try {
        // Re-point the harness at a non-claude model name on the same fake.
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: fake.url,
            routes: { [fake.url]: { models: { "gemini-test": { context: 1_000_000 } } } },
            modelContextLimit: 1_000_000,
            kernelConfig: defaultConfig(1_000_000),
            compress: { injectTool: true, injectNudge: true },
            stableSystemAnchor: true,
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
        };
        const proxy = await startServer(opts);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        h = {
            proxyUrl: `http://127.0.0.1:${port}/bili/${fake.url}`,
            close: () => new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve()))),
        };
        const post = async (sessionId: string, contents: unknown[]) => {
            const res = await fetch(`${h!.proxyUrl}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sessionId },
                body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 4096 } }),
            });
            await res.text();
            return res.status;
        };
        assert.equal(await post("issue5392-gemini", TURN_1_CONTENTS), 200, "turn 1 baseline completes");
        assert.equal(
            await post(
                "issue5392-gemini",
                [...TURN_1_CONTENTS, MODEL_TURN, { role: "user", parts: [TOOL_RESPONSE_PART, { text: "carry on" }] }],
            ),
            200,
            "turn 2 completes — WC-018 still enforced for the gemini target",
        );
        assert.equal(fake.violations.length, 0, `fake upstream violations:\n${fake.violations.join("\n")}`);
        const capturedBody = fake.requests[1]?.body as
            | { contents?: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
            | undefined;
        const last = capturedBody?.contents?.[capturedBody.contents.length - 1];
        const parts = last?.parts ?? [];
        assert.equal(typeof parts[0]?.text, "string", "non-claude target still leads with the TEXT part (WC-018 intact)");
        assert.equal((parts[1]?.functionResponse as { id?: string } | undefined)?.id, "call_1", "the functionResponse trails the text");
    } finally {
        if (h) await h.close();
        await fake.close();
    }
});
