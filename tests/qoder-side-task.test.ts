// #7439 worklist — Qoder side-task sidecar (src/session-id.ts qoderSideTaskConversation).
// Qoder's side tasks (agent summary / webfetch summary / hook prompt) reuse the
// parent x-session-id and carry their task type only in the Responses body
// metadata.business_type. The server gives each its own `|aux:qoder-<type>` lane
// (the zcode-memory pattern) so a side task does not merge into the parent
// conversation. Plain Task subagents carry no wire marker and are unfixable here.
//
// Hermetic roots mirror tests/trust-stamped-id.test.ts: a directly-invoked single
// file does NOT get tests/preload-test-env.mjs, and session-id.ts pulls in the
// prefix-affinity / store modules which touch XDG paths at load.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-"));
process.env.XDG_DATA_HOME = path.join(XDG, "data");
process.env.XDG_STATE_HOME = path.join(XDG, "state");
process.env.XDG_CACHE_HOME = path.join(XDG, "cache");
process.env.XDG_CONFIG_HOME = path.join(XDG, "config");
process.env.BILI_PERSIST = "0";
process.env.NODE_ENV = "test";

const { qoderSideTaskConversation } = await import("../src/session-id.ts");

test("qoder side task keys its own |aux: lane off body metadata.business_type", () => {
    assert.equal(qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary" } }), "q|aux:qoder-agent_summary");
    assert.equal(qoderSideTaskConversation("q", { metadata: { business_type: "webfetch_summary" } }), "q|aux:qoder-webfetch_summary");
    assert.equal(qoderSideTaskConversation("q", { metadata: { business_type: "hook_prompt" } }), "q|aux:qoder-hook_prompt");
});

test("qoder side task of the SAME business_type disambiguates by body metadata.task_id", () => {
    // Two same-type side tasks under one parent are distinct conversations; with
    // GA-on (which retires the in-lane content-guessed split) the per-task id
    // keeps them apart (zcode x-query-id pattern). Without it they'd merge +
    // cross-bleed compression state.
    assert.equal(
        qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary", task_id: "t-1" } }),
        "q|aux:qoder-agent_summary:t-1",
    );
    assert.equal(
        qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary", task_id: "t-2" } }),
        "q|aux:qoder-agent_summary:t-2",
    );
    assert.notEqual(
        qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary", task_id: "t-1" } }),
        qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary", task_id: "t-2" } }),
    );
    // Malformed task_id (path-traversal charset) is ignored → type-only lane.
    assert.equal(
        qoderSideTaskConversation("q", { metadata: { business_type: "agent_summary", task_id: "../evil" } }),
        "q|aux:qoder-agent_summary",
    );
});

test("non-qoder type / missing marker / non-object body → no sidecar", () => {
    assert.equal(qoderSideTaskConversation("q", { metadata: { business_type: "main" } }), undefined);
    assert.equal(qoderSideTaskConversation("q", { metadata: {} }), undefined);
    assert.equal(qoderSideTaskConversation("q", { metadata: { business_type: 123 } }), undefined);
    assert.equal(qoderSideTaskConversation("q", { input: "hi" }), undefined);
    assert.equal(qoderSideTaskConversation("q", null), undefined);
    assert.equal(qoderSideTaskConversation("q", undefined), undefined);
});
