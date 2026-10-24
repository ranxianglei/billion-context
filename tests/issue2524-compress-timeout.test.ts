// #2524: configurable hard timeout for the compress tool call. The agent-side
// extension (shared.forwardTool) already capped every forwarded tool at a
// fixed 60 s backstop with no way to raise or remove it; this pins the new
// `compress.timeoutSeconds` knob end to end: config parsing/validation, the
// live file-reading resolver (tri-state: unset → built-in backstop, 0/null →
// no cap, >0 → cap in seconds), and forwardTool's behavior against a real
// local HTTP server (cap fires before a slow response; non-compress tools
// keep the fixed backstop; disabled cap waits out the slow response).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseCompressSettings } from "../src/config.ts";
import { configuredCompressTimeoutSeconds, forwardTool } from "../src/agent/shared.ts";

describe("#2524: parseCompressSettings accepts compress.timeoutSeconds", () => {
    it("positive number round-trips", () => {
        const p = parseCompressSettings({ timeoutSeconds: 60 });
        assert.equal(p?.timeoutSeconds, 60);
    });
    it("0 round-trips (explicit disable)", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: 0 })?.timeoutSeconds, 0);
    });
    it("null round-trips (explicit disable)", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: null })?.timeoutSeconds, null);
    });
    it("fractional seconds are accepted (sub-second caps)", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: 0.2 })?.timeoutSeconds, 0.2);
    });
    it("negative number rejects the whole section", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: -1 }), undefined);
    });
    it("non-number rejects the whole section", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: "abc" }), undefined);
    });
    it("NaN / Infinity reject the whole section", () => {
        assert.equal(parseCompressSettings({ timeoutSeconds: Number.NaN }), undefined);
        assert.equal(parseCompressSettings({ timeoutSeconds: Number.POSITIVE_INFINITY }), undefined);
    });
    it("coexists with other fields without dropping them", () => {
        const p = parseCompressSettings({ tiers: false, nudgeGrowthTokens: 70000, timeoutSeconds: 30 });
        assert.equal(p?.tiers, false);
        assert.equal(p?.nudgeGrowthTokens, 70000);
        assert.equal(p?.timeoutSeconds, 30);
    });
    it("absent key leaves timeoutSeconds undefined", () => {
        const p = parseCompressSettings({ tiers: true });
        assert.ok(p !== undefined);
        assert.equal(p.timeoutSeconds, undefined);
    });
});

describe("#2524: configuredCompressTimeoutSeconds reads the global file live", () => {
    let dir: string;
    let file: string;
    let prevEnv: string | undefined;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue2524-"));
        file = path.join(dir, "billion-context.json");
        prevEnv = process.env.BILI_CONFIG_FILE;
        process.env.BILI_CONFIG_FILE = file;
    });

    afterEach(() => {
        if (prevEnv === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeConfig(text: string): void {
        fs.writeFileSync(file, text, "utf8");
    }

    it("returns the configured positive value", () => {
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: 90 } }));
        assert.equal(configuredCompressTimeoutSeconds(), 90);
    });
    it("returns 0 for explicit disable", () => {
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: 0 } }));
        assert.equal(configuredCompressTimeoutSeconds(), 0);
    });
    it("returns null for explicit disable via null", () => {
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: null } }));
        assert.equal(configuredCompressTimeoutSeconds(), null);
    });
    it("undefined when the key is absent", () => {
        writeConfig(JSON.stringify({ compress: { nudgeGrowthTokens: 70000 } }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("undefined when the compress block is absent", () => {
        writeConfig(JSON.stringify({ port: 8787 }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("undefined when the file does not exist", () => {
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("undefined on malformed JSON (never throws)", () => {
        writeConfig("{ not json");
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("undefined on invalid values (mirrors parseCompressSettings)", () => {
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: -5 } }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
        fs.unlinkSync(file);
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: "fast" } }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("ignores a misplaced top-level timeoutSeconds", () => {
        writeConfig(JSON.stringify({ timeoutSeconds: 5 }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("ignores provider-level values (global level only)", () => {
        writeConfig(JSON.stringify({ providers: { "https://x.example": { compress: { timeoutSeconds: 5 } } } }));
        assert.equal(configuredCompressTimeoutSeconds(), undefined);
    });
    it("survives a UTF-8 BOM (Windows Notepad saves)", () => {
        writeConfig("\uFEFF" + JSON.stringify({ compress: { timeoutSeconds: 45 } }));
        assert.equal(configuredCompressTimeoutSeconds(), 45);
    });
    it("re-reads the file on every call (live reload, no restart)", () => {
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: 30 } }));
        assert.equal(configuredCompressTimeoutSeconds(), 30);
        writeConfig(JSON.stringify({ compress: { timeoutSeconds: 120 } }));
        assert.equal(configuredCompressTimeoutSeconds(), 120);
    });
});

describe("#2524: forwardTool enforces the cap for compress only", () => {
    let server: http.Server | null = null;
    let origin = "";
    let dir: string;
    let file: string;
    let prevEnv: string | undefined;
    let respondAfterMs = 0;
    let requests = 0;

    before(async () => {
        server = http.createServer((req, res) => {
            if (req.url !== "/__bili/plugin/tool") { res.writeHead(404).end("nope"); return; }
            let raw = "";
            req.on("data", (d) => { raw += d; });
            req.on("end", () => {
                requests++;
                const parsed = JSON.parse(raw) as { tool?: string };
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
                    ok: true,
                    result: parsed.tool === "compress" ? "[Compressed m00001–m00002 → 1 block(s)]" : "STATUS",
                    outcome: parsed.tool === "compress" ? "applied" : "success",
                }));
            });
        });
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
        const addr = server.address();
        origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    });

    after(async () => {
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        server = null;
    });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue2524-fwd-"));
        file = path.join(dir, "billion-context.json");
        prevEnv = process.env.BILI_CONFIG_FILE;
        process.env.BILI_CONFIG_FILE = file;
        respondAfterMs = 0;
        requests = 0;
    });

    afterEach(() => {
        if (prevEnv === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("configured cap aborts a stuck compress before the (slow) response arrives", async () => {
        const slowServer = http.createServer((req, res) => {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: "late", outcome: "applied" }));
            }, 500);
        });
        await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", () => r()));
        const saddr = slowServer.address();
        const slowOrigin = `http://127.0.0.1:${typeof saddr === "object" && saddr ? saddr.port : 0}`;
        try {
            fs.writeFileSync(file, JSON.stringify({ compress: { timeoutSeconds: 0.2 } }), "utf8");
            const started = Date.now();
            await assert.rejects(
                () => forwardTool(slowOrigin, "t-2524-cap", "compress", {}),
                (err: unknown) => err instanceof Error && /timeout after 200ms \(compress\.timeoutSeconds\)/.test(err.message),
            );
            // The cap fired at ~200 ms, not at the response's 500 ms.
            assert.ok(Date.now() - started < 480, `cap did not fire early (${Date.now() - started}ms)`);
        } finally {
            await new Promise<void>((r) => slowServer.close(() => r()));
        }
    });

    it("the cap applies to compress only — acp_status keeps the fixed backstop", async () => {
        const slowServer = http.createServer((req, res) => {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: "STATUS", outcome: "success" }));
            }, 300);
        });
        await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", () => r()));
        const saddr = slowServer.address();
        const slowOrigin = `http://127.0.0.1:${typeof saddr === "object" && saddr ? saddr.port : 0}`;
        try {
            fs.writeFileSync(file, JSON.stringify({ compress: { timeoutSeconds: 0.2 } }), "utf8");
            const out = await forwardTool(slowOrigin, "t-2524-other", "acp_status", {});
            assert.equal(out.failed, false);
            assert.equal(out.text, "STATUS");
        } finally {
            await new Promise<void>((r) => slowServer.close(() => r()));
        }
    });

    it("timeoutSeconds: 0 disables the cap entirely (slow compress still completes)", async () => {
        const slowServer = http.createServer((req, res) => {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: "[Compressed]", outcome: "applied" }));
            }, 300);
        });
        await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", () => r()));
        const saddr = slowServer.address();
        const slowOrigin = `http://127.0.0.1:${typeof saddr === "object" && saddr ? saddr.port : 0}`;
        try {
            fs.writeFileSync(file, JSON.stringify({ compress: { timeoutSeconds: 0 } }), "utf8");
            const out = await forwardTool(slowOrigin, "t-2524-nocap", "compress", {});
            assert.equal(out.failed, false);
            assert.equal(out.text, "[Compressed]");
        } finally {
            await new Promise<void>((r) => slowServer.close(() => r()));
        }
    });

    it("unset config keeps today's behavior (no premature abort of a fast call)", async () => {
        fs.writeFileSync(file, JSON.stringify({ compress: { tiers: true } }), "utf8");
        const out = await forwardTool(origin, "t-2524-default", "compress", {});
        assert.equal(out.failed, false);
        assert.match(out.text, /^\[Compressed/);
        assert.equal(requests, 1);
    });

    it("host abort still wins while the cap is disabled", async () => {
        const slowServer = http.createServer((_req, _res) => { /* never answers */ });
        await new Promise<void>((r) => slowServer.listen(0, "127.0.0.1", () => r()));
        const saddr = slowServer.address();
        const slowOrigin = `http://127.0.0.1:${typeof saddr === "object" && saddr ? saddr.port : 0}`;
        try {
            fs.writeFileSync(file, JSON.stringify({ compress: { timeoutSeconds: 0 } }), "utf8");
            const ac = new AbortController();
            ac.abort();
            await assert.rejects(
                () => forwardTool(slowOrigin, "t-2524-abort", "compress", {}, ac.signal),
                (err: unknown) => err instanceof Error && /abort/i.test(`${err.name} ${err.message}`),
            );
        } finally {
            await new Promise<void>((r) => slowServer.close(() => r()));
        }
    });
});
