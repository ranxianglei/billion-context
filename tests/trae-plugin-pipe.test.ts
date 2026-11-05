// #1295: coverage for the trae plugin pipe (pipePluginTraeWithStrip) — the
// plugin lane's trae turns used to fall into pipePluginChatWithStrip, which
// recognizes only a quoted `finish_reason"`... chunk or the `[DONE]` sentinel as
// the terminal. Trae emits neither: its terminator is the `done` frame, so a
// CLEAN turn hit EOF with sawTerminal=false and the client was handed a
// synthesized in-band error AFTER a complete answer (144 hits on the live
// seat). These tests pin the fix: verbatim frames on the clean path, an
// error frame only on a real cut, tag-echo stripped from the prose field only,
// and the token_usage frame feeding lastInputTokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { pipePluginTraeWithStrip } from "../src/plugin.ts";

const FIXTURE = new URL("./fixtures/trae-2026-11-04-two-tool-calls.sse.txt", import.meta.url);
const REAL_TURN = readFileSync(FIXTURE, "utf8");

const LT = "\x3c";
const TAG = (ref: string) => `${LT}acp tokens="2" type="text">${ref}${LT}/acp>`;

function makeRes(chunks: string[]) {
    return {
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

function streamOf(chunks: string[], then?: "error"): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                controller.enqueue(enc.encode(chunks[i]));
                i += 1;
            } else if (then === "error") {
                controller.error(new Error("upstream socket reset mid-stream"));
            } else {
                controller.close();
            }
        },
    });
}

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
}

function frames(out: string): string[] {
    return out.split("\n\n").filter((f) => f.trim().length > 0);
}

test("trae plugin pipe: a clean captured turn is relayed byte-verbatim (no synthesized error)", async () => {
    const chunks: string[] = [];
    await pipePluginTraeWithStrip(streamOf([REAL_TURN]), makeRes(chunks));
    const out = chunks.join("");
    assert.equal(out, REAL_TURN, "every frame of a clean turn survives unchanged");
    assert.ok(!out.includes("upstream_stream_truncated"), "the done frame IS the terminal — nothing is synthesized");
    assert.ok(!out.includes("[DONE]"), "trae has no [DONE] sentinel");
});

test("trae plugin pipe: the done frame is the terminal even when the turn carries tool calls", async () => {
    const chunks: string[] = [];
    await pipePluginTraeWithStrip(streamOf([REAL_TURN]), makeRes(chunks));
    const out = chunks.join("");
    const last = frames(out).at(-1) ?? "";
    assert.match(last, /^event:done\ndata:{"finish_reason":"stop"}$/, "the turn ends on its own done frame");
    assert.equal((out.match(/event:done/g) ?? []).length, 1, "exactly one terminal");
});

test("trae plugin pipe: a real mid-stream cut still emits the in-band truncation error", async () => {
    // Cut right after the token_usage frame: no done ever arrives.
    const cut = REAL_TURN.slice(0, REAL_TURN.indexOf("event:done"));
    const chunks: string[] = [];
    const logs: string[] = [];
    await pipePluginTraeWithStrip(streamOf([cut]), makeRes(chunks), undefined, (m) => logs.push(m));
    const out = chunks.join("");
    assert.match(out, /event:error\ndata:{"code":"upstream_stream_truncated"/, "cut turn reports truncation on the trae wire");
    assert.ok(logs.join("\n").includes("upstream stream truncated (trae)"), "log names the trae protocol");
    assert.ok(logs.join("\n").includes("\"protocol\":\"trae\""), "diag carries the wire");
});

test("trae plugin pipe: render-tag echo is stripped from prose, tool_calls stay byte-verbatim", async () => {
    const prose = "Here is the summary " + TAG("m00001");
    const toolFrame = JSON.stringify({ response: "", reasoning_content: null, tool_calls: [{ index: 0, id: "call_00_x", type: "function", function_call: { name: "run_code", arguments: "{}" } }], multimodal_contents: null, phase: null });
    const echo = `event:output\ndata:${JSON.stringify({ response: prose, reasoning_content: null, tool_calls: null, multimodal_contents: null, phase: null })}\n\n`;
    const tool = `event:tool\ndata:${toolFrame}\n\n`;
    const done = "event:done\ndata:{\"finish_reason\":\"stop\"}\n\n";
    const chunks: string[] = [];
    await pipePluginTraeWithStrip(streamOf([echo, tool, done]), makeRes(chunks));
    const out = chunks.join("");
    assert.ok(!out.includes("tokens=\"2\""), "forged render tag never reaches the client");
    const first = JSON.parse(frames(out)[0].split("\ndata:")[1]) as { response: string };
    assert.equal(first.response, "Here is the summary ");
    assert.ok(out.includes(toolFrame), "tool_calls rode byte-verbatim (#1039)");
});

test("trae plugin pipe: the token_usage frame feeds lastInputTokens", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const session = makeSession("sess-trae-usage");
    const chunks: string[] = [];
    await pipePluginTraeWithStrip(streamOf([REAL_TURN]), makeRes(chunks), session);
    // The captured frame reports prompt_tokens 37247 (OpenAI-inclusive totals).
    assert.equal(session.stats.lastInputTokens, 37247, "usage from the trae wire landed on the session");
    assert.ok(chunks.join("").includes("event:token_usage"), "the usage frame still reaches the client");
});
