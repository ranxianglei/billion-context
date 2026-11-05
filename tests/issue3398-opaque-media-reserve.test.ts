import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import {
    countImagesInParsedBody,
    countImagesInRawBody,
    imageTokensInParsedBody,
    imageTokensInRawBody,
    REMOTE_IMAGE_TOKENS,
} from "../src/image-tokens.ts";
import { imagePlaceholders } from "../src/image-note.ts";

// #3398: hosts' own attachment flows ride custom-shaped media parts through
// bili — dsh read_image results carry {type:"image",attachment:{…}} inside
// content arrays. The wire codecs forward such parts VERBATIM (kernel
// openai.ts allNonTextParts → rawOpenaiContentParts, #1205), but every size
// decision priced them as ZERO: the kernel text model sees msg.text only
// (#488), the host image reserve walks known shapes only (image_url/file/
// inlineData/input_image), and the cheap raw-body probe missed them entirely.
// Result in the issue log: 7.2MiB payloads flat for ~25 requests, billed
// input 14K→118K, zero folds — the trigger algebra read a small text channel
// against the full window and never fired.
//
// Fix under test: unrecognized non-text parts that the codec carries verbatim
// get the opaque charge (serialized-bytes/4 in BOTH billing modes — the flat
// pixels fallback overcharged tiny carriers and 413'd a legitimate codex side
// request, see the responses test below), gated per wire on the codec's
// actual preservation rule (e.g. openai charges user-role parts only — other
// roles reduce to text-only in the codec). Unit tests pin every gate; the
// integration test proves the end-to-end consequence: a payload whose mass is
// invisible-before/opaque-after now triggers preflight and folds its
// compressible text portion while the opaque media rides along byte-exact.
// Before the fix the integration assertions fail (zero summarization calls).

const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // 1x1 PNG

const CUSTOM_PART = { type: "image", attachment: { id: "att_1", data: "A".repeat(4096) } };
const customCostBytes = () => Math.ceil(JSON.stringify(CUSTOM_PART).length / 4);

function openaiBody(role: string, content: unknown): Record<string, unknown> {
    return { messages: [{ role, content }] };
}

test("#3398: openai custom-shape part on a user message is priced at serialized-bytes/4 (cost + count + raw probe)", () => {
    const body = openaiBody("user", [{ type: "text", text: "hi" }, CUSTOM_PART]);
    assert.equal(imageTokensInParsedBody("openai", body, "bytes"), customCostBytes());
    assert.equal(countImagesInParsedBody("openai", body), 1);
    const raw = JSON.stringify(body);
    assert.equal(imageTokensInRawBody("openai", raw, "bytes"), customCostBytes());
    assert.equal(countImagesInRawBody("openai", raw), 1);
});

test("#3398: the same part on tool/assistant/system roles is NOT priced (the codec drops non-text there)", () => {
    const content = [{ type: "text", text: "hi" }, CUSTOM_PART];
    for (const role of ["tool", "assistant", "system"]) {
        const body = openaiBody(role, content);
        assert.equal(imageTokensInParsedBody("openai", body, "bytes"), 0, `role=${role} cost`);
        assert.equal(countImagesInParsedBody("openai", body), 0, `role=${role} count`);
    }
});

test("#3398: all-text array content stays free (regression pin — the new probe marker must not tax text bodies)", () => {
    const body = openaiBody("user", [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    assert.equal(imageTokensInParsedBody("openai", body, "bytes"), 0);
    assert.equal(countImagesInParsedBody("openai", body), 0);
});

test("#3398: standard image_url pricing is unchanged by the opaque charge", () => {
    const dataUrl = `data:image/png;base64,${"B".repeat(8192)}`;
    const bodyData = openaiBody("user", [{ type: "image_url", image_url: { url: dataUrl } }]);
    assert.equal(imageTokensInParsedBody("openai", bodyData, "bytes"), Math.ceil(8192 / 4));
    const bodyRemote = openaiBody("user", [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }]);
    assert.equal(imageTokensInParsedBody("openai", bodyRemote, "bytes"), REMOTE_IMAGE_TOKENS);
});

test("#3398: anthropic nested tool_result media and redacted_thinking are priced; top-level document is not (the codec drops it)", () => {
    const body = openaiBody("user", [
        {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
                { type: "text", text: "ok" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "C".repeat(8192) } },
            ],
        },
        { type: "redacted_thinking", data: "D".repeat(8000) },
    ]);
    assert.equal(imageTokensInParsedBody("anthropic", body, "bytes"), Math.ceil(8192 / 4) + Math.ceil(8000 / 4));
    assert.equal(countImagesInParsedBody("anthropic", body), 2);
    const docBody = openaiBody("user", [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: "E".repeat(8192) } },
    ]);
    assert.equal(imageTokensInParsedBody("anthropic", docBody, "bytes"), 0);
    assert.equal(countImagesInParsedBody("anthropic", docBody), 0);
});

test("#3398: google unknown-shape parts are priced; text/function carriers stay on their own channels", () => {
    const weird = { weird: { x: "F".repeat(2048) } };
    const body = {
        contents: [{
            role: "user",
            parts: [weird, { text: "hello" }, { functionCall: { name: "f", args: {} } }, { inlineData: { mimeType: "image/png", data: "G".repeat(4096) } }],
        }],
    };
    assert.equal(
        imageTokensInParsedBody("google", body, "bytes"),
        Math.ceil(JSON.stringify(weird).length / 4) + Math.ceil(4096 / 4),
    );
    assert.equal(countImagesInParsedBody("google", body), 2);
});

test("#3398: responses user-item custom parts are priced; codex control items (compaction handoffs) stay free", () => {
    // Regression pin for the CI failure on the first PR head: charging the
    // whole unknown item (flat pixels fallback under default-auto=pixels) put
    // ~32K tokens of reserve on a 304-byte side request → fail-closed 413.
    const userMedia = { type: "input_media", blob: "H".repeat(2048) };
    const biliLocal = { type: "compaction", id: "fc_bili_local", encrypted_content: "bili:acp:summary retained" };
    const upstream = { type: "compaction", id: "cmp_upstream", encrypted_content: "opaque-upstream-blob" };
    const trigger = { type: "compaction_trigger" };
    const body = {
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, userMedia] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }, { type: "output_media", blob: "J".repeat(2048) }] },
            biliLocal,
            upstream,
            trigger,
            { type: "message", role: "user", content: "plain string" },
            { type: "reasoning", summary: "thoughts" },
        ],
    };
    assert.equal(imageTokensInParsedBody("responses", body, "bytes"), Math.ceil(JSON.stringify(userMedia).length / 4));
    assert.equal(countImagesInParsedBody("responses", body), 1);
});

test("#3398: the configured cap applies to opaque parts; both billing modes price by serialized bytes", () => {
    const body = openaiBody("user", [CUSTOM_PART]);
    assert.equal(imageTokensInParsedBody("openai", body, "bytes", 500), 500);
    assert.equal(imageTokensInParsedBody("openai", body, "pixels"), customCostBytes());
});

test("#3398: image-note renders distinct [media: …] placeholders for opaque payloads restorable only as a note", () => {
    const kb = Math.max(1, Math.round(JSON.stringify(CUSTOM_PART).length / 1024));
    const mCustom: BiliMessage = { id: "m00001", role: "user", contentType: "text", rawOpenaiContentParts: [CUSTOM_PART] };
    assert.deepEqual(imagePlaceholders(mCustom), [`[media: image ~${kb}KB]`]);
    const mMixed: BiliMessage = {
        id: "m00002",
        role: "user",
        contentType: "text",
        rawOpenaiContentParts: [{ type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } }, CUSTOM_PART],
    };
    const mixed = imagePlaceholders(mMixed);
    assert.equal(mixed.length, 2);
    assert.equal(mixed[0], "[image: png 1x1]");
    assert.ok(mixed[1].startsWith("[media:"), `got ${mixed[1]}`);
    const mToolResult: BiliMessage = {
        id: "m00003",
        role: "user",
        contentType: "tool-result",
        rawAnthropicBlock: {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
                { type: "text", text: "ok" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 } },
            ],
        },
    };
    assert.deepEqual(imagePlaceholders(mToolResult), ["[image: png 1x1]"]);
});

// ── Integration: the end-to-end consequence ──────────────────────────────────
// WINDOW 200K, bytes-billing route. All ASCII → chars/4, matching the host
// estimator. Sizing:
//   10 slice msgs × 72_000-char attachment payload ≈ 180K opaque tokens
//   30 filler rounds × ~5.1K chars ≈ 38K text tokens
// Pre-fix (opaque priced 0): decisionTrigger ≈ 38K < textBudget 200K → no fold.
// Post-fix: textBudget = 200K − 180K = 20K ≤ textChannel → preflight fires and
// folds the filler until calibrated ≈ 183K < 200K fits; slices stay resident.

const WINDOW = 200_000;
const MODEL = "ds-flash-3398";
const SLICE_PAD = 72_000;
const SUMMARY_MARKER = "TASK: The conversation segment below";

type Call = { summary: boolean; raw: string };
let CALLS: Call[] = [];

function chatSse(text: string, finishReason: string): string {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return chunk({ role: "assistant" }, null) + chunk({ content: text }, null) + chunk({}, finishReason) + "data: [DONE]\n\n";
}

function mockUpstream(): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const summary = raw.includes(SUMMARY_MARKER);
            CALLS.push({ summary, raw });
            const text = summary ? "PREFLIGHT SUMMARY: earlier filler turns were folded into this stand-in note." : "forwarded answer";
            if (!raw.includes('"stream":true')) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: summary ? "chatcmpl-sum" : "chatcmpl-fwd", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(chatSse(text, "stop"));
        });
    });
}

async function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: WINDOW } }, imageBilling: "bytes" } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 2000,
            compress: { minCompressRange: 1000, maxSummaryLength: 20000, minSummaryLength: 50 },
        }),
        compress: { injectTool: true, injectNudge: true },
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
    return proxy;
}

function fillerHistory(rounds: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < rounds; i++) {
        out.push({ role: "user", content: `FILLER_u_${i}: ${"lorem ipsum dolor sit amet ".repeat(150)}` });
        out.push({ role: "assistant", content: `FILLER_a_${i}: ${"lorem ipsum dolor sit amet ".repeat(40)}` });
    }
    return out;
}

function sliceMessages(n: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
        out.push({
            role: "user",
            content: [
                { type: "text", text: `slice ${i} read done` },
                { type: "image", attachment: { id: `slice_${i}`, data: "A".repeat(SLICE_PAD) } },
            ],
        });
    }
    return out;
}

test("#3398: opaque-media payload triggers preflight and folds the text portion while media rides along", async () => {
    CALLS = [];
    const upstream = mockUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const uport = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(uport);
    try {
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${uport}/v1/chat/completions`;
        const headers = { "content-type": "application/json", "x-acp-session": "sess-3398" };

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }] }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const reqBody = JSON.stringify({
            model: MODEL,
            stream: true,
            messages: [...fillerHistory(30), ...sliceMessages(10), { role: "user", content: "continue" }],
        });
        const r2 = await fetch(url, { method: "POST", headers, body: reqBody });
        assert.equal(r2.status, 200, "the opaque-media payload forwards after folding, not 502");
        await r2.text();

        const mains = CALLS.filter((c) => !c.summary);
        const sums = CALLS.filter((c) => c.summary);
        // THE TOOTH: preflight actually ran and spent summarization calls.
        // Before the fix the opaque mass was priced 0, the trigger read a small
        // text channel against the full window, and zero folds ever happened.
        assert.ok(sums.length >= 1, `preflight folded the compressible filler (got ${sums.length} summarization calls)`);
        const last = mains[mains.length - 1].raw;
        for (let i = 0; i < 10; i++) assert.ok(last.includes(`slice_${i}`), `slice_${i} stayed resident through the fold`);
        // Fold direction is a kernel policy (#2682 largest-first outside the
        // recent zone); assert mass left the wire, not which end went first.
        const fillerCount = (s: string): number => s.match(/FILLER_u_\d+/g)?.length ?? 0;
        assert.ok(fillerCount(last) < fillerCount(reqBody), `filler was folded out (${fillerCount(last)} of ${fillerCount(reqBody)} rounds still on the wire)`);
        assert.ok(last.length < reqBody.length, "the forwarded payload shrank after folding");
    } finally {
        upstream.close();
        proxy.close();
    }
});
