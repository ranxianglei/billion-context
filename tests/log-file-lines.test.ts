import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readLogFileLines, readLogLines, readLogTail } from "../src/log-file-lines.ts";

function withDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
    return async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "log-lines-"));
        try {
            await fn(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
}

async function take(iter: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const line of iter) out.push(line);
    return out;
}

test("reads complete lines, including a trailing partial line being appended", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    // No trailing newline: the active file is mid-append, and dropping the
    // half-written line would lose the newest evidence.
    writeFileSync(file, "a\nb\nc");
    assert.deepEqual(await take(readLogFileLines(file)), ["a", "b", "c"]);
}));

test("decoder-end bytes after a newline are not silently dropped", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    writeFileSync(file, Buffer.from([0x61, 0x0a, 0xe4]));
    assert.deepEqual(await take(readLogFileLines(file)), ["a", "\uFFFD"]);
}));

test("empty lines are dropped by default and kept on request", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    writeFileSync(file, "a\n\nb\n\n");
    assert.deepEqual(await take(readLogFileLines(file)), ["a", "b"]);
    assert.deepEqual(await take(readLogFileLines(file, { skipEmpty: false })), ["a", "", "b", ""]);
}));

test("a multibyte character split across the read boundary is reassembled", withDir(async (dir) => {
    // 64 KiB is the read chunk; place a CJK character so its bytes straddle it.
    const file = path.join(dir, "bili.log");
    const prefix = "x".repeat(64 * 1024 - 1);
    writeFileSync(file, `${prefix}中\nsecond\n`);
    const lines = await take(readLogFileLines(file));
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${prefix}中`);
    assert.equal(lines[1], "second");
    assert.ok(!lines[0]!.includes("\uFFFD"), "no replacement char: the multi-byte sequence was not split");
}));

test("a very long line is delivered whole, never truncated", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    const long = "L".repeat(200_000);
    writeFileSync(file, `${long}\nshort\n`);
    const lines = await take(readLogFileLines(file));
    assert.equal(lines[0], long, "line content is preserved byte-for-byte");
    assert.equal(lines[0]!.length, 200_000);
    assert.equal(lines[1], "short");
}));

test("files stream in the given order without being concatenated", withDir(async (dir) => {
    const a = path.join(dir, "a.log");
    const b = path.join(dir, "b.log");
    writeFileSync(a, "a1\na2\n");
    writeFileSync(b, "b1\n");
    assert.deepEqual(await take(readLogLines([a, b])), ["a1", "a2", "b1"]);
}));

test("an unreadable file is reported through onError and skipped, not silently dropped", withDir(async (dir) => {
    const present = path.join(dir, "present.log");
    const missing = path.join(dir, "gone.log");
    writeFileSync(present, "kept\n");
    const errors: string[] = [];
    const lines = await take(readLogLines([missing, present], { onError: (f) => errors.push(f) }));
    assert.deepEqual(errors, [missing], "the missing generation surfaces");
    assert.deepEqual(lines, ["kept"], "the readable one still answers");
}));

test("breaking out early closes the stream and stops reading", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n"));
    const seen: string[] = [];
    for await (const line of readLogFileLines(file)) {
        seen.push(line);
        if (seen.length === 3) break;
    }
    assert.deepEqual(seen, ["line-0", "line-1", "line-2"], "the generator stops at the break");
}));

test("readLogTail keeps the newest rows of a selection in one pass", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    writeFileSync(file, ["keep-1", "drop", "keep-2", "drop", "keep-3"].join("\n"));
    const tail = await readLogTail([file], 2, (l) => l.startsWith("keep-"));
    assert.deepEqual(tail, ["keep-2", "keep-3"], "newest two selected rows, oldest-first");
}));

test("readLogTail returns every selected row when the cap exceeds the matches", withDir(async (dir) => {
    const file = path.join(dir, "bili.log");
    writeFileSync(file, ["m1", "x", "m2"].join("\n"));
    assert.deepEqual(await readLogTail([file], 10, (l) => l.startsWith("m")), ["m1", "m2"]);
}));
