// #5128 / #5713 / #4313 — THREE-WAY COEXISTENCE test (add with the rebase commit).
//
// Why this file exists: the trae wire family (#5128) is based on the
// model-endpoint-patterns lane (#1444), whose stage-1 already added the
// commandcode wire selector, while master carries the hybrid message-timestamp
// prompt wrapping (#4313/#5236). After the lane lands and this PR rebases, ONE
// relay round-2 code path serves all three at once:
//
//     src/server/relay.ts:2678-2682
//       prepared.commandcode ? createCommandcodeAdapter(...)
//       : prepared.traeWire ? createTraeAdapter(...)
//       : pickAdapter(...)
//     src/server/relay.ts:2675  systemPrompt = withProjectAttribution(... withSummaryBudgetNote(
//       textProtocol ? hybrid(... messageTimestampSections(..., "hybrid"))
//                    : buildCompressSystemPrompt(..., messageTimestampSections(...)), ...))
//
// commandcode and trae both keep protocol "openai" internally (src/server/handle.ts:420-432),
// so both land in that same block. Neither suite covered the two lanes together, and
// NOTHING covered them together with the timestamped lean pack — this file does.
// It asserts coexistence only; per-lane wire contracts stay in
// tests/trae-endpoint.test.ts / tests/adapter-trae.test.ts / tests/adapter-commandcode.test.ts.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";
// tests/preload-test-env.mjs pins the #4313 display gate OFF ("0") so byte-comparing
// baselines keep pre-feature wire bytes. This suite IS the ON case, so it drives the
// gate explicitly instead of inheriting the ambient pin (same discipline as
// tests/issue4313-message-timestamp-toggle.test.ts).
process.env.BILI_MESSAGE_TIMESTAMPS = "1";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const TRAE_MODEL = "trae-dsv41";
const CC_MODEL = "cc-go-1";
const TRAE_PATH = "/api/agent/v3/llm_utils_chat";
const CC_PATH = "/alpha/generate";

const ENVELOPE = {
    mode_type: 1,
    context_window_size: 1_000_000,
    prompt_max_tokens: 936_000,
    function: "solo_agent",
    config_name: TRAE_MODEL,
};

/** Round 1 of each lane emits exactly one PROXY tool call, so each request has
 *  to come back through the round-2 rebuild instead of completing in one shot. */
const traeFrames = (tool: boolean): string => {
    const output = tool
        ? { response: "", reasoning_content: null, tool_calls: [{ index: 0, id: "t1", type: "function", function_call: { name: "acp_status", arguments: "{}" } }] }
        : { response: "trae final answer", reasoning_content: null, tool_calls: null };
    return "event:output\ndata:" + JSON.stringify(output) + "\n\n"
        + "event:token_usage\ndata:" + JSON.stringify({ prompt_tokens: 11, completion_tokens: 2, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, reasoning_tokens: 0 }) + "\n\n"
        + "event:done\ndata:" + JSON.stringify({ finish_reason: tool ? "tool_calls" : "stop" }) + "\n\n";
};

const ccLines = (tool: boolean): string => (tool
    ? ['{"type":"tool-call","toolCallId":"c1","toolName":"acp_status","input":{}}',
        '{"type":"finish","finishReason":"tool_calls","totalUsage":{"inputTokens":11,"outputTokens":2,"inputTokenDetails":{"cacheReadTokens":2}}}']
    : ['{"type":"text-delta","text":"cc final answer"}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":20,"outputTokens":3,"inputTokenDetails":{"cacheReadTokens":3}}}']
).join("\n") + "\n";

interface Rig {
    proxyPort: number;
    trae: Array<Record<string, unknown>>;
    cc: Array<Record<string, unknown>>;
    proxy: http.Server;
    ups: http.Server[];
}

function upstreamFor(path: string, seen: Array<Record<string, unknown>>, reply: (round: number) => string, onBody?: (raw: string) => void) {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let sent = false;
            try { seen.push(JSON.parse(raw) as Record<string, unknown>); sent = true; } catch { /* keep raw */ }
            if (!sent) seen.push({ raw });
            onBody?.(raw);
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(reply(seen.length));
        });
    });
}

async function startRig(): Promise<Rig> {
    const trae: Array<Record<string, unknown>> = [];
    const cc: Array<Record<string, unknown>> = [];
    const traeUp = upstreamFor(TRAE_PATH, trae, (round) => traeFrames(round === 1));
    const ccUp = upstreamFor(CC_PATH, cc, (round) => ccLines(round === 1));
    traeUp.listen(0, "127.0.0.1");
    await once(traeUp, "listening");
    ccUp.listen(0, "127.0.0.1");
    await once(ccUp, "listening");
    const traePort = (traeUp.address() as AddressInfo).port;
    const ccPort = (ccUp.address() as AddressInfo).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { ["http://127.0.0.1:" + traePort]: {}, ["http://127.0.0.1:" + ccPort]: {} },
        modelEndpoints: [
            { match: "http://127.0.0.1:" + traePort + TRAE_PATH, wire: "trae" },
            { match: "http://127.0.0.1:" + ccPort + CC_PATH, wire: "commandcode" },
        ],
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        // The lean pack is what #4313 swaps for the timestamped variant; arming it
        // here is what puts commandcode + trae + the timestamp wrapping on one
        // round-2 path (kernel default pack never selects the stamped lean block).
        compress: { injectTool: true, injectNudge: true, promptPack: "lean" },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as AddressInfo).port, trae, cc, proxy, ups: [traeUp, ccUp] };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    for (const up of rig.ups) { up.close(); await once(up, "close"); }
}

/** Everything the upstream would treat as system text for one lane's body. */
function systemText(body: Record<string, unknown>, lane: "trae" | "commandcode"): string {
    const msgs = (lane === "trae" ? body.messages : (body.params as Record<string, unknown> | undefined)?.messages) as Array<Record<string, unknown>> | undefined;
    const parts: string[] = [];
    if (lane === "commandcode") {
        const sys = (body.params as Record<string, unknown> | undefined)?.system;
        if (typeof sys === "string") parts.push(sys);
    }
    for (const m of msgs ?? []) {
        if (typeof m.content === "string") parts.push(m.content);
        else if (Array.isArray(m.content)) parts.push((m.content as Array<Record<string, unknown>>).map((p) => String(p.text ?? "")).join(""));
    }
    return parts.join("\n");
}

test("trae + commandcode + timestamped lean pack coexist on one relay path", async () => {
    const rig = await startRig();
    try {
        const traeBody = JSON.stringify({
            model: TRAE_MODEL,
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            stream: true,
            max_tokens: 64_000,
            prompt_cache_key: "pck-coexist",
            stream_options: { include_usage: true },
            ...ENVELOPE,
        });
        const rTrae = await fetch("http://127.0.0.1:" + rig.proxyPort + "/bili/http://127.0.0.1:" + (rig.ups[0].address() as AddressInfo).port + TRAE_PATH, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": "coexist-trae" }, body: traeBody,
        });
        const tTrae = await rTrae.text();

        const ccBody = JSON.stringify({
            config: { provider: "commandcode" },
            threadId: "th-coexist",
            params: { model: CC_MODEL, stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        });
        const rCc = await fetch("http://127.0.0.1:" + rig.proxyPort + "/bili/http://127.0.0.1:" + (rig.ups[1].address() as AddressInfo).port + CC_PATH, {
            method: "POST", headers: { "content-type": "application/json", "x-acp-session": "coexist-cc" }, body: ccBody,
        });
        const tCc = await rCc.text();

        // ---- both lanes ran the pipeline and came back in their OWN dialect ----
        assert.equal(rTrae.status, 200);
        assert.equal(rCc.status, 200);
        assert.ok(tTrae.includes("event:done"), "trae lane must terminate in the Trae dialect");
        assert.ok(tTrae.includes("event:token_usage"));
        assert.ok(!tTrae.includes("[DONE]"), "the Trae wire has no [DONE] sentinel");
        assert.ok(tCc.includes('"type":"finish"'), "commandcode lane must terminate in bare JSONL");
        assert.ok(!tCc.includes("data:"), "commandcode speaks bare JSONL, never SSE framing");

        // ---- round-1 -> round-2 on both lanes (the proxy tool call re-entered) ----
        assert.equal(rig.trae.length, 2, "trae request must be rebuilt for round 2");
        assert.equal(rig.cc.length, 2, "commandcode request must be rebuilt for round 2");
        const [trae1, trae2] = rig.trae as Array<Record<string, unknown>>;
        const [cc1, cc2] = rig.cc as Array<Record<string, unknown>>;

        // ---- trae envelope survives the rebuild; commandcode keeps its outer shapes ----
        for (const body of [trae1, trae2]) {
            for (const [k, v] of Object.entries(ENVELOPE)) assert.deepEqual(body[k], v, "trae envelope key " + k + " must round-trip");
            assert.equal(body.stream, true);
            assert.ok(Array.isArray(body.messages));
        }
        for (const body of [cc1, cc2]) {
            assert.equal((body.config as Record<string, unknown>).provider, "commandcode");
            assert.equal(body.threadId, "th-coexist");
            assert.ok(Array.isArray((body.params as Record<string, unknown>).messages));
        }

        // ---- #5713: cache directives round-trip on the trae wire (present -> written back) ----
        assert.equal(trae2.prompt_cache_key, "pck-coexist", "a surviving prompt_cache_key must ride the rebuilt envelope");
        assert.deepEqual(trae2.stream_options, { include_usage: true });

        // ---- #4313: the timestamped lean pack reaches BOTH lanes' round-2 system text ----
        for (const [lane, body] of [["trae", trae2], ["commandcode", cc2]] as const) {
            const sys = systemText(body, lane);
            assert.ok(sys.includes("HOW TO COMPRESS"), lane + ": compress rules must be rebuilt on round 2");
            assert.ok(
                sys.includes("TIMELINE — open each summary with one diary line"),
                lane + ": the lean pack must be the #4313 TIMESTAMPED variant on round 2",
            );
            assert.ok(sys.includes("yyyy-mm-dd hh:mm:ss"), lane + ": the diary-line time format must be present");
        }

        // ---- both lanes still see their own round-1 tool result on round 2 ----
        const traeRoles = (trae2.messages as Array<Record<string, unknown>>).map((m) => String(m.role));
        assert.ok(traeRoles.includes("assistant") && traeRoles.includes("tool"), "trae round-2 must carry the assistant call + tool result");
        const ccRoles = ((cc2.params as Record<string, unknown>).messages as Array<Record<string, unknown>>).map((m) => String(m.role));
        assert.ok(ccRoles.includes("assistant") && ccRoles.includes("tool"), "commandcode round-2 must carry the assistant call + tool result");
    } finally {
        await closeRig(rig);
    }
});
