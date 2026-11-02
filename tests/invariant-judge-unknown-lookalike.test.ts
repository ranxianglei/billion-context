// #564/#2627 — unknown separator ownership must not hide an UNCHANGED client
// lookalike in either fidelity scan.
//
// The judge has two scans: the ordinary frozen-prefix scan and the #4241
// render-lane tail scan. Both used to test `separatorOwnershipUnknown` BEFORE
// `stableEqual`, so a client message whose bytes are still exactly there could
// be skipped as "unattributable separator" and then reported absent from the
// outbound — a false mid-history-drop/mid-history-rewrite against a client that
// did nothing wrong. The exclusion exists to suppress OWNERSHIP verdicts for a
// marker bili itself minted and can no longer prove; exact byte equality is
// fidelity evidence and is never proof of producer ownership, so it must be
// tested first. These tests pin that ordering, and pin that the exemption stays
// narrow: changed/dropped client items, unknown extras and I3 pairing remain
// judged under the same flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { judgeInboundOutbound, type JudgeVerdict } from "../src/invariant-judge.js";
import { RESPONSES_TURN_SEPARATOR } from "../src/server/responses-separator.js";
type JudgeOptions = Parameters<typeof judgeInboundOutbound>[2];

let seq = 0;
function mk(
    role: CoreMessage["role"],
    contentType: CoreMessage["contentType"],
    text: string,
    extra: Partial<CoreMessage> = {},
): CoreMessage {
    seq++;
    return { id: `m${String(seq).padStart(5, "0")}`, role, contentType, text, ...extra };
}
const user = (text: string): CoreMessage => mk("user", "text", text);
const asst = (text: string): CoreMessage => mk("assistant", "text", text);
const UNKNOWN: JudgeOptions = { separatorOwnershipUnknown: true };

const kinds = (v: JudgeVerdict): string[] => v.violations.map((x) => x.kind);

// A client history containing a separator-SHAPED message of its own: same role,
// same content type, and the very text bili's ordering marker carries
// (RESPONSES_TURN_SEPARATOR), so `isSeparatorCoreShaped` can never tell them
// apart. Ownership is what separates them, and here it is UNKNOWN.
const lookalike = (): CoreMessage => user(RESPONSES_TURN_SEPARATOR);

// --- ordinary frozen-prefix scan ---------------------------------------

test("#2627 unknown ownership: an UNCHANGED client lookalike in the frozen prefix stays clean", () => {
    const entry = [user("q"), lookalike(), asst("A")];
    const exit = [user("q"), lookalike(), asst("A")];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, true, JSON.stringify(v.violations));
    assert.equal(v.matched, 3, "the lookalike is matched, not skipped");
    assert.equal(v.total, 3);
});

test("#2627 unknown ownership: the same lookalike at the END of the frozen prefix stays clean", () => {
    // The skip also covered the last scanned index; equality has to hold at the
    // tail, where a skipped element used to read as a drop.
    const entry = [asst("A"), user("q"), lookalike()];
    const exit = [asst("A"), user("q"), lookalike()];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, true, JSON.stringify(v.violations));
    assert.equal(v.matched, 3);
});

test("#2627 unknown ownership: a CHANGED lookalike is still a rewrite finding", () => {
    // Client sent its own prose; the outbound carries the marker text instead.
    // Ownership is unknown, so the judge must not call the marker bili's — but
    // the client item is still observably gone, which stays attributable.
    const entry = [user("q"), user("client's own prose"), asst("A")];
    const exit = [user("q"), lookalike(), asst("A")];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, false, "a changed client item stays a finding");
    // The judge names the vanishing baseline item, so either kind is correct
    // here; what P23 must not do is make this clean.
    assert.ok(
        kinds(v).some((k) => k === "mid-history-rewrite" || k === "mid-history-drop"),
        JSON.stringify(kinds(v)),
    );
});

test("#2627 unknown ownership: a DROPPED lookalike is still a drop finding", () => {
    // Both the client prose and the marker-shaped item are in the baseline; the
    // outbound keeps one of them, so one client message genuinely vanished.
    const entry = [user("q"), user("client's own prose"), lookalike(), asst("A")];
    const exit = [user("q"), lookalike(), asst("A")];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, false, "a dropped client item stays a finding");
    assert.ok(
        kinds(v).some((k) => k === "mid-history-rewrite" || k === "mid-history-drop"),
        JSON.stringify(kinds(v)),
    );
});

test("#2627 unknown ownership: an UNKNOWN EXTRA marker gets only the narrow ownership exemption", () => {
    // bili minted a marker, its proof was destroyed, and the marker text sits
    // mid-history where an unexplained element is otherwise an insertion. That
    // single ownership verdict is suppressed...
    const entry = [user("q"), asst("A"), asst("B")];
    const exit = [user("q"), asst("A"), lookalike(), asst("B")];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, true, JSON.stringify(v.violations));
    assert.equal(v.matched, 3, "every client message still matched around it");

    // ...but the same text is NOT exempt without the flag: "ownership unknown"
    // is a distinct state from "no claims exist" (#2627), and absent the flag
    // the element is judged as an ordinary client insertion.
    const legacy = judgeInboundOutbound(entry, exit);
    assert.equal(legacy.ok, false, "without unknown-ownership the marker is judged");
    assert.ok(kinds(legacy).includes("mid-insertion"), JSON.stringify(kinds(legacy)));
});

test("#2627 unknown ownership: the exemption grants nothing to a NON-separator extra", () => {
    // The skip is shape-scoped. An unrelated injected client item beside an
    // unknown marker is still an insertion: unknown ownership must never become
    // a blanket licence for injected content. The judge reports one insertion
    // for the divergent region (soft-resync attributes it to the marker index),
    // so assert on the verdict, not on which of the two indexes it names.
    const entry = [user("q"), asst("A"), asst("B")];
    const exit = [user("q"), asst("A"), lookalike(), user("INJECTED"), asst("B")];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, false, "the non-separator extra is still reported");
    assert.ok(kinds(v).includes("mid-insertion"), JSON.stringify(kinds(v)));
    assert.equal(v.matched, 3, "the untouched client messages still matched");
});

test("#2627 unknown ownership: I3 tool pairing stays armed", () => {
    // Separator ownership is orthogonal to protocol soundness: a half-pair the
    // client sent paired is still bili's fault under the same flag.
    const entry = [
        user("q"),
        mk("assistant", "tool-call", "{}", { toolName: "read", toolCallId: "c_1" }),
        mk("tool", "tool-result", "done", { toolCallId: "c_1" }),
        lookalike(),
        asst("A"),
    ];
    const exit = [
        user("q"),
        mk("assistant", "tool-call", "{}", { toolName: "read", toolCallId: "c_1" }),
        lookalike(),
        asst("A"),
    ];
    const v = judgeInboundOutbound(entry, exit, UNKNOWN);
    assert.equal(v.ok, false, "unknown separator ownership does not disarm I3");
    assert.ok(kinds(v).includes("unpaired-tool-call"), JSON.stringify(kinds(v)));
});

// --- #4241 render-lane tail scan ---------------------------------------

test("#4241 render lane, unknown ownership: an UNCHANGED tail lookalike stays clean", () => {
    // The rendered prefix (entry[0..1]) may legitimately be replaced by the
    // server transcript; only the tail is promised byte-intact, and the tail
    // starts ON the lookalike.
    const entry = [user("q"), asst("rendered-away"), lookalike(), user("tail")];
    const exit = [asst("server transcript row"), lookalike(), user("tail")];
    const v = judgeInboundOutbound(entry, exit, { ...UNKNOWN, renderTailStart: 2 });
    assert.equal(v.ok, true, JSON.stringify(v.violations));
    assert.equal(v.renderLane, true);
    assert.equal(v.matched, 2, "lookalike + tail, both matched");
});

test("#4241 render lane, unknown ownership: a CHANGED tail lookalike is still a rewrite finding", () => {
    const entry = [user("q"), asst("rendered-away"), user("client's own prose"), user("tail")];
    const exit = [asst("server transcript row"), lookalike(), user("tail")];
    const v = judgeInboundOutbound(entry, exit, { ...UNKNOWN, renderTailStart: 2 });
    assert.equal(v.ok, false, "the tail's client item changed and stays attributable");
    assert.ok(kinds(v).includes("mid-history-rewrite"), JSON.stringify(kinds(v)));
});

test("#4241 render lane, unknown ownership: a DROPPED tail lookalike is still a drop finding", () => {
    const entry = [user("q"), asst("rendered-away"), user("client's own prose"), lookalike(), user("tail")];
    const exit = [asst("server transcript row"), lookalike(), user("tail")];
    const v = judgeInboundOutbound(entry, exit, { ...UNKNOWN, renderTailStart: 2 });
    assert.equal(v.ok, false, "the tail's client item vanished and stays attributable");
    assert.ok(
        kinds(v).some((k) => k === "mid-history-rewrite" || k === "mid-history-drop"),
        JSON.stringify(kinds(v)),
    );
});

test("#4241 render lane, unknown ownership: I3 pairing stays armed", () => {
    const entry = [
        user("q"),
        asst("rendered-away"),
        mk("assistant", "tool-call", "{}", { toolName: "read", toolCallId: "c_2" }),
        mk("tool", "tool-result", "done", { toolCallId: "c_2" }),
        lookalike(),
    ];
    const exit = [
        asst("server transcript row"),
        mk("assistant", "tool-call", "{}", { toolName: "read", toolCallId: "c_2" }),
        lookalike(),
    ];
    const v = judgeInboundOutbound(entry, exit, { ...UNKNOWN, renderTailStart: 2 });
    assert.equal(v.ok, false, "render-lane unknown ownership does not disarm I3");
    assert.ok(kinds(v).includes("unpaired-tool-call"), JSON.stringify(kinds(v)));
});

// --- negatives: real provenance and absent claims keep their contracts --

test("#2627 a PROVEN producer marker is exempt with or without the unknown flag", () => {
    // A producer-owned index is exempt by proof, not by shape, in both states.
    const entry = [user("q"), asst("A"), asst("B")];
    const exit = [user("q"), asst("A"), lookalike(), asst("B")];
    const proven = judgeInboundOutbound(entry, exit, { separatorProvenance: new Set([2]) });
    assert.equal(proven.ok, true, JSON.stringify(proven.violations));
    const both = judgeInboundOutbound(entry, exit, { ...UNKNOWN, separatorProvenance: new Set([2]) });
    assert.equal(both.ok, true, JSON.stringify(both.violations));
});

test("#2627 an ABSENT or EMPTY provenance set never exempts a marker", () => {
    // The pre-existing contract (#2627): only a non-empty proven set exempts.
    // P23 changed scan ORDER, not this claim test — an empty set must keep
    // behaving exactly as before.
    const entry = [user("q"), asst("A"), asst("B")];
    const exit = [user("q"), asst("A"), lookalike(), asst("B")];
    for (const opts of [{}, { separatorProvenance: new Set<number>() }] satisfies JudgeOptions[]) {
        const v = judgeInboundOutbound(entry, exit, opts);
        assert.equal(v.ok, false, JSON.stringify(opts));
        assert.ok(kinds(v).includes("mid-insertion"), JSON.stringify(kinds(v)));
    }
});
