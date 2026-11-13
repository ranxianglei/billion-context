import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { CoreMessage } from "acp-kernel";

// #4910 (P2, unified-storage lineage): a plugin-fork child is cloned into the
// unified store WITH lineage (cloneSessionRows writes parent_session_id /
// fork_point_seq), but the child's FIRST ordinary save then nulls both columns
// out. Ingest derives lineage only from metadata.derivedFromSessionId — which
// the wire-probe fork path writes and the plugin-fork path does not (it writes
// parentConversationId only). The upsert therefore wrote NULL over the clone's
// lineage and the child became an orphan in every parent/child query.
// The fix keeps the stored value when the plan carries no lineage of its own
// (existing-first on both backends); an established clone pair is immutable.

function msg(id: string, role: "user" | "assistant"): CoreMessage {
    return { id, role, contentType: "text", text: `body ${id}` };
}

function session(id: string, tail: CoreMessage[], derivedFrom?: string): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: {},
        metadata: derivedFrom === undefined ? {} : { derivedFromSessionId: derivedFrom },
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw, byRef } },
        blockContents: new Map(),
        lastMessages: tail,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-4910-fork-lineage-"));
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handle */ }
}

test("#4910: the fork child's first save keeps the lineage the clone wrote", () => {
    const dir = tmpDir();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const parent = "sess-4910-parent";
        const child = "sess-4910-child";
        const full = ["f_a", "f_b", "f_c", "f_d"].map((id, i) => msg(id, i % 2 ? "assistant" : "user"));
        store.ingestSession(planIngest(session(parent, full)));

        const throughSeq = store.lastLiveSeq(parent)!;
        store.cloneSessionRows(parent, child, throughSeq);
        const cloned = store.getSessionRow(child)!;
        assert.equal(cloned.parentSessionId, parent, "fixture sanity: the clone wrote the parent link");
        assert.equal(cloned.forkPointSeq, throughSeq, "fixture sanity: the clone wrote the fork point");

        // The plugin-fork child's own save: no derivedFromSessionId in its
        // metadata, so the plan carries no lineage — exactly the shape that
        // used to null the columns out.
        store.ingestSession(planIngest(session(child, full)));

        const saved = store.getSessionRow(child)!;
        assert.equal(saved.parentSessionId, parent, "the first save must not orphan the fork child");
        assert.equal(saved.forkPointSeq, throughSeq, "fork_point_seq survives the same save");
        assert.deepEqual(
            store.getMessages(child).map((m) => m.msgId).sort(),
            ["f_a", "f_b", "f_c", "f_d"],
            "control: the save still ingests the child's rows",
        );

        // Second save and a full-log sweep: still no clobber (idempotent).
        store.ingestSession(planIngest(session(child, full)), undefined, { completeLog: true });
        assert.equal(store.getSessionRow(child)!.parentSessionId, parent, "completeLog sweeps keep the lineage too");
        assert.equal(store.getSessionRow(child)!.forkPointSeq, throughSeq, "completeLog sweeps keep the fork point");

        // Negative control 1: a session that never had lineage stays null —
        // COALESCE must not invent a parent from nowhere.
        const plain = "sess-4910-plain";
        store.ingestSession(planIngest(session(plain, full)));
        assert.equal(store.getSessionRow(plain)!.parentSessionId, null, "no lineage stays null");
        assert.equal(store.getSessionRow(plain)!.forkPointSeq, null, "no fork point stays null");

        // #4982: later metadata must not reparent an established fork.
        const other = "sess-4910-other";
        const conflicting = planIngest(session(child, full, other));
        conflicting.session.forkPointSeq = throughSeq + 100;
        store.ingestSession(conflicting);
        assert.equal(store.getSessionRow(child)!.parentSessionId, parent, "established parent wins over later metadata");
        assert.equal(store.getSessionRow(child)!.forkPointSeq, throughSeq, "the original parent/fork pair stays intact");
        // A previously unparented session can establish its initial pair.
        const initial = planIngest(session(plain, full, other));
        initial.session.forkPointSeq = 123;
        store.ingestSession(initial);
        assert.equal(store.getSessionRow(plain)!.parentSessionId, other);
        assert.equal(store.getSessionRow(plain)!.forkPointSeq, 123);
        store.close();
    } finally {
        cleanup(dir);
    }
});
