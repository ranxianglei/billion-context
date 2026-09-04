import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnCacheCollapse } from "../src/cache-warn.ts";
import { setLogCapture } from "../src/logger.ts";
import type { Session } from "../src/session.ts";

const warnings: string[] = [];

beforeEach(() => {
    warnings.length = 0;
    setLogCapture((level, msg) => {
        if (level === "warn") warnings.push(msg);
    });
});

afterEach(() => {
    setLogCapture(null);
});

function makeSession(): Session {
    return {
        id: `cw-${Math.random().toString(36).slice(2, 8)}`,
        metadata: {},
        stats: { lastInputTokens: 0 },
    } as unknown as Session;
}

test("collapse after a healthy cache warns exactly once", () => {
    const session = makeSession();
    warnCacheCollapse(session, 50000, 45000);
    for (let i = 0; i < 10; i++) warnCacheCollapse(session, 50000, 100);
    const hits = warnings.filter((w) => w.includes("prompt-cache collapse"));
    assert.equal(hits.length, 1, "warns once");
    assert.match(hits[0]!, /input=50000, cached=100/);
});

test("no warning without a prior high-hit sample", () => {
    const session = makeSession();
    for (let i = 0; i < 10; i++) warnCacheCollapse(session, 50000, 0);
    assert.equal(warnings.filter((w) => w.includes("prompt-cache collapse")).length, 0);
});

test("a mid-run partial hit resets the low streak", () => {
    const session = makeSession();
    warnCacheCollapse(session, 50000, 45000);
    warnCacheCollapse(session, 50000, 0);
    warnCacheCollapse(session, 50000, 0);
    warnCacheCollapse(session, 50000, 0);
    warnCacheCollapse(session, 50000, 0);
    warnCacheCollapse(session, 50000, 10000, );
    for (let i = 0; i < 4; i++) warnCacheCollapse(session, 50000, 0);
    assert.equal(warnings.filter((w) => w.includes("prompt-cache collapse")).length, 0, "streak broken at 4 < 5");
    warnCacheCollapse(session, 50000, 0);
    assert.equal(warnings.filter((w) => w.includes("prompt-cache collapse")).length, 1, "a full second streak warns");
});

test("small inputs are never counted", () => {
    const session = makeSession();
    warnCacheCollapse(session, 50000, 45000);
    for (let i = 0; i < 10; i++) warnCacheCollapse(session, 500, 0);
    assert.equal(warnings.filter((w) => w.includes("prompt-cache collapse")).length, 0);
});
