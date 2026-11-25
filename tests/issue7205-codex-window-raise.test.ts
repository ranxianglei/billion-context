import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// #7205: bili CLAMPED a codex session to its own model knowledge but never
// RAISED it. Incident: an anonymous alias (`codex-auto-review`) matched no
// window source in the native ladder, so bili kept its generic 200K anonymous
// default — while bili's own codex-fallback path knew the model accepts 272K.
// Every payload between 200K and 272K died on bili's LOCAL 413 wall below the
// point the model actually accepts. Fix: when bili's number came from a
// generic fallback (handle.ts passes `nativeFromFallback`), codex model
// knowledge may raise it. Client-declared windows are NEVER raised (the
// client's own declaration is authoritative), clamping always wins, and with
// canRaise off (the default) behavior is byte-identical to before.

const originalHome = process.env.CODEX_HOME;
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-7205-"));
process.env.CODEX_HOME = codexHome;
after(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
});

import {
    _resetCodexTableForTest,
    codexAlignedWindow,
    isCodexClient,
} from "../src/codex-models.ts";

_resetCodexTableForTest();

const CODEX_UA = "codex_cli_rs/0.53.0 (linux 6.8.0; x86_64) cli";
const codex = { "user-agent": CODEX_UA };

test("#7205: non-codex client untouched even with canRaise", () => {
    // The whole alignment only ever applies to codex's own client.
    assert.deepEqual(
        codexAlignedWindow(200_000, "gpt-5.5", { "user-agent": "node-fetch/3.1" }, undefined, true),
        { limit: 200_000, clamped: false },
    );
});

test("#7205: codex client WITHOUT canRaise keeps its limit (default-off pin)", () => {
    // Pre-#7205 behavior: bili below codex's perception stays untouched.
    assert.deepEqual(
        codexAlignedWindow(200_000, "gpt-5.5", codex),
        { limit: 200_000, clamped: false, source: "bundled-snapshot" },
    );
});

test("#7205: canRaise lifts a fallback-sized session to the bundled snapshot", () => {
    // The incident shape: anonymous 200K default vs gpt-5.5's known 272K.
    assert.deepEqual(
        codexAlignedWindow(200_000, "gpt-5.5", codex, undefined, true),
        { limit: 272_000, clamped: false, raised: true, source: "bundled-snapshot" },
    );
});

test("#7205: canRaise lifts to the flat 272K fallback for an unknown slug", () => {
    // A slug no table knows → codex-fallback's flat 272K. (NOT "codex-auto-review"
    // — longestPrefixMatch resolves it against the bundled table.)
    assert.deepEqual(
        codexAlignedWindow(200_000, "totally-unknown-model-xyz", codex, undefined, true),
        { limit: 272_000, clamped: false, raised: true, source: "codex-fallback" },
    );
});

test("#7205: clamp still wins when bili is ABOVE codex's perception", () => {
    assert.deepEqual(
        codexAlignedWindow(400_000, "gpt-5.5", codex, undefined, true),
        { limit: 272_000, clamped: true, source: "bundled-snapshot" },
    );
});

test("#7205: client-declared window is NEVER raised", () => {
    // The client told bili its own window — that declaration is authoritative
    // even when bili's model knowledge says the model accepts more.
    assert.deepEqual(
        codexAlignedWindow(100_000, "gpt-5.5", codex, 150_000, true),
        { limit: 100_000, clamped: false, source: "client-metadata" },
    );
    // ...and still clamps when the client declaration exceeds perception.
    assert.deepEqual(
        codexAlignedWindow(200_000, "gpt-5.5", codex, 150_000, true),
        { limit: 150_000, clamped: true, source: "client-metadata" },
    );
});

test("#7205: shipped-snapshot sentinel lifts 200K → 372K", () => {
    assert.deepEqual(
        codexAlignedWindow(200_000, "gpt-daybreak-red-latest", codex, undefined, true),
        { limit: 372_000, clamped: false, raised: true, source: "bundled-snapshot" },
    );
});

test("#7205: isCodexClient accepts the codex_exec / codex_sdk_ts prefixes", () => {
    assert.equal(isCodexClient({ "user-agent": "codex_exec/0.53.0" }), true);
    assert.equal(isCodexClient({ "user-agent": "codex_sdk_ts/1.2.3" }), true);
    assert.equal(isCodexClient({ "user-agent": "node-fetch/3.1" }), false);
});
