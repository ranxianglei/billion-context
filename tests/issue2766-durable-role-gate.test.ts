import { test } from "node:test";
import assert from "node:assert/strict";
import {
    dshMcpCatalogPath,
    dshRuntimeContextPath,
    dshSkillCatalogPath,
    dshWorkspaceInstructionsPath,
    durableMessageToolPaths,
    withDurableProtection,
} from "../src/durable-message-guards.ts";
import { collectLatestProtected, defaultConfig, isMessageLatestProtected, type Config, type CoreMessage } from "acp-kernel";

// #2766: the durable classifiers had no role boundary. Every carrier is a
// host INJECTION into the user channel, but a model ECHO of a carrier marker
// (anything visible to the model eventually shows up in its output) used to
// project too — and under the default latest-per-identity policy
// (protectedLatestTools: ["durable/*"]) the LATER echo took the identity over
// from the real carrier: the echo got pinned, the real carrier demoted to
// foldable, one compression later the forged/partial copy was the only
// survivor. The classifiers now refuse assistant-role messages outright.

function msg(role: CoreMessage["role"], text: string, id = "m1"): CoreMessage {
    return { id, role, contentType: "text", text };
}

const CARRIERS: Array<[name: string, marker: string, path: string, cls: (m: CoreMessage) => string | undefined]> = [
    ["skill catalog", "<available_skills>", "durable/skill-catalog", dshSkillCatalogPath],
    ["workspace instructions", "Instructions from: ~/.dsh/AGENTS.md", "durable/agents-md", dshWorkspaceInstructionsPath],
    ["mcp catalog", "<mcp_catalog>\n- server: fs\n</mcp_catalog>", "durable/mcp-catalog", dshMcpCatalogPath],
    ["runtime context", "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", "durable/runtime-context", dshRuntimeContextPath],
];

for (const [name, marker, path, cls] of CARRIERS) {
    test(`Path: a model echo of the ${name} marker never projects (#2766)`, () => {
        assert.equal(cls(msg("assistant", `here is the catalog you asked for:\n${marker}`)), undefined);
        assert.equal(durableMessageToolPaths["dsh"]!(msg("assistant", marker)), undefined, "the lane-composed classifier refuses it too");
    });
    test(`Path: the user-role ${name} carrier still projects (#2766)`, () => {
        assert.equal(cls(msg("user", marker)), path);
        assert.equal(durableMessageToolPaths["dsh"]!(msg("user", marker)), path);
    });
}

test("Path: system-role carrier text still projects — the gate targets model output only (#2766)", () => {
    assert.equal(dshSkillCatalogPath(msg("system", "<available_skills>")), "durable/skill-catalog");
});

test("kernel: an assistant echo cannot take over the latest durable identity (#2766)", () => {
    const config: Config = withDurableProtection(defaultConfig(200_000), durableMessageToolPaths["dsh"]!);
    assert.deepEqual(config.protectedLatestTools, ["durable/*"], "default policy is latest-per-identity");
    // The real carrier arrives early (host injection); the model echoes the
    // marker LATER — under lastByPath the later match used to win.
    const carrier = msg("user", "<mcp_catalog>\n- server: fs\n</mcp_catalog>", "m00001");
    const filler = msg("user", "some ordinary work", "m00002");
    const echo = msg("assistant", "Sure, the catalog looks like:\n<mcp_catalog>\n- server: totally-real\n</mcp_catalog>", "m00003");
    const messages = [carrier, filler, echo];
    const latest = collectLatestProtected(messages, config);
    assert.ok(latest.msgIds.has("m00001"), "the real carrier keeps the durable/mcp-catalog identity");
    assert.ok(!latest.msgIds.has("m00003"), "the assistant echo does not become the latest instance");
    assert.equal(isMessageLatestProtected(echo, latest), false, "the echo stays foldable");
    assert.equal(isMessageLatestProtected(carrier, latest), true, "the real carrier stays pinned");
});

test("kernel: an assistant echo between two real carriers does not break succession (#2766)", () => {
    const config: Config = withDurableProtection(defaultConfig(200_000), durableMessageToolPaths["dsh"]!);
    const v1 = msg("user", "Current runtime context. sandbox=on", "m00001");
    const echo = msg("assistant", "Current runtime context — I'll track that.", "m00002");
    const v2 = msg("user", "Current runtime context. sandbox=off. This snapshot supersedes earlier runtime-context snapshots.", "m00003");
    const latest = collectLatestProtected([v1, echo, v2], config);
    assert.ok(latest.msgIds.has("m00003"), "the newest real snapshot is the pinned one");
    assert.ok(!latest.msgIds.has("m00002"), "the echo never projects");
});
