import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
} from "../src/compress-tool.js";
import { checkForUpdate } from "../src/update.js";

const REPO_VERSION = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

const ERROR_LINE = 'TypeError: tools.acp_status is not a function';

test("all compress prompts warn against calling ACP tools inside the exec sandbox", () => {
    const prompts = [
        ["function", buildCompressSystemPrompt()],
        ["text", buildCompressTextSystemPrompt()],
        ["hybrid", buildCompressHybridSystemPrompt()],
    ] as const;
    for (const [name, prompt] of prompts) {
        assert.ok(prompt.includes("code-execution sandbox"), `${name} prompt should name the sandbox`);
        assert.ok(prompt.includes(ERROR_LINE), `${name} prompt should quote the exact TypeError`);
        assert.ok(/NEVER attempt that/i.test(prompt) || /Never attempt that/i.test(prompt), `${name} prompt should forbid the sandbox call`);
    }
});

test("function-mode prompt states ACP tools are top-level function calls", () => {
    const prompt = buildCompressSystemPrompt();
    assert.ok(prompt.includes("TOP-LEVEL function calls"));
});

test("marker-mode prompts point back to markers/function calls as the alternative", () => {
    assert.ok(buildCompressTextSystemPrompt().includes("emit the text markers instead"));
    assert.ok(buildCompressHybridSystemPrompt().includes("call the function tools directly"));
});

test("checkForUpdate warns restart-pending exactly once when installed is newer than running", async () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: Uint8Array | string) => {
        lines.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ version: REPO_VERSION.version, dist: { tarball: "https://example.invalid/x.tgz" } }),
    })) as typeof fetch;
    try {
        const opts = { packageName: "billion-context", currentVersion: "0.0.1", autoUpdate: true };
        await checkForUpdate(opts, true);
        await checkForUpdate(opts, true);
    } finally {
        globalThis.fetch = origFetch;
        process.stderr.write = origWrite;
    }
    const nags = lines.filter((l) => l.includes("[update] restart pending"));
    assert.equal(
        nags.length,
        1,
        `expected exactly one restart-pending warn, got update lines: ${lines.filter((l) => l.includes("[update]")).join(" | ")}`,
    );
    assert.ok(nags[0].includes(`running 0.0.1 but ${REPO_VERSION.version} is installed`));
    assert.ok(nags[0].includes("RESTART"));
});
