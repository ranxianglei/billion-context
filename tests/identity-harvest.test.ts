// #5825 identity-channel wiring: registry gates, reader primitives, and the
// two harvest sources (claude-code / codebuddy) against fixture stores.
//
// Discipline under test (the whole point of the seam): every doubt degrades
// the ENTIRE turn (null) — no partial pairing ever escapes, because ids are
// never reused by any harvested client and a miss only costs pinning.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HARVEST_TAIL_BYTES, findProjectJsonlFiles, headerFirst, harvestIdentity, readJsonlTail, registerIdentitySource, resetIdentityHarvestForTest, type IdentityHarvestCtx } from "../src/identity-harvest.js";
import { claudeVisibleRows, registerClaudeIdentitySource } from "../src/identity-claude.js";
import { codebuddyVisibleRows, registerCodebuddyIdentitySource } from "../src/identity-codebuddy.js";
import { registerGooseIdentitySource } from "../src/identity-goose.js";
import { registerMcodeIdentitySource } from "../src/identity-mcode.js";
import { registerQwenIdentitySource } from "../src/identity-qwen.js";
import { conversationHeaderSource } from "../src/session-id.js";
import { openSqliteDatabase } from "../src/storage/driver.js";

const ENV = "BILI_IDENTITY_HARVEST";
// #5825 owner ruling: the seam has its OWN cohort key — decoupled from
// pluginLaneServerHistory (that one governs where stamped ids get PINNED).
const ROLLOUT_ENV = "BILI_ROLLOUT_IDENTITY_CHANNEL_HARVEST";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function ctx(over: Partial<IdentityHarvestCtx> = {}): IdentityHarvestCtx {
    return { sessionId: "s-1", expectedLen: 2, remoteAddress: "127.0.0.1", headers: {}, ...over };
}

test("harvest registry: env switch and cohort rollout are INDEPENDENT enablers", () => {
    resetIdentityHarvestForTest();
    let snapshotCalls = 0;
    registerIdentitySource({ id: "gate", matches: () => true, snapshot: () => { snapshotCalls++; return ["a-1", "a-2"]; } });
    // Nothing enabled at all → inert, no disk access.
    withEnv({ [ENV]: undefined, [ROLLOUT_ENV]: undefined }, () => {
        assert.equal(harvestIdentity(ctx()), null, "no env, no rollout → inert (ships off by default)");
        assert.equal(snapshotCalls, 0);
    });
    // Per-install env switch alone suffices (the owner-facing knob) and
    // scopes to the named source.
    withEnv({ [ENV]: "gate", [ROLLOUT_ENV]: undefined }, () => {
        assert.deepEqual(harvestIdentity(ctx()), { ids: ["a-1", "a-2"], sourceId: "gate" });
        assert.equal(snapshotCalls, 1);
    });
    // Cohort-wide rollout key alone enables, without an env scope → all sources.
    withEnv({ [ENV]: undefined, [ROLLOUT_ENV]: "1" }, () => {
        assert.deepEqual(harvestIdentity(ctx()), { ids: ["a-1", "a-2"], sourceId: "gate" });
        assert.equal(snapshotCalls, 2);
    });
});

test("harvest registry: loopback boundary + env scoping", () => {
    resetIdentityHarvestForTest();
    let snapshotCalls = 0;
    registerIdentitySource({ id: "fake", matches: () => true, snapshot: () => { snapshotCalls++; return ["a-1", "a-2"]; } });
    withEnv({ [ENV]: "other-lane", [ROLLOUT_ENV]: "1" }, () => {
        assert.equal(harvestIdentity(ctx()), null);
        assert.equal(snapshotCalls, 0, "scoped env must not touch disk for other lanes");
    });
    withEnv({ [ENV]: "fake", [ROLLOUT_ENV]: "1" }, () => {
        assert.equal(harvestIdentity(ctx({ remoteAddress: "192.168.1.50" })), null);
        assert.equal(snapshotCalls, 0, "non-loopback caller may never trigger local reads");
        const ok = harvestIdentity(ctx());
        assert.deepEqual(ok, { ids: ["a-1", "a-2"], sourceId: "fake" });
        assert.equal(snapshotCalls, 1);
    });
});

test("harvest registry: whole-turn degrade on count mismatch and canonical validation", () => {
    resetIdentityHarvestForTest();
    registerIdentitySource({ id: "short", matches: () => true, snapshot: () => ["only-one"] });
    withEnv({ [ENV]: "short", [ROLLOUT_ENV]: "1" }, () => {
        assert.equal(harvestIdentity(ctx({ expectedLen: 3 })), null);
    });
    // #4491 canonical rule is the final gate: reserved prefix / duplicate /
    // control char all kill the turn even when counts line up.
    for (const bad of [["acp_summary_x", "b"], ["a", "a"], ["a b", "c"]]) {
        resetIdentityHarvestForTest();
        registerIdentitySource({ id: "bad", matches: () => true, snapshot: () => bad as string[] });
        withEnv({ [ENV]: "bad", [ROLLOUT_ENV]: "1" }, () => {
            assert.equal(harvestIdentity(ctx({ expectedLen: 2 })), null, JSON.stringify(bad));
        });
    }
});

/* ---------------- reader primitives ---------------- */

test("readJsonlTail: complete lines only; bounded tail drops the split first line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-tail-"));
    const file = path.join(dir, "t.jsonl");
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(2000) }));
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const got = readJsonlTail(file);
    assert.equal(got.length, 300);
    assert.deepEqual(JSON.parse(got[0]), JSON.parse(lines[0]));
    // trailing partial line (transcript being written) is dropped
    fs.appendFileSync(file, '{"incomplete": tr');
    assert.equal(readJsonlTail(file).length, 300);
    // huge file → tail window; first windowed line is split mid-entry → dropped
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-big-"));
    const big = path.join(bigDir, "big.jsonl");
    const n = Math.ceil((HARVEST_TAIL_BYTES * 2) / 2100) + 50;
    const allLines = Array.from({ length: n }, (_, i) => JSON.stringify({ i, pad: "x".repeat(2000) }));
    fs.writeFileSync(big, allLines.join("\n") + "\n");
    const tail = readJsonlTail(big);
    assert.ok(tail.length > 0 && tail.length < n, `bounded tail (${tail.length} of ${n})`);
    assert.equal(JSON.stringify(JSON.parse(tail[tail.length - 1])), allLines[n - 1]);
    const idx = tail.map((l) => (JSON.parse(l) as { i: number }).i);
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], "window keeps ascending original order");
});

test("findProjectJsonlFiles: probes projects/*, reports each hit, tolerates absent roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ih-proj-"));
    const p1 = path.join(root, "projects", "-home-dog-x");
    const p2 = path.join(root, "projects", "-home-dog-y");
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p1, "conv-1.jsonl"), "{}\n");
    assert.deepEqual(findProjectJsonlFiles([root], "conv-1"), [path.join(p1, "conv-1.jsonl")]);
    fs.writeFileSync(path.join(p2, "conv-1.jsonl"), "{}\n");
    assert.equal(findProjectJsonlFiles([root], "conv-1").length, 2, "two project dirs → two candidates (upstream treats >1 as ambiguous)");
    assert.deepEqual(findProjectJsonlFiles([path.join(root, "nope")], "conv-1"), []);
    // a config root passed AS the projects dir works too
    assert.equal(findProjectJsonlFiles([path.join(root, "projects")], "conv-1").length, 2);
});

/* ---------------- adapters ---------------- */

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";

function writeFixture(configDir: string, sessionKey: string, rows: unknown[]): string {
    const proj = path.join(configDir, "projects", "-home-dog-ws");
    fs.mkdirSync(proj, { recursive: true });
    const file = path.join(proj, `${sessionKey}.jsonl`);
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return file;
}

test("claude adapter: sidechain/summary rows excluded, tail alignment, role spot-check", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-claude-"));
    const file = writeFixture(configDir, CLAUDE_ID, [
        { uuid: "u1", type: "user", message: { role: "user" } },
        { uuid: "a1", type: "assistant", message: { role: "assistant" } },
        { uuid: "side-1", type: "assistant", isSidechain: true, message: { role: "assistant" } },
        { uuid: "u2", type: "user", message: { role: "user" } },
        { uuid: "sum-1", type: "summary", message: { role: "user" } },
        { uuid: "a2", type: "assistant", message: { role: "assistant" } },
        { uuid: "u3", type: "user", message: { role: "user" } },
    ]);
    const vis = claudeVisibleRows(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
    assert.deepEqual(vis.map((r) => r.id), ["u1", "a1", "u2", "a2", "u3"], "visible projection excludes sidechain+summary");

    resetIdentityHarvestForTest();
    registerClaudeIdentitySource();
    const base = { "x-claude-code-session-id": CLAUDE_ID };
    withEnv({ CLAUDE_CONFIG_DIR: configDir, [ENV]: "claude", [ROLLOUT_ENV]: "1" }, () => {
        assert.equal(headerFirst(ctx({ sessionId: CLAUDE_ID, headers: base }), "x-claude-code-session-id"), CLAUDE_ID);
        // full-tail match, stored roles agree at the exposed boundary positions
        const ok = harvestIdentity(ctx({ sessionId: CLAUDE_ID, expectedLen: 3, headers: base, messageRoles: ["user", "assistant", "user"] }));
        assert.deepEqual(ok?.ids, ["u2", "a2", "u3"]);
        // boundary role spot-check: wire claims user,user but stored tail ends assistant → whole-turn null
        assert.equal(harvestIdentity(ctx({ sessionId: CLAUDE_ID, expectedLen: 2, headers: base, messageRoles: ["user", "user"] })), null);
        // fewer visible rows than requested → null
        assert.equal(harvestIdentity(ctx({ sessionId: CLAUDE_ID, expectedLen: 99, headers: base })), null);
        // wrong join key → source never matched
        assert.equal(harvestIdentity(ctx({ sessionId: "other", expectedLen: 3, headers: base })), null);
        // non-UUID header value → not a claude lane
        assert.equal(harvestIdentity(ctx({ sessionId: "abc", expectedLen: 3, headers: { "x-claude-code-session-id": "abc" } })), null);
    });
});

test("codebuddy adapter: id+parentId rows only, system rows out, loose role map", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-cb-"));
    const CONV = "9f8e7d6c-55aa-4bbb-8ccc-000011112222";
    const rowsIn = [
        { id: "sys-1", parentId: "", role: "system" },
        { id: "m1", parentId: "", role: "user", providerData: { messageId: "w1" } },
        { id: "m2", parentId: "m1", role: "assistant", providerData: { conversationRequestId: "t1", messageId: "w2" } },
        { id: "m3", parentId: "m2", providerData: {} },
        { id: "no-parent" },
        { id: "m4", parentId: "m3", role: "user" },
    ];
    const file = writeFixture(configDir, CONV, rowsIn); // same layout: <config>/projects/<dir>/<id>.jsonl
    const vis = codebuddyVisibleRows(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
    assert.deepEqual(vis.map((v) => v.id), ["m1", "m2", "m3", "m4"], "system row and parentless junk excluded");

    resetIdentityHarvestForTest();
    registerCodebuddyIdentitySource();
    const base = { "x-conversation-id": CONV };
    withEnv({ CODEBUDDY_CONFIG_DIR: configDir, [ENV]: "codebuddy", [ROLLOUT_ENV]: "1" }, () => {
        const ok = harvestIdentity(ctx({ sessionId: CONV, expectedLen: 4, headers: base }));
        assert.deepEqual(ok?.ids, ["m1", "m2", "m3", "m4"]);
        // role spot-check engages only where the STORED row exposes a role:
        // m3 has none → skipped; wire user vs stored assistant on m2 kills it
        assert.equal(harvestIdentity(ctx({ sessionId: CONV, expectedLen: 3, headers: base, messageRoles: ["user", "user", "user"] })), null);
        const goodRoles = harvestIdentity(ctx({ sessionId: CONV, expectedLen: 3, headers: base, messageRoles: ["assistant", "", "user"] }));
        assert.deepEqual(goodRoles?.ids, ["m2", "m3", "m4"]);
    });
});

test("mcode adapter: sqlite harvest per-turn snapshot, count parity + role spot-check", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-mcode-"));
    const dbFile = path.join(dataDir, "v2", "sqlite", "runtime-state.sqlite");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const SID = "mvs_" + "ab12cd34ef56ab12cd34ef56ab12cd34";
    const w = openSqliteDatabase(dbFile);
    try {
        w.db.exec("CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL, role TEXT, turn_id TEXT, data_json TEXT)");
        for (const [msgId, role] of [["msg-1-a", "user"], ["msg-2-b", "assistant"], ["msg-3-c", "tool"], ["msg-4-d", "user"]]) {
            w.db.prepare("INSERT INTO local_runtime_message_rows (session_id, msg_id, role) VALUES (?, ?, ?)").run(SID, msgId, role);
        }
        // a foreign session must never leak in
        w.db.prepare("INSERT INTO local_runtime_message_rows (session_id, msg_id, role) VALUES (?, ?, ?)").run("mvs_ffffffffffffffffffffffffffffffff", "other-x", "user");
    } finally {
        w.db.close();
    }
    resetIdentityHarvestForTest();
    registerMcodeIdentitySource();
    const base = { "x-mavis-session-id": SID };
    withEnv({ MINIMAX_DATA_DIR: dataDir, [ENV]: "mcode", [ROLLOUT_ENV]: "1" }, () => {
        const ok = harvestIdentity(ctx({ sessionId: SID, expectedLen: 4, headers: base, messageRoles: ["user", "assistant", "tool", "user"] }));
        assert.deepEqual(ok?.ids, ["msg-1-a", "msg-2-b", "msg-3-c", "msg-4-d"]);
        // wire claims assistant at a position stored as tool → whole turn degrades
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 4, headers: base, messageRoles: ["user", "assistant", "assistant", "user"] })), null);
        // fewer rows than requested → null
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 5, headers: base })), null);
        // non-mcode id shape → source never matched even with same value echo
        assert.equal(harvestIdentity(ctx({ sessionId: "plain", expectedLen: 4, headers: { "x-mavis-session-id": "plain" } })), null);
    });
});

/* ---------------- goose adapter ---------------- */

test("goose adapter: sqlite harvest per-turn snapshot, parity + join gate", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ih-goose-"));
    const dbFile = path.join(dataDir, "data", "sessions.db");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const SID = "20261107_1";
    const w = openSqliteDatabase(dbFile);
    try {
        w.db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT, content_json TEXT, created_timestamp INTEGER)");
        for (const [msgId, role] of [["msg_g1", "user"], ["msg_g2", "assistant"], ["msg_g3", "tool"], ["msg_g4", "user"]]) {
            w.db.prepare("INSERT INTO messages (message_id, session_id, role, created_timestamp) VALUES (?, ?, ?, ?)").run(msgId, SID, role, 1);
        }
        // a foreign session must never leak in; NULL message_id rows are skipped
        w.db.prepare("INSERT INTO messages (message_id, session_id, role) VALUES (?, ?, ?)").run("other", "20261107_9", "user");
        w.db.prepare("INSERT INTO messages (message_id, session_id, role) VALUES (?, ?, ?)").run(null, SID, "user");
    } finally {
        w.db.close();
    }
    resetIdentityHarvestForTest();
    registerGooseIdentitySource();
    const base = { "agent-session-id": SID };
    withEnv({ GOOSE_PATH_ROOT: dataDir, [ENV]: "goose", [ROLLOUT_ENV]: "1" }, () => {
        const ok = harvestIdentity(ctx({ sessionId: SID, expectedLen: 4, headers: base, messageRoles: ["user", "assistant", "tool", "user"] }));
        assert.deepEqual(ok?.ids, ["msg_g1", "msg_g2", "msg_g3", "msg_g4"]);
        // wire claims assistant where storage says tool → whole turn degrades
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 4, headers: base, messageRoles: ["user", "assistant", "assistant", "user"] })), null);
        // count mismatch → null
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 5, headers: base })), null);
        // join key absent → source never matched
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 4, headers: {} })), null);
    });
});

/* ---------------- qwen adapter ---------------- */

function writeQwenTranscript(root: string, proj: string, sid: string, lines: unknown[]): void {
    const dir = path.join(root, "projects", proj, "chats");
    fs.mkdirSync(dir, { recursive: true });
    const text = lines
        .map((l) => {
            // raw strings prefixed with RAW are written verbatim (torn-line fixture)
            return typeof l === "string" && l.startsWith("RAW:") ? l.slice(4) : JSON.stringify(l);
        })
        .join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), text);
}

test("qwen adapter: chats/<sid>.jsonl harvest, opt-in join + exclusions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ih-qwen-"));
    const SID = "0a1b2c3d-0000-4000-8000-0000000000aa";
    writeQwenTranscript(root, "projA", SID, [
        { uuid: "a1a2a3a4-b5b6-4c7d-8e9f-a0b1c2d3e4f5", type: "user" },
        { uuid: "tool-x", type: "tool_result" },
        { uuid: "b7e6f5a4-0000-4000-8000-000000000002", type: "assistant" },
        { uuid: "c8f7a6b5-0000-4000-8000-000000000003", type: "system", subtype: "chat_compression" },
        { uuid: "d9a8e7c6-0000-4000-8000-000000000004", type: "user", isSidechain: true },
        { uuid: "e0e1e2e3-4000-5000-6000-a0b1c2d3e4f6", type: "assistant" },
        "RAW:{\"torn\": true",
    ]);
    resetIdentityHarvestForTest();
    registerQwenIdentitySource();
    const base = { "x-opencode-session": SID };
    withEnv({ QWEN_HOME: root, [ENV]: "qwen", [ROLLOUT_ENV]: "1" }, () => {
        const ok = harvestIdentity(ctx({ sessionId: SID, expectedLen: 3, headers: base, messageRoles: ["user", "assistant", "assistant"] }));
        assert.deepEqual(ok?.ids, [
            "a1a2a3a4-b5b6-4c7d-8e9f-a0b1c2d3e4f5",
            "b7e6f5a4-0000-4000-8000-000000000002",
            "e0e1e2e3-4000-5000-6000-a0b1c2d3e4f6",
        ]);
        // the documented join header is the whole gate — absent → no disk probe
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 3, headers: {} })), null);
        // value must match the recognized session exactly
        assert.equal(harvestIdentity(ctx({ sessionId: "other-sid", expectedLen: 3, headers: { "x-opencode-session": "other-sid" } })), null);
    });
    // ambiguous transcript layout (same sid under two project dirs) → none
    writeQwenTranscript(root, "projB", SID, [{ uuid: "f1f2f3f4-4000-5000-6000-a0b1c2d3e4f7", type: "user" }]);
    resetIdentityHarvestForTest();
    registerQwenIdentitySource();
    withEnv({ QWEN_HOME: root, [ENV]: "qwen", [ROLLOUT_ENV]: "1" }, () => {
        assert.equal(harvestIdentity(ctx({ sessionId: SID, expectedLen: 3, headers: base })), null);
    });
});

/* ---------------- recognition merge ---------------- */

test("session recognition: x-conversation-id sits below client-specific + affinity tier, above bare generics", () => {
    const src = (h: Record<string, string>) => conversationHeaderSource(h);
    assert.equal(src({ "x-conversation-id": "cb-1" })?.name, "x-conversation-id");
    assert.equal(src({ "x-opencode-session-id": "oc", "x-conversation-id": "cb-1" })?.name, "x-opencode-session-id");
    assert.equal(src({ "x-session-affinity": "af", "x-conversation-id": "cb-1" })?.name, "x-session-affinity");
    assert.equal(src({ "x-acp-session": "acp", "x-conversation-id": "cb-1" })?.name, "x-acp-session");
    // without any stricter signal it beats the bare generics
    assert.equal(src({ "x-conversation-id": "cb-1", "session_id": "gen" })?.value, "cb-1");
    // value travels trimmed
    assert.equal(src({ "x-conversation-id": "  cb-2  " })?.value, "cb-2");
    // goose's client-specific header rides in the specific tier
    assert.equal(src({ "agent-session-id": "20261107_1", "session_id": "gen" })?.name, "agent-session-id");
    assert.equal(src({ "x-claude-code-session-id": "cc-1", "agent-session-id": "20261107_1" })?.name, "x-claude-code-session-id");
});
