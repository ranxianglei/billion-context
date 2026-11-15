import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import type { Session } from "../src/session.ts";

const options = { mode: "repair" as const, sessionId: "rewrite-work", log: () => {} };
const message = (id: string, role: "user" | "assistant", text: string, contentType: "text" | "reasoning" = "text"): CoreMessage => ({ id, role, text, contentType });

function fixture(ids: string[], shared = false) {
    let work = 0;
    const tracked = () => new Proxy([...ids], {
        get(target, key, receiver) {
            if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) work++;
            return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
            if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) work++;
            return Reflect.set(target, key, value, receiver);
        },
    });
    const effectiveMessageIds = tracked();
    const directMessageIds = shared ? effectiveMessageIds : tracked();
    const block = { blockId: "covered", active: true, effectiveMessageIds, directMessageIds };
    const session = { id: "rewrite-work", state: { blocks: [block] }, metadata: {} } as unknown as Session;
    return { session, block, reset: () => { work = 0; }, work: () => work };
}

function repair(originals: CoreMessage[], incoming: CoreMessage[], ids: string[], expected: string[], shared = false) {
    const f = fixture(ids, shared);
    reconcileFoldCoverage(f.session, originals, options);
    const effective = f.block.effectiveMessageIds;
    const direct = f.block.directMessageIds;
    f.reset();
    const result = reconcileFoldCoverage(f.session, incoming, options);
    const work = f.work();
    assert.equal(result.kind, "reanchored");
    assert.equal(result.unmatched, 0);
    assert.equal(f.block.effectiveMessageIds, effective);
    assert.equal(f.block.directMessageIds, direct);
    assert.deepEqual([...effective], expected);
    assert.deepEqual([...direct], expected);
    assert.ok(work < 80 * (ids.length + expected.length), `${work} coverage-array reads/writes for ${ids.length} old and ${expected.length} new ids`);
}

test("reconciles a full remint without repeatedly scanning covered ids", () => {
    const originals = Array.from({ length: 1_600 }, (_, index) => message(`old-${index}`, "user", `stable instruction number ${index}`));
    const incoming = originals.map((item, index) => ({ ...item, id: `new-${index}` }));
    repair(originals, incoming, originals.map((item) => item.id), incoming.map((item) => item.id));
});

function turns(count: number) {
    const split: CoreMessage[] = [];
    const merged: CoreMessage[] = [];
    const pairIds: string[] = [];
    const mergedIds: string[] = [];
    for (let index = 0; index < count; index++) {
        const user = message(`u-${index}`, "user", `question ${index}`);
        const reasoning = message(`r-${index}`, "assistant", `thinking about question ${index}`, "reasoning");
        const text = message(`t-${index}`, "assistant", `answer to question ${index}`);
        const whole = message(`m-${index}`, "assistant", `${reasoning.text}\n${text.text}`);
        split.push(user, reasoning, text);
        merged.push(user, whole);
        pairIds.push(reasoning.id, text.id);
        mergedIds.push(whole.id);
    }
    return { split, merged, pairIds, mergedIds };
}

test("collapses reasoning/text pairs without repeated tail shifts and keeps shared coverage arrays", () => {
    const { split, merged, pairIds, mergedIds } = turns(600);
    repair(split, merged, pairIds, mergedIds, true);
});

test("expands merged assistant turns without repeatedly shifting the remaining ids", () => {
    const { split, merged, pairIds, mergedIds } = turns(600);
    repair(merged, split, mergedIds, pairIds);
});

test("warn mode diagnoses remints without changing either coverage list", () => {
    const originals = Array.from({ length: 12 }, (_, index) => message(`old-${index}`, "user", `instruction ${index}`));
    const ids = originals.map((item) => item.id);
    const f = fixture(ids);
    reconcileFoldCoverage(f.session, originals, options);
    const result = reconcileFoldCoverage(f.session, originals.map((item, index) => ({ ...item, id: `new-${index}` })), { ...options, mode: "warn" });
    assert.equal(result.kind, "unmatched");
    assert.equal(result.claims, originals.length);
    assert.deepEqual([...f.block.effectiveMessageIds], ids);
    assert.deepEqual([...f.block.directMessageIds], ids);
});

test("unchanged resends retain coverage values and array identity", () => {
    const originals = Array.from({ length: 12 }, (_, index) => message(`stable-${index}`, "user", `instruction ${index}`));
    const ids = originals.map((item) => item.id);
    const f = fixture(ids);
    const effective = f.block.effectiveMessageIds;
    const direct = f.block.directMessageIds;
    reconcileFoldCoverage(f.session, originals, options);
    assert.equal(reconcileFoldCoverage(f.session, originals, options).kind, "resend");
    assert.equal(f.block.effectiveMessageIds, effective);
    assert.equal(f.block.directMessageIds, direct);
    assert.deepEqual([...effective], ids);
    assert.deepEqual([...direct], ids);
});

test("repairs selected ids in order and collapses repeated claims while keeping stable entries", () => {
    const originals = Array.from({ length: 12 }, (_, index) => message(`old-${index}`, "user", `instruction ${index}`));
    const incoming = originals.map((item, index) => index < 2 ? { ...item, id: `new-${index}` } : item);
    repair(originals, incoming, ["old-0", "old-1", "old-1", "old-3"], ["new-0", "new-1", "old-3"]);
});
