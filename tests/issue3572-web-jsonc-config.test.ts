import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleConfigGet, handleConfigPut } from "../src/web/api.js";
import { rmrf } from "./tmp-rm.ts";

// #3572 web facet: the runtime loader (loadConfigFile) now accepts JSONC for bili's own
// config file. The web editor must agree — otherwise a config that WORKS at runtime shows
// "not valid JSON" here and blocks every PUT. These tests pin that the web surface parses
// identically AND that the data-safety guard (a genuinely broken file still blocks PUT) is
// preserved — tolerance loosened formatting, never the guard.
function withRawConfig(t: test.TestContext, rawText: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-web-jsonc-"));
    const p = path.join(dir, "billion-context.json");
    writeFileSync(p, rawText, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = p;
    t.after(() => {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    });
    return p;
}

async function getConfig(): Promise<{ status: number; payload: Record<string, unknown> }> {
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigGet(res as unknown as ServerResponse);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

async function putConfig(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
    const req = new Readable({ read() {} });
    req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
    let status = 0;
    let payloadText = "";
    const res = {
        writeHead(s: number) { status = s; return this; },
        end(b?: string | Buffer) { payloadText = typeof b === "string" ? b : String(b ?? ""); },
    };
    await handleConfigPut(req as unknown as IncomingMessage, res as unknown as ServerResponse, undefined, 8787);
    return { status, payload: JSON.parse(payloadText) as Record<string, unknown> };
}

test("#3572 web: a // commented config (the documented format) shows its values and no parseError", async (t) => {
    withRawConfig(t, [
        "// upstream routing",
        "{",
        '  "upstreamProxy": "http://127.0.0.1:9999",',
        '  "providers": {',
        '    "https://example.com": { "api": "openai" },',
        "  },",
        "}",
    ].join("\n"));
    const { status, payload } = await getConfig();
    assert.equal(status, 200);
    assert.equal(payload.parseError, undefined);
    assert.equal(payload.upstreamProxy, "http://127.0.0.1:9999");
    assert.ok((payload.providers as Record<string, unknown>)["https://example.com"]);
});

test("#3572 web: PUT against a JSONC config is NOT blocked (guard only fires on real syntax errors)", async (t) => {
    const p = withRawConfig(t, "// leading comment\n{\n  \"upstreamProxy\": null,\n}\n");
    const { status } = await putConfig({ upstreamProxy: "http://127.0.0.1:8888" });
    assert.equal(status, 200);
    const saved = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    assert.equal(saved.upstreamProxy, "http://127.0.0.1:8888");
});

test("#3572 web: a genuinely broken file STILL blocks PUT (409) and shows parseError — guard not over-loosened", async (t) => {
    withRawConfig(t, '{"upstreamProxy": "http://x"');
    const g = await getConfig();
    assert.ok(g.payload.parseError, "GET should surface parseError for a broken file");
    const { status, payload } = await putConfig({ upstreamProxy: "http://127.0.0.1:8888" });
    assert.equal(status, 409);
    assert.match(String(payload.error ?? ""), /refusing to overwrite/);
});

test("#3572 web: pasting JSONC into the raw-config save is accepted and normalized to strict JSON", async (t) => {
    const p = withRawConfig(t, "{}");
    const { status } = await putConfig({ file: "// note\n{ \"upstreamProxy\": \"http://127.0.0.1:7777\", }\n" });
    assert.equal(status, 200);
    const savedRaw = readFileSync(p, "utf8");
    const saved = JSON.parse(savedRaw) as Record<string, unknown>;
    assert.equal(saved.upstreamProxy, "http://127.0.0.1:7777");
    assert.ok(!savedRaw.includes("// note"), "the pasted comment is dropped on save (re-serialized)");
});

test("#3572 web: pasting a genuinely broken raw config is rejected (400)", async (t) => {
    withRawConfig(t, "{}");
    const { status } = await putConfig({ file: '{"upstreamProxy": "http://x"' });
    assert.equal(status, 400);
});
