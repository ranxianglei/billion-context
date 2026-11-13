import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DUMP_PLAINTEXT_BANNER, stripDumpBanner } from "../src/dump-banner.js";
import { dumpRejectedBody, dumpSummaryRejection } from "../src/error-dump.js";
import { setLogCapture } from "../src/logger.js";
import { rmrf } from "./tmp-rm.ts";

// #762: failure-triggered dump of the exact forwarded body on upstream 4xx.

const savedGate = process.env.BILI_DUMP_4XX;
const savedCap = process.env.BILI_DUMP_4XX_MAX_BYTES;
const savedDir = process.env.ACP_DUMP_DIR;

function restoreDumpEnv(): void {
    if (savedGate === undefined) delete process.env.BILI_DUMP_4XX;
    else process.env.BILI_DUMP_4XX = savedGate;
    if (savedCap === undefined) delete process.env.BILI_DUMP_4XX_MAX_BYTES;
    else process.env.BILI_DUMP_4XX_MAX_BYTES = savedCap;
}

let dir: string;
before(() => {
    setLogCapture(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-error-dump-"));
    process.env.ACP_DUMP_DIR = dir;
});

after(() => {
    setLogCapture(null);
    restoreDumpEnv();
    if (savedDir === undefined) delete process.env.ACP_DUMP_DIR;
    else process.env.ACP_DUMP_DIR = savedDir;
    rmrf(dir);
});

function errFiles(): string[] {
    return fs.readdirSync(dir).filter((f) => f.startsWith("err-"));
}

test("off by default: no file written", () => {
    delete process.env.BILI_DUMP_4XX;
    try {
        assert.equal(dumpRejectedBody(400, "s1", '{"model":"m","messages":[]}'), null);
        assert.deepEqual(errFiles(), []);
    } finally {
        restoreDumpEnv();
    }
});

test("on: JSON body is pretty-printed and parseable", () => {
    process.env.BILI_DUMP_4XX = "1";
    try {
        const out = dumpRejectedBody(400, "s1", '{"model":"m","messages":[{"role":"user","content":"u"}]}');
        assert.ok(out && out.startsWith(dir));
        const files = errFiles();
        assert.equal(files.length, 1);
        assert.match(files[0]!, /^err-\d+-s1-400\.json$/);
        const text = fs.readFileSync(out!, "utf8");
        assert.ok(text.startsWith(`${DUMP_PLAINTEXT_BANNER}\n`), "#4482: plaintext warning banner must lead the file");
        const parsed = JSON.parse(stripDumpBanner(text)) as { model: string; messages: unknown[] };
        assert.equal(parsed.model, "m");
        assert.equal(parsed.messages.length, 1);
    } finally {
        restoreDumpEnv();
    }
});

test("on: non-JSON body passes through raw", () => {
    process.env.BILI_DUMP_4XX = "1";
    try {
        const out = dumpRejectedBody(400, "s1", "<html>bad gateway</html>");
        assert.ok(out);
        assert.equal(fs.readFileSync(out!, "utf8"), `${DUMP_PLAINTEXT_BANNER}\n<html>bad gateway</html>`);
    } finally {
        restoreDumpEnv();
    }
});

test("on: oversized body is capped with a truncation marker", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "2048";
    try {
        const raw = `{"payload":"${"x".repeat(5000)}"}`;
        const out = dumpRejectedBody(413, "s1", raw);
        assert.ok(out);
        const text = fs.readFileSync(out!, "utf8");
        assert.ok(text.length < raw.length + 100, `capped file should be smaller than raw (${text.length} vs ${raw.length})`);
        assert.match(text, /\[truncated: \d+ more character\(s\)\]/);
        assert.match(path.basename(out!), /^err-\d+-s1-413\.json$/);
    } finally {
        restoreDumpEnv();
    }
});

test("on: empty body is skipped", () => {
    process.env.BILI_DUMP_4XX = "1";
    const before = errFiles().length;
    try {
        assert.equal(dumpRejectedBody(400, "s1", ""), null);
        assert.equal(errFiles().length, before);
    } finally {
        restoreDumpEnv();
    }
});

test("on: Buffer bodies work and session ids are sanitized", () => {
    process.env.BILI_DUMP_4XX = "1";
    try {
        const out = dumpRejectedBody(400, "a/b c", Buffer.from('{"a":1}', "utf8"));
        assert.ok(out);
        assert.match(path.basename(out!), /^err-\d+-a_b_c-400\.json$/);
    } finally {
        restoreDumpEnv();
    }
});

function summaryErrFiles(): string[] {
    return fs.readdirSync(dir).filter((f) => f.startsWith("summary-err-"));
}

// #1993: the preflight summary exchange is built independently of the forwarded
// wire body, so it needs its own dump call site carrying BOTH sides.

test("#1993 summary dump off by default: no file written", () => {
    delete process.env.BILI_DUMP_4XX;
    try {
        assert.equal(dumpSummaryRejection(400, "s1", '{"instructions":"i"}', '{"error":"e"}'), null);
        assert.deepEqual(summaryErrFiles(), []);
    } finally {
        restoreDumpEnv();
    }
});

test("#1993 summary dump on: envelope carries status plus both sides as strings", () => {
    process.env.BILI_DUMP_4XX = "1";
    try {
        const out = dumpSummaryRejection(400, "s1", '{"instructions":"compress it","model":"gpt"}', '{"error":{"message":"too large"}}');
        assert.ok(out && out.startsWith(dir));
        const files = summaryErrFiles();
        assert.equal(files.length, 1);
        assert.match(files[0]!, /^summary-err-\d+-s1-400\.json$/);
        const text = fs.readFileSync(out!, "utf8");
        assert.ok(text.startsWith(`${DUMP_PLAINTEXT_BANNER}\n`), "#4482: plaintext warning banner must lead the file");
        const parsed = JSON.parse(stripDumpBanner(text)) as { status: number; request: unknown; response: unknown };
        assert.equal(parsed.status, 400);
        assert.equal(typeof parsed.request, "string");
        assert.equal(typeof parsed.response, "string");
        assert.deepEqual(JSON.parse(parsed.request as string), { instructions: "compress it", model: "gpt" });
        assert.deepEqual(JSON.parse(parsed.response as string), { error: { message: "too large" } });
    } finally {
        restoreDumpEnv();
    }
});

test("#1993 summary dump on: non-JSON sides stay raw, oversized side is capped", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "2048";
    try {
        const out = dumpSummaryRejection(413, "s1", "<html>req</html>", "x".repeat(5000));
        assert.ok(out);
        const text = fs.readFileSync(out!, "utf8");
        assert.match(text, /\[truncated: \d+ more character\(s\)\]/);
        assert.ok(text.length < 2048 * 3 + 512, `capped file should be far smaller than raw (${text.length})`);
        const parsed = JSON.parse(stripDumpBanner(text)) as { request: unknown; response: unknown };
        assert.equal(parsed.request, "<html>req</html>");
        assert.ok(typeof parsed.response === "string" && (parsed.response as string).includes("[truncated:"));
    } finally {
        restoreDumpEnv();
    }
});

test("#1993 summary dump on: empty exchange is skipped", () => {
    process.env.BILI_DUMP_4XX = "1";
    const before = summaryErrFiles().length;
    try {
        assert.equal(dumpSummaryRejection(400, "s1", "", ""), null);
        assert.equal(summaryErrFiles().length, before);
    } finally {
        restoreDumpEnv();
    }
});

test("#4297 main dump enforces final UTF-8 bytes including markers and pretty printing", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "1024";
    const bodies = [
        "x".repeat(1025),
        "汉".repeat(1000),
        "😀".repeat(600),
        JSON.stringify(Array.from({ length: 120 }, () => ({ a: 1 }))),
        Buffer.from("汉😀".repeat(700)),
    ];
    try {
        for (const [i, body] of bodies.entries()) {
            const out = dumpRejectedBody(413, `bytes-${i}`, body);
            assert.ok(out);
            assert.ok(fs.statSync(out).size <= 1024, `${i}: ${fs.statSync(out).size} bytes`);
            const text = fs.readFileSync(out, "utf8");
            assert.match(text, /\[truncated: \d+ more character\(s\)\]/);
            assert.ok(!text.includes("\uFFFD"), "do not split a Unicode code point");
        }
    } finally { restoreDumpEnv(); }
});

test("#4297 main dump preserves bodies that fit exactly at the byte limit", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "1024";
    // #4482: the banner line rides along, so the body budget is the knob minus it.
    const budget = 1024 - Buffer.byteLength(DUMP_PLAINTEXT_BANNER) - 1;
    try {
        for (const raw of ["x".repeat(budget), "汉".repeat(Math.floor((budget - 4) / 3)) + "😀", "small raw body"]) {
            const out = dumpRejectedBody(400, "boundary", raw);
            assert.ok(out);
            assert.equal(stripDumpBanner(fs.readFileSync(out, "utf8")), raw);
        }
    } finally { restoreDumpEnv(); }
});

test("#4297 summary cap covers both sides, JSON escaping and envelope bytes", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "1024";
    const pairs: [string, string][] = [
        ["short request", "汉😀".repeat(1000)],
        ["汉😀".repeat(1000), "short response"],
        ["a".repeat(2000), "b".repeat(2000)],
        ["\u0000\n\"\\".repeat(500), "\t\r".repeat(500)],
        [JSON.stringify({ body: "汉😀".repeat(500) }), JSON.stringify({ error: "\"\\".repeat(500) })],
    ];
    try {
        for (const [i, [request, response]] of pairs.entries()) {
            const out = dumpSummaryRejection(413, `summary-bytes-${i}`, request, response);
            assert.ok(out);
            assert.ok(fs.statSync(out).size <= 1024, `${i}: ${fs.statSync(out).size} bytes`);
            const parsed = JSON.parse(stripDumpBanner(fs.readFileSync(out, "utf8"))) as { status: number; request: string; response: string };
            assert.equal(parsed.status, 413);
            assert.equal(typeof parsed.request, "string");
            assert.equal(typeof parsed.response, "string");
            assert.match(parsed.request + parsed.response, /\[truncated: \d+ more character\(s\)\]/);
            assert.ok(!parsed.request.includes("\uFFFD") && !parsed.response.includes("\uFFFD"));
            if (i === 0) assert.equal(parsed.request, request);
            if (i === 1) assert.equal(parsed.response, response);
        }
    } finally { restoreDumpEnv(); }
});

test("#4297 summary exact byte boundary stays complete; one more byte truncates valid JSON", () => {
    process.env.BILI_DUMP_4XX = "1";
    process.env.BILI_DUMP_4XX_MAX_BYTES = "1024";
    const overhead = Buffer.byteLength(JSON.stringify({ status: 400, request: "", response: "" }, null, 2))
        + Buffer.byteLength(DUMP_PLAINTEXT_BANNER) + 1; // #4482 banner shares the cap
    const exact = "x".repeat(1024 - overhead);
    try {
        for (const request of [exact, exact + "x"]) {
            const out = dumpSummaryRejection(400, "summary-boundary", request, "");
            assert.ok(out);
            const parsed = JSON.parse(stripDumpBanner(fs.readFileSync(out, "utf8"))) as { request: string; response: string };
            assert.ok(fs.statSync(out).size <= 1024);
            assert.equal(parsed.response, "");
            if (request === exact) assert.equal(parsed.request, exact);
            else assert.match(parsed.request, /\[truncated:/);
        }
    } finally { restoreDumpEnv(); }
});
