import test from "node:test";
import assert from "node:assert/strict";
import { maybeAdoptResume, incomingCoreMessages } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { type Session } from "../src/session.ts";

process.env.NODE_ENV = "test";

// #6122: a DSH fork that inherited 1 of 5 active blocks logged only the
// adopted count — the 4 straddling blocks were invisible in the log, so the
// field triage had to rebuild the ledger by hand to see what would (and when)
// still be adopted. The inherited line must name the straddled count, the
// way the lineage-reconcile line already does (#2807).

function fixtures(straddle: boolean) {
    const parsed = {
        model: "m",
        max_tokens: 1,
        messages: [
            { role: "user", content: "hello world 6122" },
            { role: "assistant", content: "hi there 6122" },
        ],
    };
    const msgs = incomingCoreMessages("anthropic", parsed)!;
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const tsStamps: Record<string, number> = {};
    msgs.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
        tsStamps[m.id] = 1730000000 + i;
    });
    // b1 is fully present in the incoming core; b2 names a raw id the child
    // never sent (a message the child's replay omitted) — it straddles.
    const blocks = [
        { blockId: "b1", active: true, effectiveMessageIds: [msgs[0].id], directBlockIds: [], compressedTokens: 42 },
    ];
    if (straddle) {
        blocks.push({
            blockId: "b2",
            active: true,
            effectiveMessageIds: [msgs[1].id, "raw-id-the-child-never-sent"],
            directBlockIds: [],
            compressedTokens: 13,
        });
    }
    const meta = { protocol: "anthropic", upstreamOrigin: "test" };
    const parent = {
        id: "parent-6122",
        meta,
        blockContents: new Map(),
        state: { blocks, tokenSnapshot: {}, nextBlockId: blocks.length + 1, nextRunId: 1, messageRefs: { byRaw, byRef }, tsStamps },
    } as unknown as Session;
    const child = {
        id: "child-6122",
        meta,
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    return { parsed, parent, child };
}

test("#6122: the inherited line names the straddled active blocks", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, parent, child } = fixtures(true);
    const lines: string[] = [];
    const outcome = maybeAdoptResume({
        session: child,
        parent,
        sharedDepth: 0,
        protocol: "anthropic",
        parsed,
        upstreamOrigin: "test",
        blocksEnabled: true,
        log: (_level, msg) => { lines.push(msg); },
    });
    const adoptLine = lines.find((l) => l.includes("inherited"));
    assert.ok(adoptLine, "the inherited line was logged");
    assert.equal(outcome.adoptedActive, 1, "only the fully-present block is adopted");
    assert.ok(
        adoptLine.includes("1 active block(s) straddled the fork point"),
        `the straddled count must appear on the inherited line, got: ${adoptLine}`,
    );
});

test("#6122: nothing straddling → the line keeps its pre-#6122 wording", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, parent, child } = fixtures(false);
    const lines: string[] = [];
    maybeAdoptResume({
        session: child,
        parent,
        sharedDepth: 0,
        protocol: "anthropic",
        parsed,
        upstreamOrigin: "test",
        blocksEnabled: true,
        log: (_level, msg) => { lines.push(msg); },
    });
    const adoptLine = lines.find((l) => l.includes("inherited"));
    assert.ok(adoptLine, "the inherited line was logged");
    assert.ok(!adoptLine.includes("straddled"), `no straddle, no clause — got: ${adoptLine}`);
});
