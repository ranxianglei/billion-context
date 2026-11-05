// #3476: the per-call body-stability classifier (panel `bs`, src/cache-ledger.ts)
// and the offline `bili acp-cache diff` tool (src/acp-cache-diff.ts::compareWires)
// both defined "append" purely by the FIRST diverging byte offset. A layout that
// grows INSIDE a single logical unit — auto-review's giant user message, whose
// FILTERED_HISTORY gains entries while a fixed PENDING_ACTION block stays at the
// very end — is semantically an append (no prior byte moved or changed) yet its
// first divergence lands mid-body, so both classifiers stably reported "mid"
// (false positive). Fix: recognize a SEMANTIC append — the older payload fully
// covered by common prefix+suffix (empty middle residual) while the newer one
// carries extra bytes in that middle. These tests pin that recognition AND guard
// that a genuine in-place rewrite of the same unit still reads as a rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareWires, runDiff } from "../src/acp-cache-diff.ts";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

// auto-review sidecar shape: fixed REVIEW_POLICY system + one giant user message
// whose FILTERED_HISTORY grows in place while PENDING_ACTION stays pinned last.
function reviewBody(history: string[]): string {
    const sys = JSON.stringify({ role: "system", content: "REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call." + "policy-body-fill ".repeat(40) });
    const env = "ENVIRONMENT\nPROJECT_INSTRUCTIONS\n" + "instruction-line ".repeat(60);
    const hist = history.map((h) => JSON.stringify(h)).join(",");
    const user = JSON.stringify({ role: "user", content: `${env}FILTERED_HISTORY [${hist}] PENDING_ACTION ${JSON.stringify({ tool: "bash", cmd: "rm -rf build" })}` });
    return `{"model":"gpt-x","messages":[${sys},${user}]}`;
}

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `midins-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}
function settle(s: Session, input: number, cached: number): void {
    settleUsageReport(s, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("compareWires: growing-container insert (auto-review shape) is append(mid-insert), not a rewrite", () => {
    const a = Buffer.from(reviewBody(["turn-1 transcript chunk"]));
    const b = Buffer.from(reviewBody(["turn-1 transcript chunk", "turn-2 transcript chunk"]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "append", "semantic append must not read as a mid-stream rewrite");
    assert.equal(r.append?.kind, "mid-insert");
});

test("compareWires: in-place REWRITE of the same unit still diverges (no masking a real break)", () => {
    const a = Buffer.from(reviewBody(["alpha-entry"]));
    const b = Buffer.from(reviewBody(["omega-entry"]));
    const r = compareWires(a, b);
    assert.equal(r.rel, "diverge", "a changed byte inside the unit is a real rewrite — mid-insert must not swallow it");
});

test("compareWires: healthy array-append is still append(json-tail), unchanged by the fix", () => {
    const m1 = { role: "user", content: "one" };
    const m2 = { role: "assistant", content: "two" };
    const a = Buffer.from(JSON.stringify({ model: "m", messages: [m1] }));
    const b = Buffer.from(JSON.stringify({ model: "m", messages: [m1, m2] }));
    const r = compareWires(a, b);
    assert.equal(r.rel, "append");
    assert.equal(r.append?.kind, "json-tail");
});

test("runDiff: auto-review sidecar pair classifies pure-append (was mid-stream-rewrite)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp3476-"));
    try {
        const tA = Date.parse("2026-10-16T11:19:00.000Z");
        const tB = tA + 6_000;
        const hdrs = "content-type: application/json";
        const write = (ts: number, kind: "REQ", body: string): void => {
            fs.writeFileSync(path.join(dir, `${ts}-subrev-${kind}.txt`), `POST /v1/chat/completions\n${hdrs}\n\n${body}`);
        };
        write(tA, "REQ", reviewBody(["turn-1 transcript chunk"]));
        write(tB, "REQ", reviewBody(["turn-1 transcript chunk", "turn-2 transcript chunk"]));
        const report = runDiff(dir, { noLog: true });
        assert.equal(report.totalPairs, 1);
        const p = report.sessions[0]!.pairs[0]!;
        assert.equal(p.category, "pure-append", "the sidecar's semantic append must not be charged as a rewrite");
        assert.equal(p.outgoing, "append");
        assert.equal(p.outgoingAppend?.kind, "mid-insert");
    } finally { rmrf(dir); }
});

test("panel bs: growing-container insert is append (was mid), stability.mid stays 0", () => {
    const s = makeSession();
    noteForwardedBody(s, reviewBody(["turn-1 transcript chunk"]));
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, reviewBody(["turn-1 transcript chunk", "turn-2 transcript chunk"]));
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "append", "byte-wise mid-body insertion of a stable-trailer unit is a semantic append");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.append, 1);
    assert.equal(rep.stability.mid, 0, "no mid-history count may be charged for the auto-review layout");
});

test("panel bs: in-place REWRITE of the same unit still classifies mid (guard)", () => {
    const s = makeSession();
    noteForwardedBody(s, reviewBody(["alpha-entry"]));
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, reviewBody(["omega-entry"]));
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "a changed byte inside the unit is a real mid-history break");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.mid, 1);
    assert.equal(rep.stability.append, 0);
});
