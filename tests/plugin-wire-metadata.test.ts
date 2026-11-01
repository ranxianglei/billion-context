import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoreMessage } from "acp-kernel";
import { preparePluginWireMetadata, rememberPluginMessages } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";

const messages: CoreMessage[] = [
    { id: "raw-a", role: "user", contentType: "text", text: "first" },
    { id: "raw-b", role: "assistant", contentType: "text", text: "second" },
    { id: "raw-c", role: "user", contentType: "text", text: "third" },
];

test.beforeEach(() => {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ dir: join(tmpdir(), "bili-wire-metadata-disabled"), enabled: false }));
});
test.afterEach(() => _resetSessionsForTest());

function pluginSession(id: string) {
    const session = getSession(id);
    session.metadata.pluginAgent = "codex";
    return session;
}

test("precomputed wire metadata matches raw-buffer snapshot evidence across wire shapes", () => {
    const cases: { wire: unknown; comparable: boolean; raw?: string }[] = [
        { wire: { messages: [{ role: "user", content: "中😀" }] }, comparable: true },
        { wire: { input: [{ type: "message", content: [{ type: "input_text", text: "text" }] }] }, comparable: true },
        { wire: { contents: [{ role: "user", parts: [{ text: "text" }] }] }, comparable: true },
        { wire: { messages: null, input: "fallback" }, comparable: true },
        { wire: { messages: [{ content: [{ type: "image", source: {} }] }], input: "ignored" }, comparable: false },
        { wire: { messages: [{ content: [{ type: "tool_use", input: { type: "image" } }] }] }, comparable: true },
        { wire: { messages: [{ content: [{ type: "thinking", thinking: "signed" }] }] }, comparable: false },
        { wire: { messages: [{ content: "text", audio: {} }] }, comparable: false },
        { wire: null, comparable: false },
        { wire: 42, comparable: false },
        { wire: "text", comparable: false },
        { wire: undefined, raw: "{invalid", comparable: false },
    ];
    for (const [i, { wire, comparable, raw }] of cases.entries()) {
        const body = Buffer.from(raw ?? JSON.stringify(wire, null, 2));
        const evidence = preparePluginWireMetadata(body, wire);
        assert.deepEqual(evidence, {
            wireHash: createHash("sha256").update(body).digest("hex"),
            textComparable: comparable,
        });
        const legacy = pluginSession(`raw-${i}`);
        const prepared = pluginSession(`prepared-${i}`);
        rememberPluginMessages(legacy.id, messages, messages, undefined, body);
        rememberPluginMessages(prepared.id, messages, messages, undefined, evidence);
        assert.equal(prepared.metadata.publicSnapshotWireHash, legacy.metadata.publicSnapshotWireHash);
        assert.equal(prepared.metadata.publicSnapshotTextComparable, legacy.metadata.publicSnapshotTextComparable);
        assert.equal(prepared.revisionEpoch, legacy.revisionEpoch);
    }
});

test("preparing wire metadata neither reparses nor commits, and survives input mutation", (t) => {
    const session = pluginSession("deferred");
    const wire: Record<string, unknown> = { messages: [{ role: "user", content: "original" }] };
    const body = Buffer.from(JSON.stringify(wire));
    const expectedHash = createHash("sha256").update(body).digest("hex");
    const parse = t.mock.method(JSON, "parse", () => { throw new Error("must reuse the parsed request"); });
    const evidence = preparePluginWireMetadata(body, wire);
    assert.equal(parse.mock.callCount(), 0);
    parse.mock.restore();
    assert.equal(session.metadata.publicSnapshotWireHash, undefined);
    assert.equal(session.metadata.publicSnapshotTextComparable, undefined);
    assert.equal(session.pluginSnapshot, undefined);
    assert.equal(session.revisionEpoch, undefined);

    body.fill(0);
    wire.messages = [{ content: [{ type: "image", source: {} }] }];
    rememberPluginMessages(session.id, messages, messages, undefined, evidence);
    assert.equal(session.metadata.publicSnapshotWireHash, expectedHash);
    assert.equal(session.metadata.publicSnapshotTextComparable, true);
});

test("wire evidence preserves hash-gated bookkeeping and rejected-view guards", () => {
    const session = pluginSession("bookkeeping");
    const wire = { messages: [{ role: "user", content: "text" }] };
    const evidence = preparePluginWireMetadata(Buffer.from(JSON.stringify(wire)), wire);
    rememberPluginMessages(session.id, messages, messages, undefined, evidence);
    const revision = session.revisionEpoch;
    const snapshot = session.pluginSnapshot;
    rememberPluginMessages(session.id, messages, messages, undefined, evidence);
    assert.equal(session.revisionEpoch, revision, "identical retries do not mark dirty");

    const reformatted = preparePluginWireMetadata(Buffer.from(JSON.stringify(wire, null, 2)), wire);
    assert.notEqual(reformatted.wireHash, evidence.wireHash, "hash follows exact request bytes");
    rememberPluginMessages(session.id, messages, messages, undefined, reformatted);
    assert.equal(session.metadata.publicSnapshotWireHash, reformatted.wireHash);
    assert.equal(session.revisionEpoch, revision, "a new hash with the same verdict does not mark dirty");

    const opaque = { input: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] };
    const opaqueEvidence = preparePluginWireMetadata(Buffer.from(JSON.stringify(opaque)), opaque);
    rememberPluginMessages(session.id, messages, messages, undefined, opaqueEvidence);
    assert.equal(session.metadata.publicSnapshotTextComparable, false);
    assert.equal(session.revisionEpoch, (revision ?? 0) + 1, "changed comparability marks dirty");
    assert.equal(session.pluginSnapshot, snapshot, "wire evidence does not replace the message snapshot");
    rememberPluginMessages(session.id, messages, messages, undefined, { ...opaqueEvidence, textComparable: true });
    assert.equal(session.metadata.publicSnapshotTextComparable, false, "the saved hash gates verdict changes");

    const side: CoreMessage[] = [{ id: "unrelated", role: "user", contentType: "text", text: "side request" }];
    rememberPluginMessages(session.id, side, side, undefined, evidence);
    assert.equal(session.metadata.publicSnapshotWireHash, opaqueEvidence.wireHash);
    assert.equal(session.metadata.publicSnapshotTextComparable, false);
    assert.equal(session.revisionEpoch, (revision ?? 0) + 1);

    const nonPlugin = getSession("non-plugin");
    rememberPluginMessages(nonPlugin.id, messages, messages, undefined, evidence);
    assert.equal(nonPlugin.metadata.publicSnapshotWireHash, undefined);
    const empty = pluginSession("empty");
    rememberPluginMessages(empty.id, [], [], undefined, evidence);
    assert.equal(empty.metadata.publicSnapshotWireHash, undefined);
});
