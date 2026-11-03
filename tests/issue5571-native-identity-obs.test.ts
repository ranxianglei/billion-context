// #5571 M1 — native identity observation layer: profiles table extraction,
// stability state machine, and the fail-open collection call.
import assert from "node:assert/strict";
import test from "node:test";
import { detectNativeProfile, extractNativeIdentity } from "../src/server/native-identity-profiles.ts";
import { mergeNidvState, nidvH8, observeNativeIdentity, NIDV_EXT_KEY } from "../src/server/native-identity-obs.ts";

const NOOP_LOG = () => { };
type Logged = { level: string; msg: string };
function spyLog(): { log: (level: string, msg: string) => void; lines: Logged[] } {
    const lines: Logged[] = [];
    return { log: (level, msg) => lines.push({ level, msg }), lines };
}

interface DuckStore {
    replicas: boolean;
    ext: Map<string, string>;
    reads: number;
    writes: number;
}
function duckStore(replicas = true): DuckStore {
    const d: DuckStore = { replicas, ext: new Map(), reads: 0, writes: 0 };
    return d;
}
function toView(d: DuckStore): Parameters<typeof observeNativeIdentity>[0]["store"] {
    return {
        replicasAvailable: () => d.replicas,
        getSessionExt: (sid, key) => { d.reads += 1; return d.ext.get(`${sid}\x00${key}`) ?? null; },
        setSessionExt: (sid, key, value) => { d.writes += 1; d.ext.set(`${sid}\x00${key}`, String(value)); },
    };
}

const WB_HDRS = { "x-conversation-id": "conv-abc", "x-conversation-message-id": "m-42", "x-request-id": "r-7" };
const CODEX_BODY_PREFIX = { input: [{ type: "message", role: "user", content: [{ text: "Another language model started to solve this problem and produced a summary. Here it is…" }] }] };
const CC_BODY_MATCH = { metadata: { user_id: JSON.stringify({ session_id: "cc-sess-1" }) }, messages: [] };
const CC_BODY_MISMATCH = { metadata: { user_id: JSON.stringify({ session_id: "cc-sess-OTHER" }) }, messages: [] };
const CC_BODY_OBJECT_DIALECT = { metadata: { user_id: { session_id: "cc-sess-1" } }, messages: [] };

test("profile detection: order pinned (wb > cc > opencode > codex > gemini > unknown)", () => {
    assert.equal(detectNativeProfile(WB_HDRS, "/v1/chat/completions", "openai").id, "wb");
    assert.equal(detectNativeProfile({ "x-claude-code-session-id": "s" }, "/v1/messages", "anthropic").id, "cc");
    assert.equal(detectNativeProfile({ "x-session-affinity": "ses_1" }, "/v1/chat/completions", "openai").id, "opencode");
    assert.equal(detectNativeProfile({ "x-codex-installation-id": "i" }, "/v1/responses", "responses").id, "codex");
    // codex fallback rule: responses protocol + x-client-request-id alone
    assert.equal(detectNativeProfile({ "x-client-request-id": "x" }, "/v1/responses", "responses").id, "codex");
    assert.equal(detectNativeProfile({}, "/v1beta/models/m:generateContent", "google").id, "gemini");
    assert.equal(detectNativeProfile({ "x-random": "1" }, "/v1/chat/completions", "openai").id, "unknown");
    // a header that only matters on the responses wire must NOT leak to cc traffic
    assert.equal(detectNativeProfile({ "x-client-request-id": "x" }, "/v1/messages", "anthropic").id, "unknown");
});

test("wb: header ids extracted + explicit compaction header is strongest signal", () => {
    const p = detectNativeProfile(WB_HDRS, "/v1/chat/completions", "openai");
    let obs = extractNativeIdentity(p, WB_HDRS, "/v1/chat/completions", "openai", {}, undefined);
    assert.equal(obs.sessVal, "conv-abc");
    assert.equal(obs.msgVal, "m-42");
    assert.equal(obs.reqVal, "r-7");
    assert.equal(obs.compactionSignal, null);
    obs = extractNativeIdentity(p, { ...WB_HDRS, "x-context-compacted": "1" }, "/v1/chat/completions", "openai", {}, undefined);
    assert.equal(obs.compactionSignal, "explicit-header");
    assert.equal(obs.compactionEvidence, "x-context-compacted");
});

test("codex: prefix anchored at user-text START; mid-text copy must NOT fire", () => {
    const p = { id: "codex" as const, extraHeaders: ["x-codex-installation-id"], compactionPrefixes: ["Another language model started to solve this problem"], compactPathSuffixes: ["/responses/compact"] };
    const hit = extractNativeIdentity(p, {}, "/v1/responses", "responses", CODEX_BODY_PREFIX, undefined);
    assert.equal(hit.compactionSignal, "prefix-match");
    const midText = { input: [{ type: "message", role: "user", content: [{ text: "hello\nAnother language model started to solve this problem — quoted in passing." }] }] };
    const miss = extractNativeIdentity(p, {}, "/v1/responses", "responses", midText, undefined);
    assert.equal(miss.compactionSignal, null);
    // dedicated endpoint class beats absence of everything else
    const ep = extractNativeIdentity(p, {}, "https://up/bili/https://x/v1/responses/compact", "responses", {}, undefined);
    assert.equal(ep.compactionSignal, "compact-endpoint");
});

test("cc: dual-channel verification + toolu anchor count; malformed dual channel swallowed", () => {
    const p = detectNativeProfile({ "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic");
    let obs = extractNativeIdentity(p, { "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic", CC_BODY_MATCH, '"toolu_a" "toolu_b"');
    assert.equal(obs.sessVal, "cc-sess-1");
    assert.equal(obs.dualBodySessVal, "cc-sess-1");
    assert.equal(obs.toolAnchorCount, 2);
    obs = extractNativeIdentity(p, { "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic", CC_BODY_MISMATCH, undefined);
    assert.equal(obs.dualBodySessVal, "cc-sess-OTHER");
    // object-encoded dialect
    const objObs = extractNativeIdentity(p, { "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic", CC_BODY_OBJECT_DIALECT, undefined);
    assert.equal(objObs.dualBodySessVal, "cc-sess-1");
    obs = extractNativeIdentity(p, { "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic", { metadata: { user_id: "{not-json" } }, undefined);
    assert.equal(obs.dualBodySessVal, undefined); // malformed: ignored, no throw
});

test("opencode: shape assertion fires on foreign wire markers only", () => {
    const p = detectNativeProfile({ "x-session-affinity": "ses_z" }, "/v1/chat/completions", "openai");
    assert.equal(p.id, "opencode");
    const clean = extractNativeIdentity(p, { "x-session-affinity": "ses_z" }, "/v1/chat/completions", "openai", { messages: [{ role: "user", content: "plain" }] }, '{"messages":[{"content":"plain"}]}');
    assert.equal(clean.shapeAssertFail, undefined);
    assert.equal(clean.sessVal, "ses_z");
    const drifted = extractNativeIdentity(p, { "x-session-affinity": "ses_z" }, "/v1/chat/completions", "openai", { messages: [{ role: "user", content: "plain" }] }, '{"messages":[{"id":"msg_leak","content":"plain"}]}');
    assert.equal(drifted.shapeAssertFail, "msg_");
});

test("stability matrix: fresh / repeat / change / restart continuity / flip / mismatch", () => {
    const wbObs = (): ReturnType<typeof extractNativeIdentity> => extractNativeIdentity(
        detectNativeProfile(WB_HDRS, "/v1/chat/completions", "openai"), WB_HDRS, "/v1/chat/completions", "openai", {}, undefined);
    let st = mergeNidvState(null, wbObs(), 1000);
    assert.equal(st.client, "wb");
    assert.equal(st.reqs, 1);
    assert.equal(st.sessH, nidvH8("conv-abc"));
    assert.equal(st.sessStable, "yes");
    assert.deepEqual(st.events, []);
    // raw value never stored: digest != raw
    assert.notEqual(st.sessH, "conv-abc");
    st = mergeNidvState(st, wbObs(), 2000);
    assert.equal(st.sessStable, "yes");
    assert.deepEqual(st.events, []);
    // changed session value → stable=no + id_change event
    const changed = { ...WB_HDRS, "x-conversation-id": "conv-XYZ" };
    st = mergeNidvState(st, extractNativeIdentity(detectNativeProfile(changed, "", "openai"), changed, "", "openai", {}, undefined), 3000);
    assert.equal(st.sessStable, "no");
    assert.equal(st.events.at(-1)?.k, "id_change");
    // restart continuity: feed a state deserialized from a previous blob
    const fromDisk = JSON.parse(JSON.stringify(st)) as typeof st;
    const after = mergeNidvState(fromDisk, wbObs(), 9000);
    assert.equal(after.reqs, st.reqs + 1);
    assert.equal(after.firstSeen, st.firstSeen);
    assert.equal(after.sessStable, "no"); // prior break persists across restart
    // profile flip under one bili session id
    const flipped = mergeNidvState(after, extractNativeIdentity(detectNativeProfile({ "x-claude-code-session-id": "s2" }, "/v1/messages", "anthropic"), { "x-claude-code-session-id": "s2" }, "/v1/messages", "anthropic", {}, undefined), 10000);
    assert.equal(flipped.client, "cc");
    assert.ok(flipped.events.some((e) => e.k === "profile_flip"));
    // dual mismatch event — evidence must be digest-only: raw channel values
    // never land in the persisted state (privacy redline, review of M1 PR)
    const mm = mergeNidvState(null, extractNativeIdentity(detectNativeProfile({ "x-claude-code-session-id": "cc-sess-1" }, "", "anthropic"), { "x-claude-code-session-id": "cc-sess-1" }, "/v1/messages", "anthropic", CC_BODY_MISMATCH, undefined), 11000);
    assert.ok(mm.events.some((e) => e.k === "dual_mismatch"));
    const mmBlob = JSON.stringify(mm);
    assert.ok(!mmBlob.includes("cc-sess-OTHER"));
    assert.ok(!mmBlob.includes("cc-sess-1"));
    assert.ok(mm.events.some((e) => e.k === "dual_mismatch" && /^hdr=[0-9a-f]{8} body=[0-9a-f]{8}$/.test(e.e)));
});

test("event FIFO cap 32 + ≤4KB hard budget survive heavy churn", () => {
    const mk = (n: number, ev: string): ReturnType<typeof mergeNidvState> => {
        let st: ReturnType<typeof mergeNidvState> | null = null;
        for (let i = 0; i < n; i++) {
            st = mergeNidvState(st, { profileId: "codex", compactionSignal: "prefix-match", compactionEvidence: ev + "-" + i, sessVal: "s-" + i }, i);
        }
        return st!;
    };
    const st = mk(200, "another-language-model-started-to-solve-this-problem-and-produced-a-summar");
    assert.ok(st!.events.length <= 32);
    assert.ok(JSON.stringify(st!).length <= 4096);
    // evidence capped at 64 chars
    assert.ok(st!.events.every((e) => e.e.length <= 64));
});

test("observeNativeIdentity: off ⇒ zero store traffic + zero logs", () => {
    const d = duckStore();
    const { log, lines } = spyLog();
    observeNativeIdentity({ sessionId: "s1", headers: WB_HDRS, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: false, store: toView(d) });
    assert.equal(d.reads, 0);
    assert.equal(d.writes, 0);
    assert.equal(lines.length, 0);
});

test("observeNativeIdentity: on ⇒ digest write, privacy-held logs, fail-open on corrupt prev", () => {
    const d = duckStore();
    const { log, lines } = spyLog();
    observeNativeIdentity({ sessionId: "s1", headers: WB_HDRS, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: true, store: toView(d) });
    assert.equal(d.writes, 1);
    const blob = d.ext.get(`s1\x00${NIDV_EXT_KEY}`)!;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    assert.equal(parsed.v, 1);
    assert.equal(parsed.client, "wb");
    assert.ok(!blob.includes("conv-abc")); // raw id must not be persisted
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, "debug");
    assert.ok(!lines[0].msg.includes("conv-abc")); // and not logged either
    // corrupt prev blob → rebuild fresh, no throw
    d.ext.set(`s1\x00${NIDV_EXT_KEY}`, "{corrupt!");
    observeNativeIdentity({ sessionId: "s1", headers: WB_HDRS, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: true, store: toView(d) });
    assert.equal(JSON.parse(d.ext.get(`s1\x00${NIDV_EXT_KEY}`)!).reqs, 1);
    // replicas unavailable → graceful inertness
    const down = duckStore(false);
    observeNativeIdentity({ sessionId: "s1", headers: WB_HDRS, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: true, store: toView(down) });
    assert.equal(down.reads + down.writes, 0);
    // unknown client with storage available → NOTHING written (privacy redline)
    const unk = duckStore();
    observeNativeIdentity({ sessionId: "s2", headers: { "x-whatever": "1" }, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: true, store: toView(unk) });
    assert.equal(unk.ext.size, 0);
    // empty sessionId → inert
    const es = duckStore();
    observeNativeIdentity({ sessionId: "", headers: WB_HDRS, urlPath: "/v1/chat/completions", protocol: "openai", log, enabled: true, store: toView(es) });
    assert.equal(es.writes, 0);
    // compaction escalates the log line to warn
    const cw = duckStore();
    const clog = spyLog();
    observeNativeIdentity({ sessionId: "s3", headers: { ...WB_HDRS, "x-compacted": "1" }, urlPath: "/v1/chat/completions", protocol: "openai", log: clog.log, enabled: true, store: toView(cw) });
    assert.equal(clog.lines[0].level, "warn");
    assert.match(clog.lines[0].msg, /compaction/);
});
