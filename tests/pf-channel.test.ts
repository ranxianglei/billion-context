// #5403/#5418 unified watermark channel: the ONE client-side state machine
// (src/agent/pf-channel.ts) plus its single chokepoint in native-intercept.ts.
// Module-state isolation: every group uses a unique sid (the channel has no
// reset hook on purpose — mirrors the old per-lane maps).

import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import * as pfChannel from "../src/agent/pf-channel.ts";
import { laneMsgIdsForOpenAiWire } from "../src/agent/pi-msgids.ts";
import { makeRecordingFetch, type RecordedCall } from "./helpers/hot-replace.ts";

const CONVO = "x-bili-plugin-conversation";

function learn(headersIn: Record<string, string>, seq: string | null | undefined, status = 200): void {
    const respHeaders = new Headers();
    if (seq !== null && seq !== undefined) respHeaders.set("x-bili-pf-seq", seq);
    pfChannel.pfLearnStamp(headersIn, status, respHeaders);
}

test("pf-channel: no stamp yet ⇒ no headers", () => {
    assert.deepEqual(pfChannel.pfRequestHeaders({ [CONVO]: "sid-fresh-1" }), {});
    assert.deepEqual(pfChannel.pfRequestHeaders({}), {});
});

test("pf-channel: count mode; tail-ids ride only a validated list; encoding", () => {
    const sid = "sid-count-1";
    const inH = { [CONVO]: sid };
    learn(inH, "2");
    // count-only until ids are captured
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "2" });
    pfChannel.pfCaptureIds(sid, ["a", "b", "c"]);
    // K=2 ⇒ [id(K-1)] + new = ["b","c"]; per-segment encode
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], "b,c");
    // comma inside an id travels %2C; the separator stays literal (K=1 ⇒ whole list sent)
    learn(inH, "1");
    pfChannel.pfCaptureIds(sid, ["pre,v1", "new,id"]);
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], encodeURIComponent("pre,v1") + "," + encodeURIComponent("new,id"));
    // a list shorter than K degrades to count-only (never partial)
    const sidShort = "sid-count-short";
    learn({ [CONVO]: sidShort }, "2");
    pfChannel.pfCaptureIds(sidShort, ["x"]);
    assert.deepEqual(pfChannel.pfRequestHeaders({ [CONVO]: sidShort }), { "x-bili-pf-count": "2" });
});

test("pf-channel: failed capture CLEARS the stored list (no stale slice)", () => {
    const sid = "sid-clear-1";
    const inH = { [CONVO]: sid };
    learn(inH, "2");
    pfChannel.pfCaptureIds(sid, ["a", "b"]);
    assert.equal(pfChannel.pfRequestHeaders(inH)["x-bili-pf-tail-ids"], "b");
    for (const bad of [null, undefined, "not-an-array", [], 42, ["ok", 7], ["ok", ""], ["acp_summary_x", "y"], ["a b", "c"], ["c", "c"], ["z".repeat(513), "w"]]) {
        pfChannel.pfCaptureIds(sid, bad);
        assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "2" }, `bad=${String(bad)} must clear`);
    }
});

test("pf-channel: stamp learning screens input", () => {
    const sid = "sid-stamp-1";
    const inH = { [CONVO]: sid };
    learn(inH, "abc");        // non-numeric ignored
    learn(inH, null);          // absent header ignored
    learn({}, "9");            // no conversation id ⇒ nothing learned
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), {});
    learn(inH, "0");           // T=0 is not a usable total (elements ≥1)
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), {});
    learn(inH, "3");
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "3" });
    // non-2xx guard lives at the chokepoint (resp.status check), here: only
    // well-formed numeric stamps mutate state — re-learn overwrites
    learn(inH, "7");
    assert.deepEqual(pfChannel.pfRequestHeaders(inH), { "x-bili-pf-count": "7" });
});

async function withPfPatch(
    fn: (fetch: typeof globalThis.fetch, sink: RecordedCall[]) => Promise<unknown>,
    extra?: Partial<NativeInterceptState>,
): Promise<{ sink: RecordedCall[] }> {
    const saved = globalThis.fetch;
    _resetForTest();
    const sink: RecordedCall[] = [];
    globalThis.fetch = makeRecordingFetch(sink);
    try {
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:41001",
            ready: Promise.resolve("http://127.0.0.1:41001"),
            ...extra,
        };
        assert.equal(installNativeFetchIntercept(state), true);
        await fn(globalThis.fetch, sink);
        return { sink };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("chokepoint: routed model request carries count+tail-ids; the response learns back", async () => {
    const sid = "sid-e2e-choke-1";
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        // turn 1: no stamp yet — plain model request (conversation stamped by the lane's headersFor)
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        // the fake Response carries no pf-seq ⇒ nothing learned; now simulate
        // the proxy answering, then send turn 2 with captured ids.
        pfChannel.pfLearnStamp({ [CONVO]: sid }, 200, new Headers({ "x-bili-pf-seq": "2" }));
        pfChannel.pfCaptureIds(sid, ["m1", "m2", "m3"]);
        await fetch("http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        assert.equal(sinkIn.length, 2);
        assert.equal(sinkIn[0].headers["x-bili-pf-count"], undefined, "turn 1 unseeded");
    });
    assert.equal(sink[1].headers["x-bili-pf-count"], "2");
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], "m2,m3");
    // the chokepoint fabricates no lane identity of its own
    assert.ok(!("x-bili-plugin" in sink[1].headers), "chokepoint must not add a lane plugin header");
});

test("chokepoint: already-routed /bili/ MODEL url is stamped; __bili/ control-plane never is", async () => {
    const sid = "sid-e2e-control-1";
    learn({ [CONVO]: sid }, "4");
    pfChannel.pfCaptureIds(sid, ["a", "b", "c", "d", "e"]);
    const { sink } = await withPfPatch(async (fetch) => {
        // an already-routed /bili/ MODEL url: stamped branch
        await fetch("http://127.0.0.1:41001/bili/http://127.0.0.1:8199/v1/chat/completions", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
        // control-plane (incremental envelope endpoint): passes through, no pf
        await fetch("http://127.0.0.1:41001/__bili/plugin/turn", {
            method: "POST",
            headers: { [CONVO]: sid },
            body: "{}",
        });
    }, { headersFor: () => ({ "x-bili-plugin": "dsh" }) });
    assert.equal(sink.length, 2);
    assert.equal(sink[0].headers["x-bili-pf-count"], "4");
    assert.equal(sink[0].headers["x-bili-pf-tail-ids"], "d,e");
    assert.equal(sink[1].headers["x-bili-pf-count"], undefined);
    assert.equal(sink[1].headers["x-bili-pf-tail-ids"], undefined);
    assert.ok(!sink[1].url.includes("/bili/"), "control plane must not be re-routed");
});

test("chokepoint: no conversation header ⇒ nothing pf at all", async () => {
    const { sink } = await withPfPatch(async (fetch, sinkIn) => {
        await fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });
        assert.equal(sinkIn.length, 1);
    });
    assert.equal(sink.length, 1);
    assert.equal(sink[0].headers["x-bili-pf-count"], undefined);
    assert.equal(sink[0].headers["x-bili-pf-tail-ids"], undefined);
});

// --- openai-chat family resolver (#5403/#5418 protocol-unified capture) ---

test("laneMsgIdsForOpenAiWire: leading system slot gets a position token, rest align to branch", () => {
    const branch = [
        { type: "message", id: "aaaa1111", message: { role: "user", content: "a" } },
        { type: "message", id: "bbbb2222", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
    ];
    assert.deepEqual(
        laneMsgIdsForOpenAiWire(
            [
                { role: "system", content: "You are T." },
                { role: "user", content: "a" },
                { role: "assistant", content: "b" },
            ],
            branch,
        ),
        ["bili-ps-0", "aaaa1111", "bbbb2222"],
    );
});

test("laneMsgIdsForOpenAiWire: tool calls/results align through the shared entry walk", () => {
    const branch = [
        { type: "message", id: "cccc3333", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1" }] } },
        { type: "message", id: "dddd4444", message: { role: "toolResult", toolCallId: "tc1" } },
    ];
    assert.deepEqual(
        laneMsgIdsForOpenAiWire(
            [
                { role: "assistant", content: null, tool_calls: [{ id: "tc1" }] },
                { role: "tool", tool_call_id: "tc1", content: "ok" },
            ],
            branch,
        ),
        ["cccc3333", "dddd4444"],
    );
});

test("laneMsgIdsForOpenAiWire: bails honestly on anything unprovable", () => {
    const branch = [
        { type: "message", id: "eeee5555", message: { role: "user", content: "x" } },
    ];
    // non-leading system element
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }, { role: "system", content: "s" }], [...branch]),
        undefined,
    );
    // reasoning-family field anywhere
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }, { role: "assistant", content: "y", reasoning_content: "r" }], branch),
        undefined,
    );
    // leftover branch entry the wire cannot explain
    assert.equal(
        laneMsgIdsForOpenAiWire([{ role: "user", content: "x" }], [
            branch[0],
            { type: "message", id: "ffff6666", message: { role: "user", content: "ghost" } },
        ]),
        undefined,
    );
});
