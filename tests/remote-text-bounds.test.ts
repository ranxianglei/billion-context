// Free text from the two npm companion documents (advisory `reason`, release-note
// `summary`) is printed on line-oriented surfaces the MODEL reads: acp_status
// puts the advisory on one "CRITICAL ADVISORY" line and every span summary on
// its own "  · <version> [tier] <summary>" line. The parsers used to keep that
// text as-is apart from a trim, so a document could add any number of extra
// lines under those headings and any number of characters to the context.
// These tests pin both directions:
//   - over-long or multi-line text is flattened to one line and truncated when
//     the document is parsed, and the entry itself is KEPT (an advisory still
//     forces its target; a critical note still surfaces);
//   - text already inside the bounds — including every entry this repo ships
//     in advisories/ and release-notes/ — comes out byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { boundedLine } from "../src/text-safe.ts";
import { parseAdvisoryDoc, describeAdvisory, _resetAdvisoryWatcherForTest, _setAdvisoryStateForTest } from "../src/advisory.ts";
import { parseReleaseNotesDoc, _resetReleaseNotesWatcherForTest, _setReleaseNotesStateForTest } from "../src/update-notes.ts";
import { VERSION } from "../src/version.ts";
import semver from "semver";

const REASON_CAP = 500;
const SUMMARY_CAP = 400;
const ID_CAP = 80;
// Line breaks a display surface may honor: CR, LF, VT, FF, NEL, LS, PS.
const LINE_BREAK = /[\n\r\u000b\u000c\u0085\u2028\u2029]/;
const LINE_SPLIT = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;

const HOSTILE = `first line of the text\r\n\nSECOND LINE that would sit under the heading on its own\u2028third\u2029fourth\u0085fifth\tsixth ${"x".repeat(30_000)}`;

function advisoryDoc(advisories: unknown[]): unknown {
    return { billionContextAdvisories: { schema: 1, advisories } };
}

function notesDoc(releases: unknown[]): unknown {
    return { billionContextReleaseNotes: { schema: 1, releases } };
}

test("boundedLine: text inside the bounds is unchanged; breaks and control characters flatten; over-long text is cut with an ellipsis", () => {
    assert.equal(boundedLine("breaks retries on 0.1.155–0.1.156; upgrade (#1844).", 500), "breaks retries on 0.1.155–0.1.156; upgrade (#1844).");
    assert.equal(boundedLine("中文一行，带标点。", 400), "中文一行，带标点。");
    assert.equal(boundedLine("  padded  ", 10), "padded", "outer whitespace still trimmed, as before");
    assert.equal(boundedLine("a\r\nb\n\nc\td\u2028e\u2029f\u0085g\u0000h\u001bi", 100), "a b c d e f g h i");
    assert.equal(boundedLine(" \n\t ", 100), "", "whitespace-only stays empty so the required-field check still rejects it");

    const exact = "y".repeat(400);
    assert.equal(boundedLine(exact, 400), exact, "exactly at the cap: untouched");
    const cut = boundedLine("y".repeat(401), 400);
    assert.equal(cut.length, 400);
    assert.equal(cut, `${"y".repeat(399)}…`);

    // The cut never leaves half of a surrogate pair behind.
    const emoji = boundedLine(`${"z".repeat(398)}😀tail`, 400);
    assert.equal(emoji, `${"z".repeat(398)}…`);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
});

test("parseAdvisoryDoc: a multi-line, over-long reason becomes one bounded line and the entry is kept", () => {
    const r = parseAdvisoryDoc(advisoryDoc([{ id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: HOSTILE }]));
    assert.equal(r.error, undefined);
    assert.equal(r.entries.length, 1, "over-long text truncates; it does not drop the advisory");
    const e = r.entries[0];
    assert.equal(e.id, "bc-2026-001");
    assert.equal(e.affected, ">=0.1.155 <0.1.158");
    assert.equal(e.target, "0.1.157");
    assert.ok(e.reason.length <= REASON_CAP, `reason length ${e.reason.length}`);
    assert.ok(!LINE_BREAK.test(e.reason), "reason is a single line");
    assert.ok(e.reason.startsWith("first line of the text SECOND LINE that would sit under the heading on its own third fourth fifth sixth xxx"));
    assert.ok(e.reason.endsWith("…"));

    const line = describeAdvisory({ ...e, currentVersion: "0.1.156" }, undefined);
    assert.ok(!LINE_BREAK.test(line), "describeAdvisory stays one line");
    assert.ok(line.length <= REASON_CAP + 200, `describeAdvisory length ${line.length}`);
    assert.ok(line.includes("npm install -g billion-context@0.1.157"), "the upgrade command survives the truncation");
});

test("parseAdvisoryDoc: the id is bounded the same way (it is printed on the same line)", () => {
    const r = parseAdvisoryDoc(advisoryDoc([{ id: `bc-2026-002]\n\nNEW LINE ${"i".repeat(5000)}`, affected: ">=1.0.0", target: "1.0.1", reason: "r" }]));
    assert.equal(r.entries.length, 1);
    assert.ok(r.entries[0].id.length <= ID_CAP);
    assert.ok(!LINE_BREAK.test(r.entries[0].id));
    assert.ok(r.entries[0].id.startsWith("bc-2026-002] NEW LINE iii"));
});

test("parseAdvisoryDoc: ordinary entries are byte-identical; whitespace-only fields are still rejected", () => {
    const good = { id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "0.1.155–0.1.156 corrupts tool-call arguments on retry; upgrade to 0.1.157 or later.", publishedAt: "2026-09-27T12:00:00Z" };
    assert.deepEqual(parseAdvisoryDoc(advisoryDoc([good])).entries, [good]);
    const atCap = { id: "i".repeat(ID_CAP), affected: ">=1.0.0", target: "1.0.1", reason: "r".repeat(REASON_CAP) };
    assert.deepEqual(parseAdvisoryDoc(advisoryDoc([atCap])).entries, [atCap], "exactly at the caps: untouched");
    const blank = parseAdvisoryDoc(advisoryDoc([{ id: "x", affected: ">=1.0.0", target: "1.0.1", reason: "\n \t" }, { id: "\r\n", affected: ">=1.0.0", target: "1.0.1", reason: "r" }]));
    assert.deepEqual(blank.entries, []);
    assert.match(blank.error ?? "", /no valid advisories/);
});

test("parseReleaseNotesDoc: multi-line, over-long summary / summaryZh become one bounded line each and the entry is kept", () => {
    const r = parseReleaseNotesDoc(notesDoc([{ version: "0.1.180", date: "2026-10-02", tier: "critical", summary: HOSTILE, summaryZh: `第一行\n第二行${"字".repeat(5000)}`, minVersion: "0.1.100" }]));
    assert.equal(r.error, undefined);
    assert.equal(r.entries.length, 1, "over-long text truncates; it does not drop the note");
    const e = r.entries[0];
    assert.equal(e.version, "0.1.180");
    assert.equal(e.tier, "critical");
    assert.equal(e.minVersion, "0.1.100");
    assert.ok(e.summary.length <= SUMMARY_CAP, `summary length ${e.summary.length}`);
    assert.ok(!LINE_BREAK.test(e.summary));
    assert.ok(e.summary.startsWith("first line of the text SECOND LINE"));
    assert.ok(e.summary.endsWith("…"));
    assert.ok(e.summaryZh !== undefined && e.summaryZh.length <= SUMMARY_CAP);
    assert.ok(!LINE_BREAK.test(e.summaryZh ?? ""));
    assert.ok((e.summaryZh ?? "").startsWith("第一行 第二行字字"));
});

test("parseReleaseNotesDoc: ordinary entries are byte-identical; a whitespace-only summary is still rejected", () => {
    const good = { version: "0.1.180", date: "2026-10-02", tier: "critical", summary: "OpenCode WebSocket traffic is intercepted again — compression and usage stats no longer silently no-op on OpenCode ≥ 2.0.20 (#1844).", summaryZh: "OpenCode 的 WebSocket 流量重新被接管（#1844）。" };
    assert.deepEqual(parseReleaseNotesDoc(notesDoc([good])).entries, [good]);
    const atCap = { version: "0.1.181", tier: "routine", summary: "s".repeat(SUMMARY_CAP), summaryZh: "字".repeat(SUMMARY_CAP) };
    assert.deepEqual(parseReleaseNotesDoc(notesDoc([atCap])).entries, [atCap], "exactly at the producer-side cap: untouched");
    const blank = parseReleaseNotesDoc(notesDoc([{ version: "0.1.182", tier: "routine", summary: " \n\t " }]));
    assert.deepEqual(blank.entries, []);
    assert.match(blank.error ?? "", /no valid release-note entries/);
});

test("the documents this repo publishes parse unchanged (no shipped entry is touched by the bounds)", () => {
    const notesRaw = JSON.parse(readFileSync(new URL("../release-notes/package.json", import.meta.url), "utf8")) as { billionContextReleaseNotes: { releases: Array<Record<string, unknown>> } };
    const shipped = notesRaw.billionContextReleaseNotes.releases;
    const parsed = parseReleaseNotesDoc(notesRaw);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.entries.length, shipped.length);
    for (let i = 0; i < shipped.length; i++) {
        assert.equal(parsed.entries[i].summary, shipped[i].summary, `release-notes entry ${String(shipped[i].version)}: summary`);
        assert.equal(parsed.entries[i].summaryZh, shipped[i].summaryZh, `release-notes entry ${String(shipped[i].version)}: summaryZh`);
    }

    const advRaw = JSON.parse(readFileSync(new URL("../advisories/package.json", import.meta.url), "utf8")) as { billionContextAdvisories: { advisories: Array<Record<string, unknown>> } };
    const advShipped = advRaw.billionContextAdvisories.advisories;
    const adv = parseAdvisoryDoc(advRaw);
    assert.equal(adv.error, undefined);
    assert.equal(adv.entries.length, advShipped.length);
    for (let i = 0; i < advShipped.length; i++) {
        assert.equal(adv.entries[i].id, advShipped[i].id);
        assert.equal(adv.entries[i].reason, advShipped[i].reason);
    }
});

function makeCtx(): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    const messages: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) messages.push({ id: `raw_${i}`, role: i % 2 === 1 ? "user" : "assistant", contentType: "text", text: "x".repeat(5000) });
    const ctx = {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "remote-text-bounds-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        } as Session,
        log: () => {},
    };
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

test("acp_status: a hostile document adds exactly one advisory line and one line per span entry, each bounded", async () => {
    _resetAdvisoryWatcherForTest();
    _resetReleaseNotesWatcherForTest();
    const { handleAcpStatus } = await import("../src/acp-status.ts");
    const running = semver.valid(VERSION) ?? "0.0.1";
    const next = semver.inc(running, "patch") ?? "0.0.2";
    const next2 = semver.inc(next, "patch") ?? "0.0.3";
    try {
        const ctx = makeCtx();
        const clean = handleAcpStatus({}, ctx).text;
        assert.ok(!clean.includes("CRITICAL ADVISORY") && !clean.includes("CRITICAL UPDATE"));
        const cleanLines = clean.split(LINE_SPLIT).length;

        // Everything below goes through the real parsers, the way the two
        // watchers feed the state the surface reads.
        const adv = parseAdvisoryDoc(advisoryDoc([{ id: "bc-2026-001", affected: ">=0.0.0", target: "0.1.157", reason: HOSTILE }]));
        const notes = parseReleaseNotesDoc(notesDoc([
            { version: next2, tier: "routine", summary: HOSTILE },
            { version: next, tier: "critical", summary: HOSTILE },
        ]));
        _setAdvisoryStateForTest({ active: { ...adv.entries[0], currentVersion: running } });
        _setReleaseNotesStateForTest({ entries: notes.entries, diskVersion: next2 });

        const text = handleAcpStatus({}, ctx).text;
        const lines = text.split(LINE_SPLIT);
        const advLines = lines.filter((l) => l.includes("CRITICAL ADVISORY (instance-level)"));
        assert.equal(advLines.length, 1);
        assert.ok(advLines[0].length <= REASON_CAP + 500, `advisory line length ${advLines[0].length}`);
        assert.ok(advLines[0].includes("first line of the text SECOND LINE"), "the flattened text sits on the advisory line itself");
        assert.ok(advLines[0].endsWith("Live state: the advisory field of GET /__bili/status."), "the fixed tail of the line is still there");

        const spanLines = lines.filter((l) => l.startsWith("  · "));
        assert.equal(spanLines.length, 2, "one line per span entry");
        for (const l of spanLines) assert.ok(l.length <= SUMMARY_CAP + 60, `span line length ${l.length}`);
        assert.ok(text.includes("CRITICAL UPDATE READY (instance-level)"));

        // Section arithmetic: blank + advisory line, blank + headline + 2 span
        // lines + live-state line. Nothing from the document starts a line of
        // its own.
        assert.equal(lines.length, cleanLines + 2 + 5);
        assert.ok(!lines.some((l) => l.startsWith("SECOND LINE")), "document text never starts a line");
        assert.ok(text.length < clean.length + 3000, `section growth ${text.length - clean.length}`);
    } finally {
        _resetAdvisoryWatcherForTest();
        _resetReleaseNotesWatcherForTest();
    }
});
