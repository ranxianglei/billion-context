import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDshAcpPatch } from "../src/launcher.ts";

// #2605/#2610: both bili-owned DSH patch carriers must restate the FULL
// default retryableCodes list plus MALFORMED_RESPONSE on the built-in
// DeepSeek routes — a cordis patch replaces the targeted row's WHOLE config
// (no deep merge), so dropping any default code silently removes its retries.
// launcher.test.ts pins the overlay lane; this pins the BUNDLE lane (it ships
// in the npm package and only gets teeth otherwise via the real-dsh e2e,
// where an absent row is warn+skip, not a failure) and carrier agreement.

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

const COMPACT_ROW = "- id: compaction-basic\n  config:\n    auto: false\n";
const RETRY_ROW_DS =
    "- id: llm-deepseek\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]\n";
const RETRY_ROW_DSA =
    "- id: llm-deepseek-account\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]\n";

test("#2605: dsh.bundle.patch.yml restates every default code + MALFORMED_RESPONSE on both DeepSeek routes", () => {
    // #2631: normalize CRLF checkouts (Git-for-Windows autocrlf) before the
    // byte-exact multi-line includes; .gitattributes pins eol=lf as the first
    // line of defense, this protects checkouts that bypass it.
    const bundle = fs.readFileSync(path.join(REPO_ROOT, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
    assert.ok(bundle.includes(COMPACT_ROW), "compaction-basic auto:false row must stay intact");
    assert.ok(bundle.includes(RETRY_ROW_DS), "llm-deepseek retry row missing or drifted");
    assert.ok(bundle.includes(RETRY_ROW_DSA), "llm-deepseek-account retry row missing or drifted");
});

test("#2605: launcher overlay and bundle patch carry byte-identical retry rows", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2605-overlay-"));
    try {
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file, "writeDshAcpPatch must produce the overlay file");
        const overlay = fs.readFileSync(file, "utf8");
        assert.ok(overlay.includes(COMPACT_ROW), "compaction-basic auto:false row must stay intact");
        assert.ok(overlay.includes(RETRY_ROW_DS), "overlay llm-deepseek retry row missing or drifted");
        assert.ok(overlay.includes(RETRY_ROW_DSA), "overlay llm-deepseek-account retry row missing or drifted");
    } finally {
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});
