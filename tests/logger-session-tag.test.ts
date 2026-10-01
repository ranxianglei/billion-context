import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLogger, closeLogger, log, enterSessionContext, currentSessionContext } from "../src/logger.ts";
import { VERSION } from "../src/version.ts";

function tmpLog(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-sesstag-"));
    return path.join(dir, "bili.log");
}
function fileLines(p: string): string[] {
    return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("logger: no session tag outside a bound flow", async () => {
    const p = tmpLog();
    configureLogger(p);
    try {
        assert.equal(currentSessionContext(), undefined);
        log("info", "untagged-baseline");
        await sleep(60); // let the stream drain to disk
        const lines = fileLines(p);
        const l = lines.find((x) => x.endsWith("untagged-baseline"));
        assert.ok(l, `baseline line missing: ${JSON.stringify(lines)}`);
        assert.match(l!, /^\S+ \[info\] \[v=[^\]]+\] untagged-baseline$/);
        assert.ok(l!.includes(`[v=${VERSION}]`), `expected exact stamp [v=${VERSION}]: ${l}`);
    } finally { closeLogger(); }
});

test("logger: enterSessionContext tags sync, microtask and timer descendants", async () => {
    const p = tmpLog();
    configureLogger(p);
    try {
        enterSessionContext("127.0.0.1_deadbeefcafe0001");
        assert.equal(currentSessionContext(), "127.0.0.1_deadbeefcafe0001");
        log("info", "sync-tagged");
        await Promise.resolve();
        log("info", "microtask-tagged");
        await new Promise<void>((r) => setTimeout(r, 20));
        log("info", "timer-descendant-tagged");
        await sleep(60);
        const lines = fileLines(p);
        for (const tag of ["sync-tagged", "microtask-tagged", "timer-descendant-tagged"]) {
            const l = lines.find((x) => x.endsWith(tag));
            assert.ok(l, `missing line ${tag}`);
            assert.match(l!, /^\S+ \[info\] \[sess=127\.0\.0\.1_deadbeefcafe0001\] \[v=[^\]]+\] .*$/);
        }
    } finally { closeLogger(); }
});

test("logger: multi-line payloads are prefixed per physical line", async () => {
    const p = tmpLog();
    configureLogger(p);
    try {
        enterSessionContext("sess-multi");
        log("warn", "frame-one\nframe-two\nframe-three");
        await sleep(60);
        const frames = fileLines(p).filter((l) => /frame-(one|two|three)$/.test(l));
        assert.equal(frames.length, 3, JSON.stringify(frames));
        for (const f of frames) {
            assert.match(f, /^\S+ \[warn\] \[sess=sess-multi\] \[v=[^\]]+\] frame-(one|two|three)$/);
        }
    } finally { closeLogger(); }
});

test("logger: tags are sanitized (whitespace/brackets/control chars, length cap)", async () => {
    const p = tmpLog();
    configureLogger(p);
    try {
        enterSessionContext("bad id [x] \ny");
        log("info", "sanitized-line");
        await sleep(40);
        let l = fileLines(p).find((x) => x.endsWith("sanitized-line"));
        assert.ok(l, "sanitized line missing");
        assert.ok(l!.includes("[sess=bad_id_x_y]"), l);
        assert.doesNotMatch(l!, /\[sess=[^\]]*[\\\s]/);

        enterSessionContext("A".repeat(300));
        log("info", "truncated-line");
        await sleep(40);
        l = fileLines(p).find((x) => x.endsWith("truncated-line"));
        const m = /\[sess=(A+)\]/.exec(l!);
        assert.ok(m, l);
        assert.ok(m![1].length > 0 && m![1].length <= 160);
    } finally { closeLogger(); }
});
