// #4649: the conflict-report blob recognized ONLY dsh clients — a codex
// conflict report (#4648) shipped with zero matching log lines and no client
// version, forcing manual round-trips. These tests pin BOTH directions of the
// fix: (a) CONFLICT_LOG_PATTERNS now covers the codex lane's actual log sites
// (positive: every site matched; negative: unrelated lines still excluded,
// dsh coverage unregressed); (b) the bounded observed-UA registry feeds the
// "host client versions" section so non-dsh reports carry their own client
// version (dedupe, caps, truncation, family resolution, publish discipline).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { clientFamilyOf, recentClientUas, recordClientUa, _resetClientUaRegistryForTest } from "../src/client-ua-registry.js";

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

function makeRoot(tag: string): string {
    const root = mkdtempSync(path.join(os.tmpdir(), tag));
    mkdirSync(path.join(root, "state", "billion-context"), { recursive: true });
    return root;
}

// The five codex-lane evidence lines, byte shapes taken from the actual log
// sites (src/server/handle.ts not-intercepted forward; src/server/
// prepare-responses.ts local-auto-compact detection/rebase, both intercepted
// forge forms, and the forge failure).
const CODEX_LOG_LINES = [
    "[ses_codex1] codex compaction_trigger request not intercepted (BILI_CODEX_COMPACT=pass) — forwarding verbatim (no preflight, no rebuild, no window clamp)",
    "[ses_codex1] codex local auto-compaction detected (320/771 covered ids retained) — rebasing ACP state onto the compacted history (#2372)",
    "[ses_codex1] codex compact intercepted (trigger form); forged SSE with 3 block summary(s), upstream not contacted",
    "[ses_codex1] codex compact intercepted (endpoint); forged history with 12 item(s), upstream not contacted",
    "[ses_codex1] codex compact forge failed (transform blew up); passing through to upstream",
];
// Lines that MUST stay out of the conflict tail: unrelated traffic plus a
// codex-adjacent line that is budget alignment, not a compaction episode.
const NON_CONFLICT_LINES = [
    "[acp-usage] round 7 input=120000 cached=110000 (cache hit 91%)",
    "[storage] index.db healthy (sqlite unified)",
    "[codex] effective window clamped 200000 → 192000 (client-window alignment for model=gpt-x; current client metadata preferred over bundled fallback) upstream=none route=default",
    "processTurn: 42 msgs, protocol openai",
];
// Pre-existing dsh coverage must survive the extension verbatim.
const DSH_LOG_LINE = "[ses_dsh1] dsh native compaction call identified (final user message = COMPACTION_INSTRUCTION, 42 msgs) — REFUSED, not forwarded (#1729)";

test("#4649 codex conflict signatures are captured; unrelated and dsh behavior unchanged", (t) => {
    const root = makeRoot("bili-diag-4649-log-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    _resetClientUaRegistryForTest();
    writeFileSync(path.join(root, "state", "billion-context", "bili.log"),
        [...CODEX_LOG_LINES, DSH_LOG_LINE, ...NON_CONFLICT_LINES].join("\n") + "\n");
    const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
        () => buildDiagnostics("conflict-banner")).blob;

    assert.ok(blob.includes("--- recent conflict-related log lines ---"), "log section present");
    assert.ok(blob.includes("codex compaction_trigger request not intercepted"), "not-intercepted forward captured (handle.ts site)");
    assert.ok(blob.includes("codex local auto-compaction detected"), "inline auto-compact detection + rebase captured (#3008/#2372)");
    assert.ok(blob.includes("codex compact intercepted (trigger form)"), "intercepted forge, trigger form captured");
    assert.ok(blob.includes("codex compact intercepted (endpoint)"), "intercepted forge, endpoint form captured");
    assert.ok(blob.includes("codex compact forge failed"), "forge failure passthrough captured");
    assert.ok(blob.includes(DSH_LOG_LINE), "pre-existing dsh coverage unregressed");
    for (const l of NON_CONFLICT_LINES) {
        assert.ok(!blob.includes(l), `unrelated line must stay out of the tail:\n${l}`);
    }
});

test("#4649 observed UA registry feeds the host client versions section", (t) => {
    const root = makeRoot("bili-diag-4649-ua-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    _resetClientUaRegistryForTest();
    recordClientUa({ "user-agent": "codex_cli_rs/0.162.1" });
    recordClientUa({ "x-claude-code-session-id": "abc", "user-agent": "claude-cli/1.0.55 (external, cli)" });
    recordClientUa({ "user-agent": "curl/8.5.0" });
    // #4648 scenario: NO dsh profiles on this machine — the observed UAs must
    // still be published (the old early-return dropped the whole section body).
    const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
        () => buildDiagnostics("conflict-banner")).blob;
    const section = blob.slice(blob.indexOf("--- host client versions ---"));
    assert.ok(section.includes("observed client user-agents: codex: codex_cli_rs/0.162.1"), `codex UA published despite missing dsh profiles:\n${section}`);
    assert.ok(section.includes("observed client user-agents: claude: claude-cli/1.0.55 (external, cli)"), "claude UA published");
    assert.ok(section.includes("observed client user-agents: other: curl/8.5.0"), "unidentified client lands in the other bucket");
    // the UA lines sit INSIDE the host client versions section (before config)
    assert.ok(section.indexOf("observed client user-agents:") < section.indexOf("--- bili config"), "UA lines precede the config section");
});

test("#4649 registry: dedupe, per-family cap, truncation, honest empty note", (t) => {
    t.after(() => _resetClientUaRegistryForTest());
    _resetClientUaRegistryForTest();
    // empty registry → honest note, not an empty section
    assert.deepEqual(recentClientUas(), [], "fresh registry is empty");
    // dedupe: same exact UA twice → one observation
    recordClientUa({ "user-agent": "codex_cli_rs/1.0.0" });
    recordClientUa({ "user-agent": "codex_cli_rs/1.0.0" });
    assert.equal(recentClientUas().length, 1, "identical UA dedupes");
    // per-family cap: 10 distinct codex UAs → 8 kept, the two oldest evicted
    for (let i = 1; i <= 10; i++) recordClientUa({ "user-agent": `codex_cli_rs/1.0.${i}` });
    const codexObs = recentClientUas().filter((o) => o.family === "codex");
    assert.equal(codexObs.length, 8, "family capped at 8 UAs");
    assert.ok(codexObs.some((o) => o.ua === "codex_cli_rs/1.0.10"), "newest UA survives");
    assert.ok(!codexObs.some((o) => o.ua === "codex_cli_rs/1.0.1"), "oldest UA evicted");
    assert.ok(!codexObs.some((o) => o.ua === "codex_cli_rs/1.0.2"), "second-oldest UA evicted");
    // truncation: hostile long UA cannot bloat the blob
    recordClientUa({ "user-agent": "codex_cli_rs/2.0.0 " + "x".repeat(300) });
    const longObs = recentClientUas().find((o) => o.family === "codex" && o.ua.startsWith("codex_cli_rs/2.0.0"));
    assert.ok(longObs, "long UA recorded");
    assert.ok(longObs!.ua.length <= 120, `UA truncated to the ingest bound, got ${longObs!.ua.length}`);
});

test("#4649 registry: display cap keeps the blob pasteable", (t) => {
    t.after(() => _resetClientUaRegistryForTest());
    _resetClientUaRegistryForTest();
    // 3 families × 8 UAs = 24 observations > the 12-line display budget
    for (const fam of ["codex", "claude", "other"]) {
        for (let i = 1; i <= 8; i++) {
            const headers: Record<string, string> = { "user-agent": `${fam}_ua/${i}` };
            if (fam === "claude") headers["x-claude-code-session-id"] = "s";
            recordClientUa(headers);
        }
    }
    assert.equal(recentClientUas().length, 24, "registry holds all observations");
    const root = makeRoot("bili-diag-4649-cap-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
        () => buildDiagnostics()).blob;
    const uaLineCount = blob.split("\n").filter((l) => l.startsWith("observed client user-agents: ") && !l.includes("more observation")).length;
    assert.equal(uaLineCount, 12, "display capped at 12 lines");
    assert.ok(blob.includes("more observation(s)"), "overflow noted honestly");
});

test("#4649 registry: family resolution mirrors the conflict ladder", () => {
    assert.equal(clientFamilyOf({ "user-agent": "codex_cli_rs/0.162.1" }), "codex", "registered codex prefix");
    assert.equal(clientFamilyOf({ "user-agent": "Codex Desktop/9.9.9" }), "codex", "capitalized variant prefix");
    assert.equal(clientFamilyOf({ "user-agent": "vendor/tool codex_foo/1.0" }), "codex", "token-level lenient fallback (#645)");
    assert.equal(clientFamilyOf({ "user-agent": "vendor/codex-wrapper" }), "other", "mid-token codex mention is NOT codex (#1641)");
    assert.equal(clientFamilyOf({ "x-claude-code-session-id": "s", "user-agent": "anything/1" }), "claude", "header sniff beats UA guess");
    assert.equal(clientFamilyOf({ "x-opencode-session": "ses_1", "user-agent": "anything/1" }), "opencode", "opencode header sniff");
    assert.equal(clientFamilyOf({ "x-bili-plugin": "dsh", "user-agent": "codex_cli_rs/1.0" }), "dsh", "declared plugin agent wins over UA shape");
    assert.equal(clientFamilyOf({ "x-bili-plugin": "mcp", "user-agent": "curl/8" }), "other", "mcp is not a client name (#760b)");
    assert.equal(clientFamilyOf({}), "other", "no signal → other");
});

test("#4649 registry: family cap bounds hostile churn", (t) => {
    t.after(() => _resetClientUaRegistryForTest());
    _resetClientUaRegistryForTest();
    // 30 distinct declared plugin agents × 1 UA each → families evict past 24
    for (let i = 1; i <= 30; i++) recordClientUa({ "x-bili-plugin": `agent-${i}`, "user-agent": `agent-${i}/1.0` });
    const obs = recentClientUas();
    const families = new Set(obs.map((o) => o.family));
    assert.ok(families.size <= 24, `family cap enforced, got ${families.size}`);
    assert.ok(obs.some((o) => o.family === "agent-30"), "most recently seen family survives");
});

test("#4649 publish discipline: credential-shaped UA bytes never reach the blob", (t) => {
    const root = makeRoot("bili-diag-4649-pub-");
    t.after(() => { rmSync(root, { recursive: true, force: true }); _resetClientUaRegistryForTest(); });
    _resetClientUaRegistryForTest();
    recordClientUa({ "user-agent": "codex_cli_rs/1.0.0 sk-live-abcdefgh123456789" });
    const blob = withEnv({ DSH_HOME: path.join(root, "none"), XDG_STATE_HOME: path.join(root, "state"), XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root },
        () => buildDiagnostics()).blob;
    assert.ok(!blob.includes("sk-live-abcdefgh123456789"), "credential shape scrubbed by the sink net (#4427)");
    assert.ok(blob.includes("observed client user-agents: codex: codex_cli_rs/1.0.0"), "the UA itself still publishes");
});
