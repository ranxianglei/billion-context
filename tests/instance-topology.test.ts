import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerInstanceAndWarn, warnOnNewPeers } from "../src/instance.ts";

// A caller with only the fallback sink must still receive the known-separated
// topology, not the shared-directory conflict branch. Exercise both discovery
// paths against real isolated registry files; do not pin advisory prose.
test("known-separated peer paths survive registration and rescan without an info sink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-topology-"));
    const previousState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    const ours = path.join(root, "sessions-a");
    const theirs = path.join(root, "sessions-b");
    const notices: string[] = [];
    const sink = (notice: string): void => { notices.push(notice); };
    try {
        registerInstanceAndWarn({ instanceId: "first", pid: process.pid, port: 1,
            origin: "http://127.0.0.1:1", startedAt: 1, sessionsDir: ours }, sink);
        assert.equal(notices.length, 0);
        const peers = registerInstanceAndWarn({ instanceId: "second", pid: process.pid, port: 2,
            origin: "http://127.0.0.1:2", startedAt: 2, sessionsDir: theirs }, sink);
        assert.deepEqual(peers, ["first"]);
        assert.equal(notices.length, 1);
        assert.ok(notices[0]!.includes(ours));
        assert.ok(notices[0]!.includes(theirs));

        const late = warnOnNewPeers({ instanceId: "first", sessionsDir: ours }, new Set(), sink);
        assert.deepEqual(late, ["second"]);
        assert.equal(notices.length, 2);
        assert.ok(notices[1]!.includes(ours));
        assert.ok(notices[1]!.includes(theirs));
        assert.deepEqual(warnOnNewPeers({ instanceId: "first", sessionsDir: ours }, new Set(late), sink), []);
        assert.equal(notices.length, 2);
    } finally {
        if (previousState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousState;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
