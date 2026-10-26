// Lane-scoped Vertex Anthropic fake (WC-019/020/021), and the proof that it bites.
//
// Two things are under test, and they pull in opposite directions: the fake must ACCEPT
// what the real client sends — the captured fixture bytes are the acceptance test, not a
// hand-built body — and it must REJECT what the wire forbids, with the rule id in the
// error. A fake that passes everything is decoration; a fake that fails the capture is
// wrong about the upstream.
//
// Provenance for the rules lives beside them in tests/wire-contract-fakes.ts (WIRE_RULES).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeUpstream, vertexAnthropicPathInfo } from "./wire-contract-fakes.ts";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "vertex-anthropic");
const readFixture = (name: string) => fs.readFileSync(path.join(fixtureDir, name));
const meta = (name: string) =>
    JSON.parse(readFixture(`${name}.meta.json`).toString("utf8")) as { request: { path: string; headers: Record<string, string> } };

/** The fake stands in for the upstream, so it sees the path bili forwards — the proxy-facing
 *  path minus the /bili/<protocol>/<host> prefix the client was pointed at. */
function upstreamPath(proxyPath: string): string {
    return proxyPath.replace(/^\/bili\/anthropic\/https:\/\/aiplatform\.googleapis\.com/, "");
}

function eventNames(sse: string): string[] {
    return [...sse.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
}

function jsonBody(name: string): Record<string, unknown> {
    return JSON.parse(readFixture(`${name}.body.json`).toString("utf8")) as Record<string, unknown>;
}

async function post(url: string, body: string | Buffer): Promise<{ status: number; text: string }> {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, text: await res.text() };
}

test("the fake accepts the captured client bytes verbatim, and reads the model off the path", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic", replyText: "pong" });
    try {
        const turnPath = upstreamPath(meta("turn-streaming").request.path);
        const probePath = upstreamPath(meta("probe-nonstreaming").request.path);

        const turn = await post(fake.url + turnPath, readFixture("turn-streaming.body.json"));
        const probe = await post(fake.url + probePath, readFixture("probe-nonstreaming.body.json"));

        assert.equal(turn.status, 200, "the real streaming turn passes the lane's validators");
        assert.equal(probe.status, 200, "the real unary probe passes too");
        assert.deepEqual(fake.violations, [], "the capture violates nothing the fake knows about");
        assert.equal(fake.lane, "vertex-anthropic");
        assert.deepEqual(
            fake.requests.map((r) => r.model),
            ["claude-opus-5-5", "claude-haiku-4-5@20251001"],
            "the model comes off the path — bare and dated ids alike",
        );
    } finally {
        await fake.close();
    }
});

test("the fake's stream matches the fixture's documented event sequence, and adds no OpenAI sentinel", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic", replyText: "pong" });
    try {
        const res = await post(fake.url + upstreamPath(meta("turn-streaming").request.path), readFixture("turn-streaming.body.json"));
        const fixtureEvents = eventNames(readFixture("response-stream.sse").toString("utf8"));
        assert.deepEqual(eventNames(res.text), fixtureEvents, "fake and fixture cannot drift apart silently");
        assert.ok(fixtureEvents.includes("ping"), "the documented stream carries ping");
        assert.equal(res.text.includes("[DONE]"), false, "[DONE] is an OpenAI convention, not this wire's");
        assert.match(res.text, /"type":"message_stop"/);
    } finally {
        await fake.close();
    }
});

test("the unary reply is the doc-derived Message", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic", replyText: "pong" });
    try {
        const res = await post(fake.url + upstreamPath(meta("probe-nonstreaming").request.path), readFixture("probe-nonstreaming.body.json"));
        const body = JSON.parse(res.text) as Record<string, unknown>;
        assert.match(String(body.id), /^msg_vrtx_/, "Vertex message ids carry the msg_vrtx_ prefix");
        assert.equal(body.type, "message");
        assert.equal(body.role, "assistant");
        assert.equal(body.model, "claude-haiku-4-5@20251001", "the path model is echoed");
        assert.deepEqual(body.content, [{ type: "text", text: "pong" }]);
        assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 3 });
    } finally {
        await fake.close();
    }
});

test("WC-019 bites: a body without anthropic_version is rejected on the streaming path, in WC-021's array envelope", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic" });
    try {
        const body = jsonBody("turn-streaming");
        delete (body as { anthropic_version?: unknown }).anthropic_version;
        const res = await post(fake.url + upstreamPath(meta("turn-streaming").request.path), JSON.stringify(body));

        assert.equal(res.status, 400);
        const parsed = JSON.parse(res.text) as unknown;
        assert.ok(Array.isArray(parsed), "WC-021: the streaming path wraps errors in a JSON array");
        assert.match(JSON.stringify(parsed), /WC-019/, "the rule id names what was wrong");
        assert.equal(fake.violations.length, 1);
    } finally {
        await fake.close();
    }
});

test("WC-021's split: the same violation on the unary path is a bare object", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic" });
    try {
        const body = jsonBody("probe-nonstreaming");
        (body as Record<string, unknown>).anthropic_version = "2023-06-01"; // the header value, in the body
        const res = await post(fake.url + upstreamPath(meta("probe-nonstreaming").request.path), JSON.stringify(body));

        assert.equal(res.status, 400);
        const parsed = JSON.parse(res.text) as unknown;
        assert.equal(Array.isArray(parsed), false, "the unary path sends the error object unwrapped");
        assert.match(JSON.stringify(parsed), /WC-019/);
    } finally {
        await fake.close();
    }
});

test("WC-020 bites: the Messages path is not this wire, and neither is a path without a model", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic" });
    try {
        const messages = await post(fake.url + "/v1/messages", JSON.stringify(jsonBody("probe-nonstreaming")));
        const modelLess = await post(
            fake.url + "/v1/projects/aolshev-playground/locations/global/publishers/anthropic/models/:rawPredict",
            JSON.stringify(jsonBody("probe-nonstreaming")),
        );
        assert.equal(messages.status, 404, "/v1/messages is the direct-Anthropic wire, not this one");
        assert.equal(modelLess.status, 404, "no model segment, no wire");
        assert.equal(fake.requests.length, 0, "a 404'd path is not even recorded as a request");
    } finally {
        await fake.close();
    }
});

test("a body carrying model is tolerated, because Vertex's tolerance is unverified", async () => {
    const fake = await startFakeUpstream("anthropic", { lane: "vertex-anthropic" });
    try {
        const body = jsonBody("probe-nonstreaming");
        (body as Record<string, unknown>).model = "claude-opus-5-5";
        const res = await post(fake.url + upstreamPath(meta("probe-nonstreaming").request.path), JSON.stringify(body));
        assert.equal(res.status, 200, "no WC rule exists for a body model field — the fake must not invent one");
        assert.deepEqual(fake.violations, []);
    } finally {
        await fake.close();
    }
});

test("the path parser agrees with the fixture's own paths", () => {
    for (const name of ["turn-streaming", "probe-nonstreaming"]) {
        const info = vertexAnthropicPathInfo(upstreamPath(meta(name).request.path));
        assert.ok(info, `${name}: parses`);
        assert.equal(info!.project, "aolshev-playground");
        assert.equal(info!.location, "global");
        assert.ok(info!.model.length > 0);
    }
    assert.equal(vertexAnthropicPathInfo("/v1/messages"), null);
    assert.equal(vertexAnthropicPathInfo("/v1/projects/p/locations/l/publishers/anthropic/models/m:predict"), null, "unknown verb");
});
