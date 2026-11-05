import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createRunawayGuard,
    wrapStreamWithRunawayGuard,
    TEXT_RUN_THRESHOLD,
    type RunawayVerdict,
} from "../src/runaway-guard.ts";

// #3260 regression: output-side single-codepoint repetition breaker (form ② / #3946:
// one symbol string for ~22 minutes). Port of pi's findDegenerateRuns minRun semantics
// onto bili's existing intrinsic stream terminator. Trips on >= 200 consecutive
// identical codepoints in DECODED model text only; never on raw bytes (base64 /
// tool-argument blobs) nor on cumulative snapshot events; byte-exact forwarding and
// the clean-EOF trip contract are preserved.

const enc = new TextEncoder();

// #3406 item 1: the threshold resolves through the guardrails.textRunThreshold
// knob (BILI_GUARDRAIL_TEXT_RUN_THRESHOLD > config file > 200). Resolution is
// per-guard at createRunawayGuard() time, so the env var is set around guard
// creation / stream wrapping in these tests.
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
    const saved: [string, string | undefined][] = [];
    for (const [k, v] of Object.entries(vars)) { saved.push([k, process.env[k]]); process.env[k] = v; }
    try { return await fn(); } finally {
        for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

function sseFrame(json: string): Uint8Array {
    return enc.encode(`data: ${json}\n\n`);
}

function openaiDelta(content: string): string {
    return JSON.stringify({ choices: [{ index: 0, delta: { content } }] });
}

function wrapParts(parts: Uint8Array[], verdicts: RunawayVerdict[]): ReadableStream<Uint8Array> {
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
        },
    });
    return wrapStreamWithRunawayGuard(src, (v) => verdicts.push(v));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const r = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

test("core: 200 identical codepoints trips as text-run (threshold parity with pi minRun)", () => {
    const g = createRunawayGuard();
    const v = g.feedText("=".repeat(TEXT_RUN_THRESHOLD));
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "text-run");
    assert.equal(v.detail?.maxTextRun, TEXT_RUN_THRESHOLD);
    assert.equal(v.detail?.textRunChar, "=");
});

test("core: threshold-1 does not trip; the final codepoint across calls trips (stateful)", () => {
    const g = createRunawayGuard();
    let v = g.feedText("=".repeat(TEXT_RUN_THRESHOLD - 1));
    assert.equal(v.tripped, false);
    v = g.feedText("=");
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "text-run");
});

test("core: a different codepoint resets the run (199 + x + 199 stays under)", () => {
    const g = createRunawayGuard();
    const v = g.feedText("=".repeat(TEXT_RUN_THRESHOLD - 1) + "x" + "=".repeat(TEXT_RUN_THRESHOLD - 1));
    assert.equal(v.tripped, false, JSON.stringify(v.detail));
});

test("core: astral codepoints count as ONE unit (emoji x200 trips)", () => {
    const g = createRunawayGuard();
    const v = g.feedText("\u{1F501}".repeat(TEXT_RUN_THRESHOLD));
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "text-run");
    assert.equal(v.detail?.textRunChar, "\u{1F501}");
});

test("core: alternating characters never trip regardless of length", () => {
    const g = createRunawayGuard();
    const v = g.feedText("ab".repeat(50_000));
    assert.equal(v.tripped, false);
});

test("core: sub-threshold runs expose maxTextRun in detail (near-miss observability)", () => {
    const g = createRunawayGuard();
    const v = g.feedText("z".repeat(180));
    assert.equal(v.tripped, false);
    assert.equal(v.detail?.maxTextRun, 180);
    assert.equal(v.detail?.textRunChar, "z");
});

test("wrap: openai SSE frames building the run across frames trip; byte-exact prefix, clean EOF", async () => {
    // 37 '=' per frame: cumulative 185 after 5 frames (< 200), 222 reached inside frame
    // 6, so the guard trips while inspecting frame 6 and exactly frames 1..5 forward.
    const pieceLen = 37;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 7; i++) parts.push(sseFrame(openaiDelta("=".repeat(pieceLen))));
    const tail = enc.encode("TAIL-MUST-NOT-BE-FORWARDED");
    parts.push(tail);
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "text-run");
    assert.ok(!out.toString("utf8").includes("TAIL-MUST-NOT-BE-FORWARDED"));
    const forwardedFrames = Math.floor((TEXT_RUN_THRESHOLD - 1) / pieceLen); // 5
    assert.deepEqual(out, Buffer.concat(parts.slice(0, forwardedFrames)));
});

test("wrap: exactly threshold-1 across frames does NOT trip; all bytes forwarded", async () => {
    const parts: Uint8Array[] = [];
    let emitted = 0;
    while (emitted < TEXT_RUN_THRESHOLD - 1) {
        const n = Math.min(37, TEXT_RUN_THRESHOLD - 1 - emitted);
        parts.push(sseFrame(openaiDelta("=".repeat(n))));
        emitted += n;
    }
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0);
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: 300 '=' inside a tool-call ARGUMENT must NOT trip (#1039 user intent)", async () => {
    const argPayload = JSON.stringify({ path: "/tmp/blob.bin", data: "=".repeat(300) });
    const frame = JSON.stringify({
        choices: [
            {
                index: 0,
                delta: {
                    tool_calls: [
                        { index: 0, id: "call_1", type: "function", function: { name: "write", arguments: argPayload } },
                    ],
                },
            },
        ],
    });
    const parts = [sseFrame(frame), sseFrame(openaiDelta(" done."))];
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: anthropic content_block_delta frames (spaces x240) trip", async () => {
    const frame = (t: string): string =>
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) parts.push(sseFrame(frame(" ".repeat(40))));
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "text-run");
    assert.equal(verdicts[0].detail?.textRunChar, " ");
    assert.ok(out.length < Buffer.concat(parts).length, "stream cut before the tail");
});

test("wrap: responses output_text.delta trips; a .completed snapshot ALONE does not (no double-count)", async () => {
    const deltaFrame = (t: string): string =>
        JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: t });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) parts.push(sseFrame(deltaFrame("-".repeat(45))));
    const verdicts: RunawayVerdict[] = [];
    await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "text-run");

    const snap = JSON.stringify({
        type: "response.completed",
        response: {
            id: "resp_1",
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "-".repeat(300), annotations: [] }],
                },
            ],
        },
    });
    const snapVerdicts: RunawayVerdict[] = [];
    await collect(wrapParts([sseFrame(snap)], snapVerdicts));
    assert.equal(snapVerdicts.length, 0, JSON.stringify(snapVerdicts));
});

test("wrap: responses function_call_arguments.delta with 300 '=' does NOT trip (argument bytes)", async () => {
    const f = (t: string): string =>
        JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", call_id: "call_1", delta: t });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) parts.push(sseFrame(f("=".repeat(120))));
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: Google wire functionCall.args with 300 '=' does NOT trip (argument bytes)", async () => {
    // Google streaming chunk: the tool call rides candidates[].content.parts[].functionCall.args
    // and its payload leaf is typically named `content` — a TEXT_LEAF_KEYS name. Google events
    // carry no top-level `type`, so the function_call frame gate cannot exempt them; only the
    // branch exclusion can. Before it, a write-tool payload of >= 200 identical characters
    // aborted the whole turn mid-stream.
    const frame = JSON.stringify({
        candidates: [
            {
                content: {
                    role: "model",
                    parts: [{ functionCall: { name: "write", args: { path: "notes.ts", content: "=".repeat(300) } } }],
                },
            },
        ],
    });
    const parts = [sseFrame(frame), sseFrame(openaiDelta(" done."))];
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: Google wire functionCall.args.text (second leaf-key spelling) with 300 '-' does NOT trip", async () => {
    // The argument field can carry ANY TEXT_LEAF_KEYS name; pin the second spelling
    // so the exclusion holds by BRANCH name (functionCall/args), not field-name luck.
    // Ported from duplicate PR #3375 (closed as a dup of this PR; #3358).
    const frame = JSON.stringify({
        candidates: [
            {
                content: {
                    role: "model",
                    parts: [{ functionCall: { name: "edit", args: { text: "-".repeat(300) } } }],
                },
            },
        ],
    });
    const parts = [sseFrame(frame)];
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: mixed Google frame — prose part + 300-'=' arg part coexist without tripping", async () => {
    // One frame carrying BOTH a model-text part and a huge argument part: the run
    // tracker must see only the prose, and every byte forwards untouched.
    // Ported from duplicate PR #3375 (closed as a dup of this PR; #3358).
    const frame = JSON.stringify({
        candidates: [
            {
                content: {
                    role: "model",
                    parts: [
                        { text: "Writing the file now." },
                        { functionCall: { name: "write", args: { path: "/tmp/x.txt", content: "=".repeat(300) } } },
                    ],
                },
            },
        ],
    });
    const parts = [
        sseFrame(frame),
        sseFrame(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: " done." }] } }] })),
    ];
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0, JSON.stringify(verdicts));
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: Google wire parts[].text with 300 '=' still trips (exclusion must not swallow model text)", async () => {
    // Companion to the args test: the same carrier shape with the run in the MODEL TEXT
    // leaf (parts[].text) must still trip — proves the branch exclusion is scoped to
    // functionCall.args, not to the whole Google candidates/content/parts subtree.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
        parts.push(sseFrame(JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: "=".repeat(120) }] } }],
        })));
    }
    const verdicts: RunawayVerdict[] = [];
    await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 1, JSON.stringify(verdicts));
    assert.equal(verdicts[0].reason, "text-run");
});

test("wrap: 3-byte-at-a-time feed crosses decoder/frame boundary splits and still trips", async () => {
    const sse = Array.from({ length: 7 }, () => `data: ${openaiDelta("=".repeat(37))}\n\n`).join("");
    const full = enc.encode(sse);
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            for (let i = 0; i < full.length; i += 3) c.enqueue(full.subarray(i, i + 3));
            c.close();
        },
    });
    const verdicts: RunawayVerdict[] = [];
    await collect(wrapStreamWithRunawayGuard(src, (v) => verdicts.push(v)));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "text-run");
});

test("wrap: NDJSON server (bare-newline events, no blank line) trips via the fallback splitter", async () => {
    const line = openaiDelta("==");
    const body = Array.from({ length: 2000 }, () => line).join("\n");
    assert.ok(Buffer.byteLength(body) >= 65536, "sanity: large enough to engage the NDJSON fallback");
    const verdicts: RunawayVerdict[] = [];
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(body));
            c.close();
        },
    });
    await collect(wrapStreamWithRunawayGuard(src, (v) => verdicts.push(v)));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "text-run");
});

test("wrap: 200KB of legit prose passes untouched (no trip, byte-exact)", async () => {
    const sentence = "Compression keeps the prefix cache warm while the session grows by a few thousand tokens per turn. ";
    const body = sentence.repeat(Math.ceil(200_000 / sentence.length));
    const full = enc.encode(body);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < full.length; i += 8192) chunks.push(full.subarray(i, i + 8192));
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(chunks, verdicts));
    assert.equal(verdicts.length, 0);
    assert.deepEqual(out, Buffer.from(full));
});

test("wrap: a 150-char '=' separator line (margin under threshold) does NOT trip", async () => {
    const parts = [sseFrame(openaiDelta("=".repeat(150))), sseFrame(openaiDelta(" rest of the answer"))];
    const verdicts: RunawayVerdict[] = [];
    const out = await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 0);
    assert.deepEqual(out, Buffer.concat(parts));
});

test("wrap: acp-tag flood still trips as acp-enumeration with the text lane active", async () => {
    const tag = `\x3cacp tokens="0" type="text">m02040\x3c/acp\x3c/acp>\n`;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 265; i++) parts.push(enc.encode(tag));
    const verdicts: RunawayVerdict[] = [];
    await collect(wrapParts(parts, verdicts));
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].reason, "acp-enumeration");
});

test("knob: default 200 stays ON with the env var unset (behavior unchanged, #3406)", () => {
    const saved = process.env.BILI_GUARDRAIL_TEXT_RUN_THRESHOLD;
    delete process.env.BILI_GUARDRAIL_TEXT_RUN_THRESHOLD;
    try {
        const g = createRunawayGuard();
        assert.equal(g.feedText("=".repeat(199)).tripped, false);
        assert.equal(g.feedText("=").tripped, true, "exactly 200 still trips — default unchanged");
    } finally {
        if (saved !== undefined) process.env.BILI_GUARDRAIL_TEXT_RUN_THRESHOLD = saved;
    }
});

test("knob: BILI_GUARDRAIL_TEXT_RUN_THRESHOLD=1000 raises the trip point (env tier)", async () => {
    await withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "1000" }, () => {
        const g = createRunawayGuard();
        assert.equal(g.feedText("=".repeat(500)).tripped, false, "a 500-run that would die at the default 200 survives");
        const v = g.feedText("=".repeat(500));
        assert.equal(v.tripped, true, "still trips at the raised threshold (stateful across calls)");
        assert.equal(v.reason, "text-run");
        assert.equal(v.detail?.maxTextRun, 1000);
    });
});

test("knob: threshold 0 disables the lane — 5000-char same-codepoint run streams through byte-exact", async () => {
    await withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "0" }, async () => {
        // A code-comment separator wall: 5000 '=' as text deltas — far past the 200
        // default; with the knob off nothing trips and every byte forwards.
        const parts: Uint8Array[] = [];
        for (let i = 0; i < 25; i++) parts.push(sseFrame(openaiDelta("=".repeat(200))));
        // The thinking channel sits inside the lane too — it must switch off with it.
        const think = JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "-".repeat(1000) } }] });
        parts.push(sseFrame(think));
        parts.push(sseFrame(openaiDelta(" done.")));
        const verdicts: RunawayVerdict[] = [];
        const out = await collect(wrapParts(parts, verdicts));
        assert.equal(verdicts.length, 0);
        assert.deepEqual(out, Buffer.concat(parts), "byte-exact end-to-end, no cut");
    });
});

test("knob: threshold 0 disables ONLY the text-run lane — acp-tag flood still trips (#3406)", async () => {
    await withEnv({ BILI_GUARDRAIL_TEXT_RUN_THRESHOLD: "0" }, async () => {
        const tag = `\x3cacp tokens="0" type="text">m02040\x3c/acp\x3c/acp>\n`;
        const parts: Uint8Array[] = [];
        for (let i = 0; i < 265; i++) parts.push(enc.encode(tag));
        const verdicts: RunawayVerdict[] = [];
        await collect(wrapParts(parts, verdicts));
        assert.equal(verdicts.length, 1);
        assert.equal(verdicts[0].reason, "acp-enumeration", "disabling the text-run lane must not disarm the other lanes");
    });
});
