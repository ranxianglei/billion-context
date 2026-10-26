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

/** Poll until pred(lines) holds or timeoutMs elapses (#1971): the logger's
 *  file stream is buffered/async, so a fixed sleep raced loaded CI runners.
 *  ENOENT = open still in flight. On timeout returns what landed, so the
 *  caller's assert fails with evidence instead of a silent timing artifact. */
async function waitForLogLines(p: string, pred: (lines: string[]) => boolean, timeoutMs = 5000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let lines: string[] = [];
    for (;;) {
        try { lines = fileLines(p); } catch { lines = []; }
        if (pred(lines)) return lines;
        if (Date.now() >= deadline) return lines;
        await sleep(20);
    }
}

test("logger: no session tag outside a bound flow", async () => {
    const p = tmpLog();
    configureLogger(p);
    try {
        assert.equal(currentSessionContext(), undefined);
        log("info", "untagged-baseline");
        const lines = await waitForLogLines(p, (ls) => ls.some((x) => x.endsWith("untagged-baseline")));
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
        const tags = ["sync-tagged", "microtask-tagged", "timer-descendant-tagged"];
        enterSessionContext("127.0.0.1_deadbeefcafe0001");
        assert.equal(currentSessionContext(), "127.0.0.1_deadbeefcafe0001");
        log("info", "sync-tagged");
        await Promise.resolve();
        log("info", "microtask-tagged");
        await new Promise<void>((r) => setTimeout(r, 20));
        log("info", "timer-descendant-tagged");
        const lines = await waitForLogLines(p, (ls) => tags.every((t) => ls.some((x) => x.endsWith(t))));
        for (const tag of tags) {
            const l = lines.find((x) => x.endsWith(tag));
            assert.ok(l, `missing line ${tag}: ${JSON.stringify(lines)}`);
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
        const frameRe = /frame-(one|two|three)$/;
        const lines = await waitForLogLines(p, (ls) => ls.filter((l) => frameRe.test(l)).length === 3);
        const frames = lines.filter((l) => frameRe.test(l));
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
        let lines = await waitForLogLines(p, (ls) => ls.some((x) => x.endsWith("sanitized-line")));
        let l = lines.find((x) => x.endsWith("sanitized-line"));
        assert.ok(l, `sanitized line missing: ${JSON.stringify(lines)}`);
        assert.ok(l!.includes("[sess=bad_id_x_y]"), l);
        assert.doesNotMatch(l!, /\[sess=[^\]]*[\\\s]/);

        enterSessionContext("A".repeat(300));
        log("info", "truncated-line");
        lines = await waitForLogLines(p, (ls) => ls.some((x) => x.endsWith("truncated-line")));
        l = lines.find((x) => x.endsWith("truncated-line"));
        assert.ok(l, `truncated line missing: ${JSON.stringify(lines)}`);
        const m = /\[sess=(A+)\]/.exec(l!);
        assert.ok(m, l);
        assert.ok(m![1].length > 0 && m![1].length <= 160);
    } finally { closeLogger(); }
});
