import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_TOOL_NAMES } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { defaultLogFile } from "../src/paths.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Anthropic-on-Vertex end-to-end: phase 2 of the Vertex port. The client's
// CAPTURED body (tests/fixtures/vertex-anthropic/, phase 0) is replayed at the
// Vertex path shape the launcher emits, against a mock upstream that demands
// compression. What this file pins, in the order the wire meets it:
//
//   (a) the protocol-qualified form `/bili/anthropic/<url>` claims the request
//       for the anthropic pipeline, while the bare `/bili/<url>` form does not
//       (`:rawPredict` matches no suffix in the ladder) and forwards verbatim;
//   (b) the model is read off the publisher path and reaches the model-keyed
//       decisions (asserted through the proxy's own log line, since the Vertex
//       body carries no `model` field to read it back from);
//   (c) the Vertex body survives the rebuild: `anthropic_version` and the
//       fields Anthropic's own API has no name for (`output_config`,
//       `safeguards`) are still there;
//   (d) a compress round trip completes end to end — the summary the model
//       returns rides into the next forwarded request and the text it folded is
//       gone from the payload.
//
// One deliberate deviation from the capture: the kernel refuses to fold its
// protected tail (the last three messages and/or the most recent user message),
// and the captured turn is a single exchange, so it has no foldable mass at all.
// Test 1 therefore sends the captured turn behind six clearly-labelled filler
// turns and folds those. Everything asserted about the Vertex wire (headers,
// path, body fields, tools, system) is still the captured material; test 2 keeps
// the captured bytes byte-exact for the unclaimed-passthrough case.
const fixture = (name: string): string =>
    readFileSync(new URL(`./fixtures/vertex-anthropic/${name}`, import.meta.url), "utf8");

const CAPTURED_BODY = fixture("turn-streaming.body.json");
const CAPTURED_JSON = JSON.parse(CAPTURED_BODY) as { messages: unknown[] } & Record<string, unknown>;
const FILLER_MARKER = "VERTEX-E2E-FILLER";

/** Six alternating turns of well over the kernel's 5000-char fold minimum. */
function fillerMessages(): unknown[] {
    const out: unknown[] = [];
    for (let i = 1; i <= 6; i += 1) {
        const line = `${FILLER_MARKER} turn ${i}. `.repeat(60);
        out.push({ role: i % 2 === 1 ? "user" : "assistant", content: [{ type: "text", text: line }] });
    }
    return out;
}
const HISTORIED_BODY = JSON.stringify({ ...CAPTURED_JSON, messages: [...fillerMessages(), ...CAPTURED_JSON.messages] });
const CAPTURED_META = JSON.parse(fixture("turn-streaming.meta.json")) as {
    request: { method: string; path: string; headers: Record<string, string> };
};
/** The path the client actually sent, with its origin swapped for the mock's —
 *  the shape under test (`/v1/projects/<p>/locations/<loc>/publishers/
 *  anthropic/models/<model>:streamRawPredict`) is the recorded one. */
const VERTEX_PATH = CAPTURED_META.request.path.replace(/^\/bili\/anthropic\/https:\/\/aiplatform\.googleapis\.com/, "");
const VERTEX_MODEL = "claude-opus-5-5";
const SUMMARY_TEXT = "vertex e2e compress round trip: the captured history folded into one block";

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Round 1: the model answers with the `compress` tool the proxy injected.
 *  The range spans only the filler turns: the captured turn is the protected
 *  tail the kernel will not fold. */
function compressScript(): string[] {
    const args = JSON.stringify({ startId: "m00001", endId: "m00006", topic: "vertex-e2e", summary: SUMMARY_TEXT });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_vrtx_c1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_v_1", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 24) } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(24) } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

/** Round 2 (and the passthrough case): a plain Vertex-shaped text answer. */
function textScript(): string[] {
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_vrtx_2", role: "assistant", usage: { input_tokens: 20 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ];
}

interface Harness {
    proxyUrl: string;
    upstreamUrl: string;
    captured: { body: string; headers: Record<string, string | string[] | undefined> }[];
    stateDir: string;
    close: () => Promise<void>;
}

async function startHarness(scripts: string[][]): Promise<Harness> {
    // The proxy only writes its log file when `log` is on; the model resolution
    // is asserted from that file, so the state dir is redirected into a temp
    // tree instead of the developer's real one.
    const stateDir = mkdtempSync(path.join(tmpdir(), "bc-vertex-e2e-"));
    process.env.XDG_STATE_HOME = stateDir;
    process.env.XDG_DATA_HOME = stateDir;
    const captured: Harness["captured"] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push({ body: Buffer.concat(chunks).toString("utf8"), headers: { ...req.headers } });
            const script = scripts[Math.min(call, scripts.length - 1)]!;
            call += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of script) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [upstreamUrl]: { models: { [VERTEX_MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        // The soft-protected recent zone (last `preserveRecentMessages` plus the
        // last user message) is what keeps a live turn unfoldable; the token half
        // of that window is pinned off here because the fixture's own tail plus
        // six filler turns sit just under the 5000-token default, which would put
        // the filler inside the zone and make the fold fail for a reason this test
        // is not about.
        kernelConfig: { ...defaultConfig(400_000), preserveRecentTokens: 0 },
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
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
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        upstreamUrl,
        captured,
        stateDir,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

/** The recorded headers minus the ones that are per-connection or secret. */
function clientHeaders(): Record<string, string> {
    const dropped = new Set(["authorization", "host", "connection", "content-length", "accept-encoding"]);
    const out: Record<string, string> = { "x-acp-session": "e2e-vertex" };
    for (const [k, v] of Object.entries(CAPTURED_META.request.headers)) {
        if (!dropped.has(k.toLowerCase())) out[k] = v;
    }
    return out;
}

function logText(h: Harness): string {
    try {
        return readFileSync(defaultLogFile(), "utf8");
    } catch {
        return "";
    }
}

test("e2e vertex: the captured Vertex turn is claimed by the anthropic pipeline, compressed, and forwarded with its body intact", async () => {
    const h = await startHarness([compressScript(), textScript()]);
    try {
        const resp = await fetch(`${h.proxyUrl}/bili/anthropic/${h.upstreamUrl}${VERTEX_PATH}`, {
            method: "POST",
            headers: clientHeaders(),
            body: HISTORIED_BODY,
        });
        assert.equal(resp.status, 200);
        const raw = await resp.text();
        assert.match(raw, /pong/, "the client must receive the post-compress round");

        assert.ok(h.captured.length >= 2, `the compress round trip must reach the upstream twice, saw ${h.captured.length}`);
        const first = JSON.parse(h.captured[0]!.body) as Record<string, unknown>;
        const tools = Array.isArray(first.tools) ? (first.tools as { name?: string }[]) : [];
        const injected = tools.filter((t) => typeof t.name === "string" && BILI_TOOL_NAMES.has(t.name));
        assert.ok(injected.length > 0, `the proxy must inject its ACP tools on this wire, saw ${tools.map((t) => t.name).join(",")}`);

        // The Vertex body's own fields — including the two Anthropic's API has no
        // name for — must survive the rebuild. `anthropic_version` is the field
        // that replaces `model` on this wire, so losing it breaks the request.
        assert.equal(first.anthropic_version, "vertex-2023-10-16");
        assert.equal("model" in first, false, "the Vertex body carries no model and the proxy must not invent one");
        for (const key of ["metadata", "output_config", "safeguards", "system", "thinking"]) {
            assert.ok(key in first, `${key} must survive the rebuild`);
        }

        // The model comes off the publisher path: the Vertex body has none, so the
        // only way the proxy can name it in its window/headroom line is the path.
        const log = logText(h);
        assert.match(log, new RegExp(`model=${VERTEX_MODEL}\\b`), "the path-derived model must reach the window/headroom decision");

        // The fold must actually have happened: the loop re-requests either way, so
        // a replayed tool_use block alone would put the summary on the wire with no
        // compression behind it. The kernel keeps the range's opening message as an
        // anchor (observed: m00001 stays verbatim, captioned), so the assertion is
        // on the bulk leaving, not on every byte.
        assert.doesNotMatch(log, /compress FAILED/, "the fold must succeed, not fall back to the error reply");
        const secondBody = h.captured[1]!.body;
        assert.ok(secondBody.includes(SUMMARY_TEXT), "the summary must appear in the next forwarded request");
        const markerCount = (s: string): number => s.split(FILLER_MARKER).length - 1;
        assert.ok(markerCount(h.captured[0]!.body) >= 300, "the filler must have been in the first request");
        assert.ok(
            markerCount(secondBody) <= markerCount(h.captured[0]!.body) / 5,
            `the folded text must leave the payload: ${markerCount(h.captured[0]!.body)} filler blocks in, ${markerCount(secondBody)} out`,
        );
    } finally {
        await h.close();
    }
});

test("e2e vertex: without the protocol segment the same request is not claimed and forwards verbatim", async () => {
    const h = await startHarness([textScript()]);
    try {
        const resp = await fetch(`${h.proxyUrl}/bili/${h.upstreamUrl}${VERTEX_PATH}`, {
            method: "POST",
            headers: clientHeaders(),
            body: CAPTURED_BODY,
        });
        assert.equal(resp.status, 200);
        assert.equal(h.captured.length, 1, "an unclaimed path must not trigger a compress round trip");
        assert.equal(h.captured[0]!.body, CAPTURED_BODY, "an unclassified request must be forwarded byte-identically");
    } finally {
        await h.close();
    }
});
