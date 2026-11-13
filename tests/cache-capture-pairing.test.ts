import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { buildSessionCacheReport, getCacheLedger, lastForwardedBody, noteForwardedBody, noteForwardedImageFacts, noteInboundMessages, settleUsageReport, withCacheCapture } from "../src/cache-ledger.ts";

const testData = mkdtempSync(path.join(tmpdir(), "bili-capture-"));
const priorData = process.env.XDG_DATA_HOME;
const priorStorage = process.env.BILI_STORAGE_UNIFIED;
process.env.XDG_DATA_HOME = testData;
process.env.BILI_STORAGE_UNIFIED = "legacy";
_setStoreForTest(new SessionStore({ enabled: false }));
after(() => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    if (priorStorage === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = priorStorage;
    rmrf(testData);
});

let seq = 0;
const session = (): Session => ({ id: `capture-${++seq}`, metadata: {}, stats: {}, state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} } }) as unknown as Session;
const incoming = (id: string, text = "same"): CoreMessage[] => [{ id, role: "user", contentType: "text", text }];
const body = (text: string): string => JSON.stringify({ messages: [{ role: "user", content: text }] });
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const settle = (s: Session, total = 100_000, cached = 20_000): void => settleUsageReport(s, { total, reportedCached: cached, output: 1 });
function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
}

for (const reverse of [false, true]) {
    test(`overlapping captures keep body, inbound and image evidence paired; reverse=${reverse}`, async () => {
        const s = session();
        const readyA = gate(), readyB = gate(), doneA = gate(), doneB = gate();
        const run = (label: string, ready: ReturnType<typeof gate>, done: ReturnType<typeof gate>) => withCacheCapture(s, async () => {
            const wire = body(label);
            noteForwardedBody(s, wire);
            noteInboundMessages(s, incoming(label, label));
            noteForwardedImageFacts(s, { host: label, fp: label, nImages: 1, textSide: 99_000 });
            ready.open();
            await done.wait;
            assert.equal(lastForwardedBody(s)?.digest, digest(wire));
            settle(s, 100_000, 99_000);
            const line = getCacheLedger(s).lines.at(-1)!;
            assert.equal(line.bd, digest(wire));
            assert.equal(line.captureRound, 1);
            if (reverse && label === "A") assert.equal(s.transient?.settledInBody, undefined);
            else assert.equal(s.transient?.settledInBody?.meta[0]?.len, JSON.stringify(incoming(label, label)[0]).length);
            assert.ok(s.metadata.learnedImageCosts && typeof s.metadata.learnedImageCosts === "object" && label in s.metadata.learnedImageCosts);
        });
        const a = run("A", readyA, doneA);
        await readyA.wait;
        const b = run("BBBB", readyB, doneB);
        await readyB.wait;
        if (reverse) { doneB.open(); await b; doneA.open(); await a; }
        else { doneA.open(); await a; doneB.open(); await b; }
        const lines = getCacheLedger(s).lines;
        assert.notEqual(lines[0].captureId, lines[1].captureId);
        assert.equal(s.transient?.sentBody, undefined);
    });
}


test("internal rounds keep request identity without stale inbound evidence", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body("first"));
        noteInboundMessages(s, incoming("first"));
        settle(s, 100_000, 99_000);
        noteForwardedBody(s, body("second"));
        settle(s, 100_000, 99_000);
    });
    const [a, b] = getCacheLedger(s).lines;
    assert.equal(a.captureId, b.captureId);
    assert.equal(a.captureRound, 1);
    assert.equal(b.captureRound, 2);
    assert.equal(s.transient?.settledInBody, undefined);
});

test("aborted capture cannot leak body or image learning into the next forward", async () => {
    const s = session();
    await assert.rejects(withCacheCapture(s, async () => {
        noteForwardedBody(s, body("aborted"));
        noteInboundMessages(s, incoming("aborted"));
        noteForwardedImageFacts(s, { host: "aborted", fp: "a", nImages: 1, textSide: 99_000 });
        throw new Error("synthetic abort");
    }), /synthetic abort/);
    await withCacheCapture(s, async () => {
        assert.equal(lastForwardedBody(s), undefined);
        settle(s, 100_000, 99_000);
    });
    assert.equal(getCacheLedger(s).lines.at(-1)?.bd, undefined);
    assert.equal(s.metadata.learnedImageCosts, undefined);
    assert.equal(s.transient?.settledBody, undefined);
});

test("reversed completion clears comparison evidence instead of reporting a seam", async () => {
    const s = session(), ready = gate(), release = gate();
    const a = withCacheCapture(s, async () => {
        noteForwardedBody(s, body("older"));
        noteInboundMessages(s, incoming("a"));
        ready.open();
        await release.wait;
        settle(s);
    });
    await ready.wait;
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body("newer"));
        noteInboundMessages(s, incoming("b"));
        settle(s, 100_000, 99_000);
    });
    release.open();
    await a;
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.evidence, "out-of-order");
    assert.equal(line.be, undefined);
    assert.equal(line.seam, undefined);
    assert.equal(line.prov, undefined);
    assert.equal(buildSessionCacheReport(s).lines.at(-1)?.evidence, "out-of-order");
    assert.equal(s.transient?.settledBody, undefined);
    assert.equal(s.transient?.settledInBody, undefined);
});

test("legacy callers and undefined sessions keep their capture behavior", async () => {
    const s = session();
    await withCacheCapture(undefined, async () => {
        noteForwardedBody(s, body("legacy"), 1, "credential", "params");
        noteInboundMessages(s, incoming("legacy"));
        settle(s, 100_000, 99_000);
    });
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.bd, digest(body("legacy")));
    assert.equal(line.kp, "credential");
    assert.equal(line.efp, "params");
    assert.equal(line.captureId, undefined);
    assert.ok(s.transient?.settledInBody);
});

test("an unbilled image round cannot teach the next image-free round", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body("image round"));
        noteForwardedImageFacts(s, { host: "old", fp: "a", nImages: 1, textSide: 99_000 });
        noteForwardedBody(s, body("retry without images"));
        settle(s, 100_000, 99_000);
    });
    assert.equal(s.metadata.learnedImageCosts, undefined);
});

test("relay image facts captured before the first body survive until usage", async () => {
    const s = session();
    await withCacheCapture(s, async () => {
        noteForwardedImageFacts(s, { host: "relay", fp: "a", nImages: 1, textSide: 99_000 });
        noteForwardedBody(s, body("first"));
        settle(s, 100_000, 99_000);
    });
    assert.ok(s.metadata.learnedImageCosts && typeof s.metadata.learnedImageCosts === "object" && "relay" in s.metadata.learnedImageCosts);
});
