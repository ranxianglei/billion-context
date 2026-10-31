// #3611: the auto-filed diagnostics blob must be diagnosable on its own — the
// first field reports carried neither client version, nor config, nor log
// evidence, so triage stalled waiting for data the reporter had to dig out by
// hand. These tests pin the enriched sections AND the publish discipline: the
// blob lands in a PUBLIC GitHub issue body, so secrets must be masked and no
// absolute path (username leak) may survive into it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { buildDiagnostics, _candidateLogReadsForTest, _resetCandidateLogReadsForTest } from "../src/web/diagnostics.js";
import { isMaskHostsEnabled, setMaskHostsEnabled } from "../src/log-mask.js";
import { getSession, _resetSessionsForTest } from "../src/session.js";

const ENV_KEYS = ["BILI_CONFIG_FILE", "DSH_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

/** Pin every path-relevant env var (unset ones deleted, so homedir fallbacks
 * can never reach the real machine's dirs); restored in finally. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        if (overrides[k] !== undefined) process.env[k] = overrides[k];
        else delete process.env[k];
    }
    try { return fn(); } finally {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

function writeJson(p: string, doc: unknown): void {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(doc));
}

function makeFixture(): { root: string; dshHome: string; stateHome: string; configPath: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-"));
    const dshHome = path.join(root, "dsh");
    const stateHome = path.join(root, "state");
    const configPath = path.join(root, "billion-context.json");
    const alphaDeps = path.join(dshHome, "profiles", "alpha", "node_modules", "@deepseek-ai");
    const desktopDeps = path.join(dshHome, "profiles", "desktop", "node_modules", "@deepseek-ai");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    writeJson(path.join(alphaDeps, "dsh", "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.17" });
    writeJson(path.join(alphaDeps, "dsh-compaction-basic", "package.json"), { name: "@deepseek-ai/dsh-compaction-basic", version: "0.2.9" });
    writeJson(path.join(desktopDeps, "dsh", "package.json"), { name: "@deepseek-ai/dsh", version: "0.9.17" });
    // web-app deliberately absent from alpha → must render "?"
    writeJson(configPath, {
        providers: { "https://api.example.com/v1": { apiKey: "sk-supersecret123456", contextWindow: 200000, upstream: "https://relay-admin:MyPassw0rd123@internal.example.com/v1" } },
        compress: { nudgeGrowthTokens: 50000 },
        dsh: { allowDshCompaction: false },
        myToken: "tok_abcdef123456",
        apiKeys: ["generic-secret-value-123456"],
        notes: "prose mentioning tokens and keys stays verbatim",
    });
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), [
        "[acp-usage] round 1 input=100 cached=0 (cache hit 0%)",
        "[ses_abc123] dsh native compaction call identified (final user message = COMPACTION_INSTRUCTION, 42 msgs) — REFUSED, not forwarded (#1729)",
        "bili-native-dsh: model request sent DIRECT (uncompressed) — takeover gate refused /chat/completions: no active initiator attribution",
        "[ses_abc123][fold-reconcile] compression substrate appears destroyed: 120 covered id(s) missing with NO anchor match for 3 consecutive passes",
        "[ses_def456] native compaction boundary: archived 3 pre-compaction block(s); pruned ref maps to 68 live raw id(s)",
        "upstream 401 body: authorization: bearer sk-live-abcdefgh123456789 rejected — dsh native compaction call identified on retry",
        // #3811: a matched conflict line whose URL carries a private relay host —
        // must be host-masked in the published tail even though it is a log copy.
        "[ses_ghi789] dsh native compaction call identified: checkpoint framing read from https://tail-relay.internal/v1/model failed",
    ].join("\n") + "\n");
    return { root, dshHome, stateHome, configPath };
}

test("#3611 conflict-banner report carries versions, masked config, and evidence-log tail", (t) => {
    const fx = makeFixture();
    t.after(() => rmSync(fx.root, { recursive: true, force: true }));
    const rep = withEnv({ DSH_HOME: fx.dshHome, XDG_STATE_HOME: fx.stateHome, XDG_CONFIG_HOME: fx.root, XDG_DATA_HOME: fx.root, XDG_CACHE_HOME: fx.root, BILI_CONFIG_FILE: fx.configPath },
        () => buildDiagnostics("conflict-banner"));
    const blob = rep.blob;

    assert.ok(blob.includes("--- host client versions ---"), "versions section present");
    assert.ok(blob.includes("dsh profile alpha: dsh 0.9.17, dsh-compaction-basic 0.2.9, dsh-web-app ?"),
        `per-profile package versions incl. absent-as-?, got:\n${blob}`);
    assert.ok(blob.includes("dsh profile desktop: dsh 0.9.17, dsh-compaction-basic ?, dsh-web-app ?"), "second profile listed");

    assert.ok(blob.includes("--- bili config (secrets masked) ---"), "config section present");
    assert.ok(blob.includes('"apiKey":"***"'), "secret value replaced by ***");
    assert.ok(blob.includes('"myToken":"***"'), "top-level secret key replaced");
    assert.ok(!blob.includes("sk-supersecret123456"), "raw api key must not survive");
    assert.ok(!blob.includes("tok_abcdef123456"), "raw token must not survive");
    assert.ok(!blob.includes("MyPassw0rd123"), "URL userinfo password must not survive");
    // #3811: a bare endpoint HOST (no secret-named key) must be masked too — the
    // original hole leaked internal.example.com verbatim into the public blob.
    assert.ok(!blob.includes("internal.example.com"), "private relay host in a config URL value must be masked (#3811)");
    assert.ok(!blob.includes("api.example.com"), "provider-table URL used as an object KEY must also be host-masked (#3811)");
    assert.ok(blob.includes("<private-host>"), "masked-host placeholder present in the config section (#3811)");
    assert.ok(blob.includes('"apiKeys":["***"]'), "array under a secret-named key is masked element-wise");
    assert.ok(blob.includes('"nudgeGrowthTokens":50000'), "non-secret values stay verbatim");
    assert.ok(blob.includes('"allowDshCompaction":false'), "dsh block visible");
    assert.ok(blob.includes("prose mentioning tokens and keys stays verbatim"), "masking is key-based, not word-based");

    assert.ok(blob.includes("--- recent conflict-related log lines ---"), "log section present");
    assert.ok(blob.includes("takeover gate refused"), "direct-bypass refusal captured");
    assert.ok(blob.includes("compression substrate appears destroyed"), "destruction verdict captured");
    assert.ok(blob.includes("native compaction boundary"), "rebase success captured");
    assert.ok(!blob.includes("(no matching lines in the current log pair)"), "non-empty tail does not print the empty note");
    assert.ok(!blob.includes("[acp-usage] round 1"), "unrelated log lines excluded");
    assert.ok(!blob.includes("sk-live-abcdefgh123456789"), "credential in a matched log line is redacted");
    assert.ok(blob.includes("<masked"), "redaction marker visible");
    // #3811: a URL host inside a matched conflict-log line must be masked too —
    // the tail copies on-disk lines, which under BILI_LOG_MASK_HOSTS=0 keep real hosts.
    assert.ok(!blob.includes("tail-relay.internal"), "private relay host in a conflict log line must be masked (#3811)");

    // publish discipline: no absolute path of the fixture tree may leak.
    assert.ok(!blob.includes(fx.root), "no absolute fixture path in blob");
    // enrichment appends AFTER the topic section (existing blob prefix stable).
    assert.ok(blob.indexOf("--- compression conflict ledger ---") < blob.indexOf("--- host client versions ---"), "topic section precedes enrichment");
    // URL round-trip: the prefilled body decodes back to the exact blob.
    const u = new URL(rep.url);
    assert.equal(u.origin + u.pathname, "https://github.com/ranxianglei/billion-context/issues/new");
    assert.equal(decodeURIComponent(u.searchParams.get("body") ?? ""), blob);
});

test("#3811 config host masking is unconditional — publish boundary ignores BILI_LOG_MASK_HOSTS", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-hostmask-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, "billion-context.json");
    writeJson(configPath, {
        providers: { "https://open.bigmodel.cn": { upstream: "https://relay.internal.corp/v1" } },
        proxy: "https://proxy-corp.example.org:8443",
    });
    // An operator who opts out of LOCAL log host-masking must still get a
    // host-safe PUBLISHED blob — the local preference must not weaken it.
    const prev = isMaskHostsEnabled();
    try {
        setMaskHostsEnabled(false);
        const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, BILI_CONFIG_FILE: configPath },
            () => buildDiagnostics()).blob;
        assert.ok(!blob.includes("open.bigmodel.cn"), "provider-table KEY host masked even with local host-masking OFF");
        assert.ok(!blob.includes("relay.internal.corp"), "upstream VALUE host masked even with local host-masking OFF");
        assert.ok(!blob.includes("proxy-corp.example.org"), "proxy host masked even with local host-masking OFF");
        assert.ok(blob.includes("<private-host>"), "masked-host placeholder present under switch-OFF");
    } finally {
        setMaskHostsEnabled(prev);
    }
});

test("#3611 no dsh profiles → explicit note instead of an empty section", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-empty-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dshHome = path.join(root, "dsh");
    mkdirSync(dshHome, { recursive: true });
    const blob = withEnv({ DSH_HOME: dshHome, XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
        () => buildDiagnostics("conflict-banner")).blob;
    assert.ok(blob.includes("no profiles under DSH_HOME"), `expected explicit no-profiles note:\n${blob}`);
    assert.ok(blob.includes("(no config file)"), "missing config file stated honestly");
});

test("#3611 oversized config is capped with a truncation note", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-big-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, "billion-context.json");
    writeFileSync(configPath, JSON.stringify({ compress: { prompt: "x".repeat(4000) } }));
    const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, BILI_CONFIG_FILE: configPath },
        () => buildDiagnostics()).blob;
    assert.ok(blob.includes("… (truncated,"), "truncation note present");
    const cfgSection = blob.slice(blob.indexOf("--- bili config (secrets masked) ---"));
    assert.ok(cfgSection.length < 2200, `config section bounded, got ${cfgSection.length} chars`);
});

// #3813: buildDiagnostics used to read the rotated log pair ONCE PER TAIL, so a
// conflict-banner request (which sets both the storage tail and the conflict
// tail) did two full synchronous reads. The fix pre-fetches the candidate lines
// once and hands the SAME array to both tails — output must stay identical while
// each tail still selects ONLY its own pattern (no cross-leak between the two).
test("#3813 single-read: storage tail and conflict tail share one candidate set without cross-leak", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-oneread-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    const storageMarker = "[storage] index.db healthy (sqlite unified)";
    const conflictMarker = "[ses_x] compression substrate appears destroyed: 5 covered id(s) missing";
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), `${storageMarker}\n${conflictMarker}\n`);
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    _resetCandidateLogReadsForTest();
    const conflictBlob = withEnv(env, () => buildDiagnostics("conflict-banner")).blob;
    assert.equal(_candidateLogReadsForTest(), 1, "conflict-banner reads the rotated pair exactly once (pre-fix: twice)");
    const storageBlob = withEnv(env, () => buildDiagnostics("storage-legacy-only")).blob;
    assert.equal(_candidateLogReadsForTest(), 2, "each report costs exactly one full-pair read");
    assert.ok(conflictBlob.includes(conflictMarker), "conflict tail captures its signature line from the shared read");
    assert.ok(!conflictBlob.includes(storageMarker), "conflict tail must not leak [storage] lines");
    assert.ok(storageBlob.includes(storageMarker), "storage tail captures its [storage] line from the shared read");
    assert.ok(!storageBlob.includes("compression substrate appears destroyed"), "storage tail must not leak conflict signatures");
    withEnv(env, () => buildDiagnostics("totally-unknown-topic"));
    assert.equal(_candidateLogReadsForTest(), 2, "unknown topics must not touch the log at all");
});

// #4649: the #3611 enrichment was dsh-only — a codex conflict report shipped
// zero log signatures and no client version (#4648), stalling triage on data
// the reporter had to dig out by hand. Pin both directions: the codex
// compaction signatures match the conflict tail (and unrelated lines still do
// not), and the live pool's distinct clientHints surface as version evidence —
// including on machines with NO dsh profile, where the old early-return hid
// the whole section tail.
test("#4649 codex lane: conflict tail matches codex signatures; client hints carry versions", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-codex-"));
    _resetSessionsForTest();
    t.after(() => { rmSync(root, { recursive: true, force: true }); _resetSessionsForTest(); });
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), [
        "[ses_codex_1] codex compaction_trigger request not intercepted (no active fold blocks) — forwarding verbatim (no preflight, no rebuild, no window clamp)",
        "[ses_codex_2] codex compact intercepted (inline-prompt form); forged SSE with 3 block summary(s), upstream not contacted",
        "[ses_codex_3] codex compact forge failed (window violation); passing through to upstream",
        "[acp-usage] round 9 input=90000 cached=80000 (cache hit 88%)",
    ].join("\n") + "\n");
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    const blob = withEnv(env, () => buildDiagnostics("conflict-banner")).blob;
    assert.ok(blob.includes("codex compaction_trigger request not intercepted"), "passthrough decision captured");
    assert.ok(blob.includes("codex compact intercepted"), "intercept success captured");
    assert.ok(blob.includes("codex compact forge failed"), "forge failure captured");
    assert.ok(!blob.includes("[acp-usage] round 9"), "unrelated log lines still excluded");
    // No sessions yet: the hint line must be absent, not empty-noise.
    assert.ok(!blob.includes("observed client hints"), "no hint line without live sessions");

    const a = getSession("ses_codex_1");
    a.metadata.clientHint = "codex_cli_rs/0.163.0";
    const b = getSession("ses_codex_2");
    b.metadata.clientHint = "codex_cli_rs/0.163.0";
    const c = getSession("ses_oc_1");
    c.metadata.clientHint = "opencode";
    const blob2 = withEnv(env, () => buildDiagnostics("conflict-banner")).blob;
    // 3 sessions, 2 DISTINCT hints (the duplicate UA collapses):
    assert.ok(blob2.includes("observed client hints (2 distinct, live sessions):"), `hint line present with distinct count:\n${blob2}`);
    // entry order follows lastSeen (same-millisecond ties are insertion-ordered),
    // so match on membership, not position:
    const hintLine = blob2.split("\n").find((l) => l.startsWith("observed client hints")) ?? "";
    assert.ok(hintLine.includes("codex_cli_rs/0.163.0") && hintLine.includes("opencode"),
        `both distinct hints on one line, got: ${hintLine}`);
    assert.equal(hintLine.split("codex_cli_rs/0.163.0").length - 1, 1, "duplicate UA hint deduped to one entry");
});

test("#4649 no dsh profiles: observed client hints still surface (old early-return hid them)", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-codex-noprof-"));
    _resetSessionsForTest();
    t.after(() => { rmSync(root, { recursive: true, force: true }); _resetSessionsForTest(); });
    mkdirSync(path.join(root, "dsh"), { recursive: true });
    const s = getSession("ses_codex_only");
    s.metadata.clientHint = "Codex Desktop/1.2.3";
    const env = { DSH_HOME: path.join(root, "dsh"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    const blob = withEnv(env, () => buildDiagnostics()).blob;
    assert.ok(blob.includes("no profiles under DSH_HOME"), "no-profiles note kept");
    assert.ok(blob.includes("observed client hints (1 distinct, live sessions): Codex Desktop/1.2.3"),
        `hint line present despite missing profiles:\n${blob}`);
});

// #4688: a PURE orphan-reap ledger (no plugin events, no dsh/codex framing)
// shipped with an empty evidence section because neither reap verdict nor the
// OpenAI-lane codex detection was in CONFLICT_LOG_PATTERNS — the report's own
// log tail was blind to the very event it was reporting. Pin both signatures
// (and the unrelated-line exclusion) so orphan-reap reports carry their proof.
test("#4688 orphan-reap report carries the reap verdict and the OpenAI-lane codex detection", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-reap-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateHome = path.join(root, "state");
    mkdirSync(path.join(stateHome, "billion-context"), { recursive: true });
    const reapLine = "[ses_734d5481] zombie fold reap: removed 2 block(s) (b1, b2) from ACP state; blockContents retained, refs pruned to live ids (#2695)";
    const codexOpenaiLine = "[ses_codex_9] codex local auto-compaction detected (3/120 covered ids retained) — rebasing ACP state onto the compacted history (#2372/#4521)";
    writeFileSync(path.join(stateHome, "billion-context", "bili.log"), [
        "[acp-usage] round 4 input=120000 cached=100000 (cache hit 83%)",
        reapLine,
        codexOpenaiLine,
    ].join("\n") + "\n");
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    const blob = withEnv(env, () => buildDiagnostics("conflict-banner")).blob;
    assert.ok(blob.includes("zombie fold reap"), "orphan-reap verdict captured (pre-fix: empty evidence section)");
    assert.ok(blob.includes("blockContents retained"), "reap line kept whole enough to show contents survived");
    assert.ok(blob.includes("codex local auto-compaction detected"), "OpenAI-lane codex detection captured");
    assert.ok(!blob.includes("[acp-usage] round 4"), "unrelated log lines still excluded");
});

test("#3611 enrichment is generic: storage topic and unknown topics carry it too", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bili-diag-gen-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = { DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root };
    const storage = withEnv(env, () => buildDiagnostics("storage-legacy-only")).blob;
    assert.ok(storage.includes("--- host client versions ---"), "storage topic gets versions");
    assert.ok(storage.includes("--- bili config (secrets masked) ---"), "storage topic gets config");
    assert.ok(!storage.includes("--- recent conflict-related log lines ---"), "conflict log tail is conflict-topic only");
    const unknown = withEnv(env, () => buildDiagnostics("totally-unknown-topic")).blob;
    assert.ok(unknown.includes("topic: totally-unknown-topic (no topic-specific section registered)"), "unknown topic degrades gracefully");
    assert.ok(unknown.includes("--- host client versions ---"), "unknown topic still enriched");
});
