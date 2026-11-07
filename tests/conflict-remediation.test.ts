// #2219: per-client remediation hints on the compression-conflict surfaces.
// The detector told users WHAT happened; answering HOW required digging out four
// separate doc locations. These tests pin the client-identity resolution, the
// one-line hint map, the acp_status section suffix, the summary clients[] field,
// i18n parity between the server map and the web keys, and the web wiring.
import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    CONFLICT_DOCS_POINTER,
    conflictClientOf,
    conflictRemediation,
    formatConflictSection,
    summarizeConflicts,
    type ConflictEvent,
} from "../src/conflict-watch.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { MESSAGES } from "../src/web/i18n.ts";
import { WEB_CLIENT } from "../src/web/client.ts";

_setStoreForTest(new SessionStore({ enabled: false }));

const DAY = 24 * 60 * 60 * 1000;

function makeSession(id: string, metadata: Record<string, unknown> = {}): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("conflictClientOf: pluginAgent wins; mcp is not a client name and falls through (#2219)", () => {
    assert.equal(conflictClientOf(makeSession("a", { pluginAgent: "opencode", clientHint: "claude" })), "opencode");
    assert.equal(conflictClientOf(makeSession("b", { pluginAgent: "mcp", clientHint: "claude" })), "claude");
    assert.equal(conflictClientOf(makeSession("c", { pluginAgent: "mcp" })), undefined);
    assert.equal(conflictClientOf(makeSession("d")), undefined);
});

test("conflictClientOf: codex UA truncations normalize to codex, look-alikes do not (#2219)", () => {
    assert.equal(conflictClientOf(makeSession("a", { clientHint: "codex_cli_rs/0.54.0 (x86_64)" })), "codex");
    assert.equal(conflictClientOf(makeSession("b", { clientHint: "Codex Desktop/1.2.3" })), "codex");
    // token-level detection (#1641): a UA that merely mentions codex mid-token is NOT codex
    assert.equal(conflictClientOf(makeSession("c", { clientHint: "vendor/codex-wrapper/1.0" })), undefined);
    assert.equal(conflictClientOf(makeSession("d", { clientHint: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })), undefined);
    // clean single tokens pass through as-is — unknown clients simply get the generic hint
    assert.equal(conflictClientOf(makeSession("e", { clientHint: "gemini-cli" })), "gemini-cli");
    assert.equal(conflictClientOf(makeSession("f", { clientHint: "claude" })), "claude");
});

test("conflictClientOf: antigravity UA shapes normalize to antigravity, look-alikes do not (#4688)", () => {
    assert.equal(conflictClientOf(makeSession("a", { clientHint: "antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)" })), "antigravity");
    assert.equal(conflictClientOf(makeSession("b", { clientHint: "Antigravity/hub/9.9.9" })), "antigravity");
    // prefix-anchored only — a mention elsewhere in the UA is not this lane
    assert.equal(conflictClientOf(makeSession("c", { clientHint: "vendor/antigravity-wrapper/1.0" })), undefined);
    assert.equal(conflictClientOf(makeSession("d", { clientHint: "Mozilla/5.0 antigravity-fan-club" })), undefined);
});

test("conflictRemediation: one line per known client, generic fallback for the rest (#2219)", () => {
    const oc = conflictRemediation("opencode");
    assert.ok(oc.includes('"compaction": { "auto": false }'), oc);
    assert.ok(oc.includes("bili opencode"), oc);
    const cl = conflictRemediation("claude");
    assert.ok(cl.includes("CLAUDE_CODE_AUTO_COMPACT_WINDOW"), cl);
    assert.ok(cl.includes("bili claude"), cl);
    const cx = conflictRemediation("codex");
    assert.ok(cx.includes("BILI_CODEX_COMPACT=intercept"), cx);
    assert.ok(cx.includes("#3008"), cx);
    assert.ok(!cx.includes("never transits"), "#3008: the inline auto-compact DOES transit as an ordinary turn — the old copy was false");
    assert.equal(conflictRemediation("pi"), conflictRemediation("omp"), "pi and omp share the carriage-evidence hint");
    assert.ok(conflictRemediation("pi").includes("report client + bili version"));
    const ag = conflictRemediation("antigravity");
    assert.ok(ag.includes("not double compression"), ag);
    assert.ok(ag.includes("export --full"), ag);
    const gen = conflictRemediation(undefined);
    assert.ok(gen.includes("fresh session"), gen);
    for (const c of ["dsh", "kimi", "hermes", "zcode", "gemini-cli"]) {
        assert.equal(conflictRemediation(c), gen, `${c} falls back to the generic hint`);
    }
    for (const c of ["opencode", "claude", "codex", "pi", "omp", "antigravity", undefined]) {
        assert.ok(!conflictRemediation(c).includes("\n"), "hints render inline — one line only");
    }
});

test("formatConflictSection: appends per-client Fix line + docs pointer, active and historical alike (#2219)", () => {
    // the real board case from #917/#2219: repeated unannounced-rewrite warnings
    const events: ConflictEvent[] = [
        { at: Date.now() - 60000, kind: "unannounced-rewrite", detail: "2/55 incoming message(s) carry pre-turn refs of 217 known" },
    ];
    const withClient = formatConflictSection(events, Date.now(), "opencode").join("\n");
    assert.ok(withClient.includes('Fix (opencode): set "compaction": { "auto": false }'), withClient);
    assert.ok(withClient.endsWith(CONFLICT_DOCS_POINTER), withClient);

    const noClient = formatConflictSection(events).join("\n");
    assert.ok(noClient.includes("Fix: disable the client's own auto-compaction"), noClient);
    assert.ok(noClient.endsWith(CONFLICT_DOCS_POINTER), noClient);

    const stock: ConflictEvent[] = [{ at: Date.now() - 30 * DAY, kind: "unannounced-rewrite", detail: "old stock" }];
    const oldText = formatConflictSection(stock, Date.now(), "claude").join("\n");
    assert.ok(oldText.includes("older than 7 days"), oldText);
    assert.ok(oldText.includes("Fix (claude):"), "historical stock still gets the how-to-remove steps");
});

test("summarizeConflicts: distinct resolved clients of sessions carrying events, first-seen order (#2219)", () => {
    const now = Date.now();
    const a = makeSession("a", { pluginAgent: "opencode" });
    a.metadata.conflictEvents = [{ at: now - 60000, kind: "third-party-plugin", detail: "pi: npm:x (settings.json)" }];
    const b = makeSession("b", { clientHint: "claude" });
    b.metadata.conflictEvents = [{ at: now - 120000, kind: "unannounced-rewrite", detail: "rewrite" }];
    const c = makeSession("c", { clientHint: "codex_cli_rs/0.54.0" });
    c.metadata.conflictEvents = [{ at: now - 180000, kind: "native-compaction", detail: "compaction_trigger item" }];
    const d = makeSession("d");
    d.metadata.conflictEvents = [{ at: now - 240000, kind: "orphan-reap", detail: "reaped" }];
    const e = makeSession("e", { pluginAgent: "omp" }); // no events — must not contribute
    const s = summarizeConflicts([a, b, c, d, e], now);
    assert.deepEqual(s.clients, ["opencode", "claude", "codex"]);
    assert.equal(s.sessions, 4);
});

test("i18n: every conflict.hint.* key exists in BOTH locales; server map and web keys cover the same clients (#2219)", () => {
    const keys = [
        "conflict.hint_label",
        "conflict.hint.opencode",
        "conflict.hint.claude",
        "conflict.hint.codex",
        "conflict.hint.pi",
        "conflict.hint.omp",
        "conflict.hint.antigravity",
        "conflict.hint.generic",
        "conflict.hint_more",
        "conflict.docs",
    ];
    for (const k of keys) {
        const zh = MESSAGES["zh-CN"][k];
        const en = MESSAGES["en"][k];
        assert.ok(typeof zh === "string" && zh.length > 0, `zh-CN missing ${k}`);
        assert.ok(typeof en === "string" && en.length > 0, `en missing ${k}`);
    }
    for (const c of ["opencode", "claude", "codex", "pi", "omp", "antigravity"]) {
        assert.ok(MESSAGES["zh-CN"][`conflict.hint.${c}`] && MESSAGES["en"][`conflict.hint.${c}`], `drift: ${c} missing from i18n`);
    }
});

// The hint block lives in the browser IIFE; extract the self-contained head of
// WEB_CLIENT (through the test-seam export) and run it under stubbed globals —
// same technique as web-conflict-banner.test.ts, extended to reach t()/MESSAGES.
function loadHintBlock(lang: "zh-CN" | "en"): (clients: unknown) => string {
    const seam = "window.bili_conflictHintBlock = conflictHintBlock;";
    const e = WEB_CLIENT.indexOf(seam);
    assert.ok(e >= 0, "hint-block test seam missing from WEB_CLIENT");
    const src = WEB_CLIENT.slice(0, e + seam.length) + "\nreturn conflictHintBlock;\n})()";
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevLs = g.localStorage;
    g.window = {};
    g.localStorage = { getItem: () => lang };
    try {
        return new Function(`return (${src});`)() as (clients: unknown) => string;
    } finally {
        if (prevWindow === undefined) delete g.window; else g.window = prevWindow;
        if (prevLs === undefined) delete g.localStorage; else g.localStorage = prevLs;
    }
}

test("web hint block: one line per client, unknown → generic, capped at 3, docs pointer last (#2219)", () => {
    const f = loadHintBlock("en");
    const out = f(["opencode", "dsh"]);
    assert.ok(out.includes("What to do (per client):"), out);
    assert.ok(out.includes("which set it for you"), "opencode-specific line");
    assert.ok(out.includes("the ledger is per-session"), "unknown client dsh → generic line");
    assert.ok(out.includes("Detecting other compression plugins (#1206)"), "docs pointer present");

    const many = f(["opencode", "claude", "codex", "pi"]);
    assert.ok(many.includes("aligns CLAUDE_CODE_AUTO_COMPACT_WINDOW automatically"), many);
    assert.ok(many.includes("remove the override to stop"), many);
    assert.ok(!many.includes("carriage evidence or an old version"), "4th client capped out of the banner");
    assert.ok(many.includes("1 more client(s)"), "overflow note names the hidden count");

    const empty = f(undefined);
    assert.ok(empty.includes("the ledger is per-session"), "no clients resolved → generic only");
    assert.equal((empty.match(/mono small/g) || []).length, 1, "generic case renders exactly one hint line");
});

test("web hint block: zh locale renders the zh hint lines (#2219)", () => {
    const f = loadHintBlock("zh-CN");
    const out = f(["claude"]);
    assert.ok(out.includes("处置方法（按客户端）："), out);
    assert.ok(out.includes("自动对齐 CLAUDE_CODE_AUTO_COMPACT_WINDOW"), out);
});

test("web wiring: banner consumes conflicts.clients, session-detail card consumes conflictClient (#2219)", () => {
    assert.ok(WEB_CLIENT.includes("conflictHintBlock(c.clients)"), "banner wired to summarizeConflicts clients[]");
    assert.ok(WEB_CLIENT.includes("conflictHintLine(d.conflictClient)"), "session-detail card wired to conflictClient");
    assert.ok(WEB_CLIENT.includes("window.bili_conflictHintBlock = conflictHintBlock;"), "test seam export present");
});

test("formatConflictSection: identity-orphan-only ledger gets identity-loss framing, not the [suspected]-plugin bucket (#2802 review)", () => {
    const orphan = (at: number): ConflictEvent[] => [
        { at, kind: "identity-orphan", detail: "anonymous anthropic request replayed this conversation without client identity (normalized tail match at depth 19); session orphaned to a fresh pfa-c911250bdddebd02 fork — fold continuity lost (#2791 family)" },
    ];

    const activeText = formatConflictSection(orphan(Date.now() - 60_000), Date.now(), "dsh").join("\n");
    assert.ok(activeText.includes("possible identity-loss replays"), activeText);
    assert.ok(activeText.includes("does NOT prove"), activeText);
    assert.ok(activeText.includes("Original session state is retained"), activeText);
    assert.ok(!activeText.includes("THIS session's fold continuity broke"), activeText);
    assert.ok(!activeText.includes("or start a fresh conversation"), activeText);
    assert.ok(activeText.includes("NO second compressor to hunt for"), activeText);
    assert.ok(activeText.includes("pfa-c911250bdddebd02"), "raw event line still names the fork");
    // the misclassification this test pins: no plugin-hunt advice, no per-client
    // auto-compaction remediation footer, no third-party-plugin docs pointer on a
    // bili-owned diagnostic
    assert.ok(!activeText.includes("confirm each named plugin"), activeText);
    assert.ok(!activeText.includes("Fix (dsh):"), activeText);
    assert.ok(!activeText.includes("disable the client's own auto-compaction"), activeText);
    assert.ok(!activeText.endsWith(CONFLICT_DOCS_POINTER), activeText);

    const stockText = formatConflictSection(orphan(Date.now() - 30 * DAY), Date.now()).join("\n");
    assert.ok(stockText.includes("historical stock"), stockText);
    assert.ok(stockText.includes("clear this ledger"), stockText);
    assert.ok(!stockText.endsWith(CONFLICT_DOCS_POINTER), stockText);
});

test("formatConflictSection: mixed orphan + suspected ledger keeps the existing suspected tier verbatim (#2802 review)", () => {
    const events: ConflictEvent[] = [
        { at: Date.now() - 60_000, kind: "third-party-plugin", detail: "name-only match: some-compressor [suspected]" },
        { at: Date.now() - 30_000, kind: "identity-orphan", detail: "session orphaned to a fresh pfa-c911250bdddebd02 fork" },
    ];
    const text = formatConflictSection(events, Date.now(), "dsh").join("\n");
    assert.ok(text.includes("confirm each named plugin"), text);
    assert.ok(text.endsWith(CONFLICT_DOCS_POINTER), text);
});
