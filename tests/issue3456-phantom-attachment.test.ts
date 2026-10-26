import { test } from "node:test";
import assert from "node:assert/strict";
import { noteKnownAttachmentIds, resetPhantomLedgersForTest, scanModelOutputForPhantomAttachments } from "../src/phantom-attachment.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

// #3456: message-shaped fabrication — the model invents whole transcript
// continuations (fake user turns, fake attachment annotations with hashes that
// exist nowhere in the session's actual traffic) inside its reasoning and then
// answers them as real input. Observe-first detector: warn-only, never rewrite.

const FAKE_HEX = ("ab12cd34ef56").repeat(6).slice(0, 64);
const OTHER_HEX = ("fedcba987654").repeat(6).slice(0, 64);
const WARN_TAG = "[phantom-attachment]";

function makeSession(id: string, protocol: string): Session {
    return {
        id,
        protocol,
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function dataLines(raw: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const d = line.slice(6);
        if (d === "[DONE]") continue;
        out.push(JSON.parse(d) as Record<string, unknown>);
    }
    return out;
}

function openaiField(raw: string, field: string): string {
    let s = "";
    for (const ev of dataLines(raw)) {
        const choices = ev["choices"];
        if (!Array.isArray(choices)) continue;
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta[field] === "string") s += delta[field];
    }
    return s;
}

test("ledger: request-primed id echoed by the model does not warn (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        const reqText = JSON.stringify({ messages: [{ role: "user", content: [{ type: "file", file_id: "file-api-realid1234" }] }] });
        noteKnownAttachmentIds("s-known", reqText);
        scanModelOutputForPhantomAttachments("s-known", 'the attachment file-api-realid1234 says so');
    } finally {
        setLogCapture(null);
    }
    assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `no phantom warn expected, got: ${logs.join(" | ")}`);
});

test("ledger: unknown sha256 in model output warns once, repeats stay silent, new ids re-warn (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("s-fake", '{"messages":[{"role":"user","content":"hi"}]}');
        // birth turn: two fabricated digests in one output
        scanModelOutputForPhantomAttachments("s-fake", `Image "a.png" (sha256:${FAKE_HEX}) Image "b.png" (sha256:${OTHER_HEX})`);
        let warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `expected one warn line, got: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes(`[s-fake]`), warns[0]);
        assert.ok(warns[0].includes(`2 attachment id(s)`), warns[0]);
        assert.ok(warns[0].includes(FAKE_HEX) && warns[0].includes(OTHER_HEX), warns[0]);
        assert.ok(warns[0].includes("#3456 observe-only"), warns[0]);
        // same output repeated (re-sent history / retried attempt): silent
        scanModelOutputForPhantomAttachments("s-fake", `Image "a.png" (sha256:${FAKE_HEX}) Image "b.png" (sha256:${OTHER_HEX})`);
        warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `repeat must not re-warn, got: ${logs.join(" | ")}`);
        // a NEW fabrication later still warns
        const third = ("cafebabe12345678").repeat(4).slice(0, 64);
        scanModelOutputForPhantomAttachments("s-fake", `(sha256:${third})`);
        warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 2, `new id must warn again, got: ${logs.join(" | ")}`);
        assert.ok(warns[1].includes(third), warns[1]);
    } finally {
        setLogCapture(null);
    }
});

test("ledger: uppercase rendering of a request-primed digest dedupes against it (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("s-case", `request carries (sha256:${FAKE_HEX})`);
        scanModelOutputForPhantomAttachments("s-case", `echoing (sha256:${FAKE_HEX.toUpperCase()})`);
    } finally {
        setLogCapture(null);
    }
    assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `case-insensitive dedup failed: ${logs.join(" | ")}`);
});

test("extraction: only attachment-shaped identifiers match; bare hex prose stays quiet (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("s-shape", "{}");
        // bare 64-hex without the sha256: prefix, short hashes, non-file ids
        scanModelOutputForPhantomAttachments("s-shape", `checksum ${FAKE_HEX} and short ab12cd34ef56 and token ghp_longtokenvalue`);
        assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `bare hex must not match: ${logs.join(" | ")}`);
        // file_id JSON value, spaced and unspaced
        scanModelOutputForPhantomAttachments("s-shape", `{"type":"file","file_id":"file-api-spaced99"} and {"type":"file","file_id":"file-api-tight99"}`);
        const warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `expected one warn for both file_ids, got: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes("file-api-spaced99"), warns[0]);
        assert.ok(warns[0].includes("file-api-tight99"), warns[0]);
    } finally {
        setLogCapture(null);
    }
});

test("extraction: store-path digest form matches and dedupes against the sha256: prefix (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        // request shipped the prefixed form; output uses the store-path form
        noteKnownAttachmentIds("s-path", `(sha256:${FAKE_HEX})`);
        scanModelOutputForPhantomAttachments("s-path", `see /attachments/v1/objects/ab/${FAKE_HEX} for that`);
        assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `path form must dedupe against prefix form: ${logs.join(" | ")}`);
        // and the other way round
        noteKnownAttachmentIds("s-path2", `/attachments/v1/objects/cd/${OTHER_HEX}`);
        scanModelOutputForPhantomAttachments("s-path2", `(sha256:${OTHER_HEX.toUpperCase()})`);
        assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `prefix form must dedupe against path form: ${logs.join(" | ")}`);
        // unknown path-form digest still warns, keyed by the bare lowercase hex
        const third = ("0123456789abcdef").repeat(4);
        scanModelOutputForPhantomAttachments("s-path2", `objects/ef/${third}`);
        const warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `unknown path-form digest must warn: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes(third), warns[0]);
    } finally {
        setLogCapture(null);
    }
});

test("extraction: Windows backslash store-path forms match, incl. the escaped incident rendering (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        // The v0.1.197 session's normalized-copy annotation rendered the DSH
        // store path with DOUBLED backslashes (escaped Windows path) — the
        // exact recorded shape. Fixtures dodge two template-literal traps
        // that survive even String.raw: a backslash directly before ${…}
        // disables the interpolation, and a lone trailing backslash escapes
        // the closing backtick — so ids are concatenated / backslashes
        // doubled explicitly instead.
        const escapedWin =
            String.raw`Normalized copy (read-only; may be resized or re-encoded): "C:\Users\pya39\.dsh\attachments\v1\objects\\0b\\` +
            FAKE_HEX +
            ` (750x930px, image/png).`;
        scanModelOutputForPhantomAttachments("s-win", escapedWin);
        let warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `escaped Windows path must match: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes(FAKE_HEX), warns[0]);
        // single-backslash rendering (unescaped) matches too
        const plainWin = `copy at C:\\Users\\x\\.dsh\\attachments\\v1\\objects\\cd\\${OTHER_HEX}`;
        scanModelOutputForPhantomAttachments("s-win", plainWin);
        warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 2, `single-backslash path must match: ${logs.join(" | ")}`);
        assert.ok(warns[1].includes(OTHER_HEX), warns[1]);
        // and both forms still dedupe against the sha256:-prefixed request side
        noteKnownAttachmentIds("s-win-dedupe", `(sha256:${FAKE_HEX})`);
        scanModelOutputForPhantomAttachments("s-win-dedupe", escapedWin);
        assert.equal(logs.filter((l) => l.includes(WARN_TAG)).length, 2, `backslash path must dedupe against prefix form: ${logs.join(" | ")}`);
    } finally {
        setLogCapture(null);
    }
});

test("extraction: camelCase fileId key matches alongside snake_case (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("s-camel", "{}");
        scanModelOutputForPhantomAttachments("s-camel", '{"fileId":"att-9f8e7d6c5b"}');
        const warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `camelCase fileId must match: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes("att-9f8e7d6c5b"), warns[0]);
    } finally {
        setLogCapture(null);
    }
});

test("golden sample: the seven fabricated digests of the v0.1.197 incident warn once (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        // turn-3 request carried one real image only — none of these digests
        const incidentDigests = [
            "0bbaae1d79ee22507bf4d2a7f77a3e2bc2c8c3ef4d54d36e0df1ecf1bf02f9f9",
            "71e2a885f7183d496e2aa2a2d63ccd5fd5b8f1ac7d50ab44bbca94434e7caf86",
            "d5a21330ecb2fc8df337d38bb8f8eba50f07ac823cb36dbb49bd9592ad3b81de",
            "bd781e0683c2345e5873319afc386100af702737a87fe82c31d6b8cd1571237a",
            "0c44e286d436f0b10d21ba2a10cf6e2f2d02f6493d3d378983ba5c2852407f20",
            "ff65317b1ef13284e330937eab30a1eff534b8e4bcee6e9037ba70b7c72c5912",
            "e511248bf53e1d46f18bf865eef4f98ba96d4f1f9e7c4b34c77e9d19630694b6",
        ];
        noteKnownAttachmentIds("s-incident", '{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}');
        const fabricated = incidentDigests.map((d) => `Image "image.png" (sha256:${d})`).join(" ");
        scanModelOutputForPhantomAttachments("s-incident", fabricated);
        const warns = logs.filter((l) => l.includes(WARN_TAG));
        assert.equal(warns.length, 1, `expected one warn line for all seven, got: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes("[s-incident]"), warns[0]);
        assert.ok(warns[0].includes("7 attachment id(s)"), warns[0]);
        assert.ok(warns[0].includes(incidentDigests[0]), warns[0]);
        assert.ok(warns[0].includes(incidentDigests[4]), warns[0]);
        assert.ok(warns[0].includes("+2 more"), warns[0]);
        // birth semantics: the re-sent fabrication on the next turn is silent
        scanModelOutputForPhantomAttachments("s-incident", fabricated);
        assert.equal(logs.filter((l) => l.includes(WARN_TAG)).length, 1, "re-sent fakes must stay silent");
    } finally {
        setLogCapture(null);
    }
});

test("no session id: both sides are safe no-ops (#3456)", () => {
    resetPhantomLedgersForTest();
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds(undefined, `sha256:${FAKE_HEX}`);
        scanModelOutputForPhantomAttachments(undefined, `sha256:${FAKE_HEX}`);
    } finally {
        setLogCapture(null);
    }
    assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `anonymous session must not warn: ${logs.join(" | ")}`);
});

test("ledger map is bounded: oldest session evicts past the cap (#3456)", () => {
    resetPhantomLedgersForTest();
    const CAP = 2048;
    // each priming text carries a real attachment id — priming text without
    // ids returns before the ledger is created and would never fill the map
    for (let i = 0; i < CAP; i++) noteKnownAttachmentIds(`s-cap-${i}`, `{"file_id":"file-api-pad${String(i).padStart(4, "0")}"}`);
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        // creating one more ledger evicts s-cap-0 (oldest): its once-known id
        // is gone, so an output that quoted it now scans as a phantom
        noteKnownAttachmentIds("s-cap-new", `{"file_id":"file-api-newest01"}`);
        scanModelOutputForPhantomAttachments("s-cap-0", `still referencing file-api-pad0000`);
    } finally {
        setLogCapture(null);
    }
    const warns = logs.filter((l) => l.includes(WARN_TAG));
    assert.equal(warns.length, 1, `evicted session must scan fresh, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[s-cap-0]"), warns[0]);
    assert.ok(warns[0].includes("file-api-pad0000"), warns[0]);
});

test("openai chat pipe: fabricated annotation in reasoning_content warns once and forwards verbatim (#3456)", async () => {
    resetPhantomLedgersForTest();
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        // relay-side priming: the request carried ONE real attachment only
        noteKnownAttachmentIds("sess-p3456", '{"messages":[{"role":"user","content":[{"type":"file","file_id":"file-api-realone"}]}]}');
        const fab = `wait, the user sent more screenshots: Image "image.png" (sha256:${FAKE_HEX}) then asked "还有这么多"?`;
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ reasoning_content: fab }),
            chatChunk({ content: "回答你自造的问题…" }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-p3456", "openai"));
    } finally {
        setLogCapture(null);
    }
    assert.equal(openaiField(out.join(""), "reasoning_content"), `wait, the user sent more screenshots: Image "image.png" (sha256:${FAKE_HEX}) then asked "还有这么多"?`, "reasoning channel byte-exact — identity filter untouched");
    const warns = logs.filter((l) => l.includes(WARN_TAG));
    assert.equal(warns.length, 1, `expected exactly one phantom warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[sess-p3456]"), warns[0]);
    assert.ok(warns[0].includes(FAKE_HEX), warns[0]);
    assert.ok(!warns[0].includes("file-api-realone"), "request-primed id must not be flagged");
});

test("openai chat pipe: model echoing a request-primed id produces no phantom warn (#3456)", async () => {
    resetPhantomLedgersForTest();
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("sess-p3456b", '{"messages":[{"role":"user","content":[{"type":"file","file_id":"file-api-echoed1"}]}]}');
        const events = [
            chatChunk({ content: `about your upload file-api-echoed1…` }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession("sess-p3456b", "openai"));
    } finally {
        setLogCapture(null);
    }
    assert.ok(!logs.some((l) => l.includes(WARN_TAG)), `primed echo must not warn: ${logs.join(" | ")}`);
});

test("responses pipe: fabricated file id in reasoning summary warns once (#3456)", async () => {
    resetPhantomLedgersForTest();
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => logs.push(msg));
    try {
        noteKnownAttachmentIds("sess-r3456", '{"input":"no attachments here"}');
        const events = [
            sse({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } }),
            sse({ type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }),
            sse({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: `the user attached {"type":"file","file_id":"file-api-ghost77"} earlier` }),
        ];
        await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession("sess-r3456", "responses"));
    } finally {
        setLogCapture(null);
    }
    let deltaText = "";
    for (const ev of dataLines(out.join(""))) {
        if (ev["type"] === "response.reasoning_summary_text.delta" && typeof ev["delta"] === "string") deltaText += ev["delta"];
    }
    assert.equal(deltaText, `the user attached {"type":"file","file_id":"file-api-ghost77"} earlier`, "reasoning summary forwarded verbatim");
    const warns = logs.filter((l) => l.includes(WARN_TAG));
    assert.equal(warns.length, 1, `expected exactly one phantom warn, got: ${logs.join(" | ")}`);
    assert.ok(warns[0].includes("[sess-r3456]"), warns[0]);
    assert.ok(warns[0].includes("file-api-ghost77"), warns[0]);
});
