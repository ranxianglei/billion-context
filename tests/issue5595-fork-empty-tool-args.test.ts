// #5595: forking a parent whose history held multimodal/thinking content cannot
// be textually compared, so adoption degrades to a full raw-history rebuild.
// Unrecovered tool-call cores serialize as EMPTY function.arguments on the OpenAI
// wire — a hard provider 400 ("...must be a valid JSON object string") that
// compaction/preflight cannot rescue (it is a VALIDATION failure, not a size
// failure), bricking the forked child forever. The outbound boundary must never
// emit empty/non-object JSON arguments: valid args ride byte-exact (wire fidelity,
// #1039: tool-call arguments are user intent); only empty/malformed ones become a
// parseable placeholder. Sibling of #3661 (the model-produced-non-JSON case).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
    isValidToolCallArguments,
    hardenOpenaiToolCallArguments,
    EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER,
} from "../src/util.ts";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import { SessionStore } from "../src/persist.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { rmrf } from "./tmp-rm.ts";

// --- isValidToolCallArguments: the single definition of a sendable argument ---
test("#5595 isValidToolCallArguments accepts exactly a JSON object string", () => {
    assert.equal(isValidToolCallArguments('{"a":1}'), true, "object");
    assert.equal(isValidToolCallArguments("{}"), true, "empty object is still a valid object string");
    assert.equal(isValidToolCallArguments(""), false, "empty string (the reported defect)");
    assert.equal(isValidToolCallArguments("   "), false, "whitespace-only");
    assert.equal(isValidToolCallArguments("[]"), false, "array is not an object");
    assert.equal(isValidToolCallArguments('"str"'), false, "scalar string");
    assert.equal(isValidToolCallArguments("123"), false, "number");
    assert.equal(isValidToolCallArguments("null"), false, "null literal");
    assert.equal(isValidToolCallArguments("{bad"), false, "malformed JSON");
    assert.equal(isValidToolCallArguments(undefined), false, "absent (undefined)");
    assert.equal(isValidToolCallArguments({ a: 1 }), false, "already-an-object is not a string");
});

test("#5595 the placeholder itself is a valid JSON object string", () => {
    const parsed: unknown = JSON.parse(EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER);
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "placeholder parses to an object");
    assert.equal(isValidToolCallArguments(EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER), true);
});

type ToolMsg = { role: string; content?: unknown; tool_calls?: Array<Record<string, unknown>> };
function tc(id: string, args: unknown): Record<string, unknown> {
    return { id, type: "function", function: { name: "bash", arguments: args } };
}
function assistantWith(toolCalls: Array<Record<string, unknown>>): ToolMsg {
    return { role: "assistant", content: null, tool_calls: toolCalls };
}
function argsOf(msg: Record<string, unknown>): Array<{ id?: string; args?: string }> {
    const tcs = (msg.tool_calls as Array<{ id?: string; function?: { arguments?: string } }>) ?? [];
    return tcs.map((t) => ({ id: t.id, args: t.function?.arguments }));
}

test("#5595 empty tool-call arguments become the parseable placeholder", () => {
    const { messages, replaced } = hardenOpenaiToolCallArguments([assistantWith([tc("call_e", "")])]);
    assert.equal(replaced, 1, "one replacement counted");
    const [only] = argsOf(messages[0]!);
    assert.equal(only?.args, EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER, "swapped to the placeholder");
    JSON.parse(only!.args!); // stays sendable
});

test("#5595 malformed / non-object arguments are replaced too", () => {
    const { replaced } = hardenOpenaiToolCallArguments([assistantWith([tc("c1", "[1,2]"), tc("c2", "{trailing")])]);
    assert.equal(replaced, 2, "array and malformed are both unsendable");
});

// Gate negative (#3617 discipline): VALID arguments ride byte-exact — the swap
// must NOT fire for them (wire fidelity, #1039).
test("#5595 gate negative: valid arguments pass byte-exact, untouched", () => {
    const legal = '{"cmd":"ls -la","timeout":30}';
    const { messages, replaced } = hardenOpenaiToolCallArguments([assistantWith([tc("call_ok", legal)])]);
    assert.equal(replaced, 0, "no replacement for valid args");
    assert.equal(argsOf(messages[0]!)[0]?.args, legal, "byte-exact");
});

test("#5595 mixed turn: only the empty arg is swapped, the valid one stays exact", () => {
    const legal = '{"a":1}';
    const { messages, replaced } = hardenOpenaiToolCallArguments([assistantWith([tc("ok", legal), tc("bad", "")])]);
    assert.equal(replaced, 1);
    const [ok, bad] = argsOf(messages[0]!);
    assert.equal(ok?.args, legal, "valid untouched");
    assert.equal(bad?.args, EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER, "empty swapped");
});

test("#5595 messages without tool_calls pass through unchanged", () => {
    const input: ToolMsg[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }];
    const { messages, replaced } = hardenOpenaiToolCallArguments(input);
    assert.equal(replaced, 0);
    assert.deepEqual(messages, input, "untouched");
});

// Wiring pin: the guard sits in the openai adapter's outbound buildRequest, so an
// empty history tool-call arg is healed before the request leaves the proxy while
// a valid one rides byte-exact.
test("#5595 wiring: buildRequest heals an empty history tool-call arg, keeps a valid one exact", () => {
    const cores: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "run it" },
        { id: "a1", role: "assistant", contentType: "tool-call", text: "", toolName: "bash", toolCallId: "call_empty" },
        { id: "a2", role: "assistant", contentType: "tool-call", text: '{"cmd":"ls"}', toolName: "bash", toolCallId: "call_ok" },
    ];
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const out = adapter.buildRequest(cores, "sys", { model: "gpt" });
    const messages = (out.messages as Array<Record<string, unknown>>) ?? [];
    const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
    assert.ok(assistant, "an assistant tool-call message rides the request");
    const byId = new Map(argsOf(assistant!).map((t) => [t.id, t.args]));
    assert.equal(byId.get("call_empty"), EMPTY_TOOL_CALLS_ARGUMENTS_PLACEHOLDER, "empty history arg becomes the placeholder");
    JSON.parse(byId.get("call_empty")!); // sendable
    assert.equal(byId.get("call_ok"), '{"cmd":"ls"}', "valid history arg stays byte-exact");
});

// --- #5595/F4: the replicasUnavailable detail must name the ACTUAL cause ---
//
// The first F4 revision branched on liveStorageStamp === "legacy" — which is
// ALWAYS true inside the !replicasAvailable() branch (the stamp reads legacy
// whenever the sidecar is absent/disabled), so its else branch was dead code
// and every unified-configured instance with a down sidecar got stamped
// "durable storage is legacy-only" — mislabeling exactly the recoverable/
// latched cases F4 exists to tell apart. The discriminator is the
// constructor-time resolution (configuredUnified). Pin both branches against
// real stores: structurally legacy, and full-configured with a 3-strike-latched
// sidecar (stats.disabled flipped post-open — the #4942 seam skips env-driven
// open so no IO error simulation is needed).
const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;

function isolateEnv(base: string): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    const sessions = path.join(base, "sessions");
    mkdtempSync(sessions);
    process.env.BILI_SESSIONS_DIR = sessions;
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
    delete process.env.BILI_STORAGE_UNIFIED;
    delete process.env.BILI_ENCRYPTION_KEY;
    return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

test("#5595/F4 structural legacy-only instance selects the actionable config message", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bili-5595f4-legacy-"));
    const snap = isolateEnv(base);
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    try {
        const store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        assert.equal(store.configuredUnified, false, "knob resolved to legacy at construction");
        assert.equal(store.replicasAvailable(), false);
        assert.equal(store.sidecarDownReason(), "sidecar-missing");
        assert.equal(store.liveStorageStamp, "legacy");
        assert.ok(!store.configuredUnified, "⇒ the F4 bail must take the legacy-only branch here");
    } finally {
        restoreEnv(snap);
        rmrf(base);
    }
});

test("#5595/F4 unified-configured instance with latched sidecar keeps the #5188 reason", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bili-5595f4-latched-"));
    const snap = isolateEnv(base);
    process.env.BILI_STORAGE_UNIFIED = "full";
    try {
        const sessions = process.env.BILI_SESSIONS_DIR!;
        const shadow = UnifiedShadow.maybeOpen(sessions, process.env);
        assert.ok(shadow, "builtin node:sqlite opens a real sidecar in full mode");
        shadow.stats.disabled = true; // the 3-strike latch state
        const store = new SessionStore({ dir: sessions, enabled: true, shadow });
        assert.equal(store.configuredUnified, true, "configured unified despite the down sidecar");
        assert.equal(store.replicasAvailable(), false);
        assert.equal(store.sidecarDownReason(), "sidecar-disabled");
        assert.equal(
            store.liveStorageStamp,
            "legacy",
            "the conflation F4 must not branch on: live stamp reads legacy while the instance is configured unified",
        );
        assert.ok(!store.configuredUnified === false, "⇒ the F4 bail must keep sidecarDownReason() here, not the legacy-only message");
    } finally {
        restoreEnv(snap);
        rmrf(base);
    }
});

test("#5595/F4 encryption-blocked instance is structurally legacy despite a unified knob", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bili-5595f4-encrypted-"));
    const snap = isolateEnv(base);
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";
    try {
        const store = new SessionStore({ dir: process.env.BILI_SESSIONS_DIR, enabled: true });
        assert.equal(store.configuredUnified, false, "the hard-block resolves the instance to legacy-only at construction");
        assert.equal(store.replicasAvailable(), false);
        assert.equal(store.sidecarDownReason(), "sidecar-missing");
        assert.equal(store.liveStorageStamp, "legacy");
        assert.ok(!store.configuredUnified, "⇒ the F4 bail takes the legacy-only branch (the startup alarm names the key)");
    } finally {
        restoreEnv(snap);
        rmrf(base);
    }
});
