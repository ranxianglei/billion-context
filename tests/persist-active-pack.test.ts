import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream", activePack: "lean" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("meta.activePack survives a persist/reload round-trip (#1724)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-activepack-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s = makeSession("sess-pack");
        await store.writeNow(s);
        const reloaded = store.loadSync("sess-pack", { protocol: "openai", upstreamOrigin: "http://upstream" });
        assert.ok(reloaded);
        assert.equal(reloaded.meta.activePack, "lean", "reader restores the pack buildRecord already persists via spread");
        store.cancelAll();
    } finally {
        rmrf(dir);
    }
});
