// Vertex Anthropic wire fixture — phase 0 of the Vertex port (PR #3323).
//
// The fixture's captured halves are byte-exact copies of what the real client
// sent, so this test asserts their digests first: a re-serialized or
// hand-edited body must fail here rather than silently becoming the thing
// later phases implement against. The derived halves are checked for the
// properties the docs promise, not for digests — they are documented shapes,
// not evidence.
//
// Provenance for every artifact lives in the fixture's own manifest.json and
// README.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = path.join(import.meta.dirname, "fixtures", "vertex-anthropic");
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const readBytes = (name: string) => fs.readFileSync(path.join(dir, name));

interface Artifact {
    readonly file: string;
    readonly kind: "captured" | "doc-derived";
    readonly bytes: number;
    readonly sha256: string;
    readonly note: string;
    readonly sources?: readonly string[];
}

interface Meta {
    readonly kind: string;
    readonly request: { readonly method: string; readonly path: string; readonly headers: Record<string, string> };
    readonly body: { readonly file: string; readonly bytes: number; readonly sha256: string };
}

const manifest = readJson("manifest.json") as {
    readonly wire: string;
    readonly client: string;
    readonly upstream: { readonly baseUrlInClient: string; readonly note: string };
    readonly artifacts: readonly Artifact[];
};

const VERTEX_PATH =
    /^\/bili\/anthropic\/https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/(?<project>[^/]+)\/locations\/(?<location>[^/]+)\/publishers\/anthropic\/models\/(?<model>[^:]+):(?<method>rawPredict|streamRawPredict)$/;

test("every fixture artifact matches its recorded digest and size", () => {
    assert.ok(manifest.artifacts.length >= 4, "the manifest lists the fixture's artifacts");
    for (const a of manifest.artifacts) {
        const bytes = readBytes(a.file);
        assert.equal(bytes.length, a.bytes, `${a.file}: size`);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), a.sha256, `${a.file}: sha256`);
    }
});

test("captured bodies are the client's compact JSON, and the digest — not the formatting — is the guarantee", () => {
    // Measured, not assumed: the client emits compact JSON with raw UTF-8 (a 45 KB turn body
    // carrying an emoji), which JS re-serialization reproduces byte-for-byte. That is a
    // property worth pinning, because a client-side change to serialization would show up
    // here first. It is NOT what makes the fixture trustworthy — the manifest digests are,
    // which is why the bytes are stored rather than regenerated from parsed JSON.
    for (const name of ["turn-streaming", "probe-nonstreaming"]) {
        const raw = readBytes(`${name}.body.json`).toString("utf8");
        assert.equal(raw, JSON.stringify(JSON.parse(raw)), `${name}: compact JSON, no padding`);
        assert.equal(raw.endsWith("\n"), false, `${name}: no trailing newline`);
    }
});

test("captured paths carry the Vertex publisher shape the client actually uses", () => {
    const turn = readJson("turn-streaming.meta.json") as Meta;
    const probe = readJson("probe-nonstreaming.meta.json") as Meta;
    for (const meta of [turn, probe]) {
        assert.equal(meta.request.method, "POST");
        const m = VERTEX_PATH.exec(meta.request.path);
        assert.ok(m, `${meta.request.path} matches the Vertex publisher path`);
        assert.equal(m!.groups!.project, "aolshev-playground");
        // #3323: the client appends /projects/... to the base URL verbatim and does NOT add /v1,
        // so the /v1 segment has to arrive in ANTHROPIC_VERTEX_BASE_URL. Vertex 404s without it.
        assert.ok(meta.request.path.includes("/v1/projects/"), `${meta.request.path} keeps the /v1 segment`);
    }
    assert.equal(VERTEX_PATH.exec(turn.request.path)!.groups!.method, "streamRawPredict");
    assert.equal(VERTEX_PATH.exec(probe.request.path)!.groups!.method, "rawPredict");
});

test("captured models ride the path, including a dated id and a bare id", () => {
    const turnModel = VERTEX_PATH.exec((readJson("turn-streaming.meta.json") as Meta).request.path)!.groups!.model;
    const probeModel = VERTEX_PATH.exec((readJson("probe-nonstreaming.meta.json") as Meta).request.path)!.groups!.model;
    assert.equal(turnModel, "claude-opus-5-5", "a bare Vertex model id needs no normalisation");
    assert.equal(probeModel, "claude-haiku-4-5@20251001", "a dated Vertex model id carries an @ suffix");
});

test("captured headers carry auth and the api version, with the token redacted", () => {
    const meta = readJson("turn-streaming.meta.json") as Meta;
    const h = meta.request.headers;
    assert.match(h.authorization, /^Bearer <redacted:\d+ chars>$/, "auth is present but redacted in the fixture");
    assert.equal(h["anthropic-version"], "2023-06-01", "the client does send anthropic-version on this wire");
    assert.equal(h["content-type"], "application/json");
});

test("captured bodies describe the wire: no model field, anthropic_version in the body", () => {
    const turn = JSON.parse(readBytes("turn-streaming.body.json").toString("utf8")) as Record<string, unknown>;
    const probe = JSON.parse(readBytes("probe-nonstreaming.body.json").toString("utf8")) as Record<string, unknown>;

    for (const body of [turn, probe]) {
        assert.equal(body.anthropic_version, "vertex-2023-10-16");
        assert.equal("model" in body, false, "the body never carries model — the path is the only source");
        assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
    }
    assert.equal(turn.stream, true);
    assert.ok(Array.isArray(turn.tools) && (turn.tools as unknown[]).length > 0, "the turn carries tools");
    assert.equal(probe.stream, undefined, "the probe is the unary shape");
    assert.equal(probe.max_tokens, 1);
});

test("the doc-derived response half is the shape the client expects", () => {
    const message = readJson("response-message.json") as Record<string, unknown>;
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.match(String(message.id), /^msg_vrtx_/, "Vertex message ids carry the msg_vrtx_ prefix");
    assert.deepEqual(Object.keys(message).sort(), ["content", "id", "model", "role", "stop_reason", "stop_sequence", "type", "usage"].sort());

    const sse = readBytes("response-stream.sse").toString("utf8");
    const events = [...sse.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(events, [
        "message_start",
        "content_block_start",
        "ping",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]);
    for (const [i, line] of sse.split("\n").entries()) {
        if (!line.startsWith("data: ")) continue;
        const parsed = JSON.parse(line.slice(6)) as { type?: string };
        assert.ok(parsed.type, `data line ${i + 1} carries a type`);
    }
});

test("the manifest records provenance for both halves", () => {
    const captured = manifest.artifacts.filter((a) => a.kind === "captured");
    const derived = manifest.artifacts.filter((a) => a.kind === "doc-derived");
    assert.ok(captured.length >= 2 && derived.length >= 2);
    for (const a of derived) assert.ok(a.sources && a.sources.length > 0, `${a.file} cites its docs`);
    assert.ok(manifest.upstream.note.includes("/v1"), "the /v1 requirement is recorded with the fixture");
});
