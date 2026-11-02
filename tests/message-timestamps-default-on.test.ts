// #4313 default-on follow-up (nails the PRODUCTION default end-to-end):
// with no BILI_MESSAGE_TIMESTAMPS in the environment and a realistic user
// config file that does NOT mention compress.messageTimestamps, every
// production call site must resolve ON:
//   - src/server.ts createCore(...) → { timestamps: true }
//   - src/stream.ts receipt span gate (summaryFingerprintLine span)
//   - src/external-summary-surface.ts prompt-variant selection
// The opt-out contract itself (file false / env "0" ⇒ pre-feature bytes) is
// pinned in tests/issue4313-message-timestamp-toggle.test.ts, whose helper
// drives resolution explicitly; this file instead runs the HONST production
// expression resolveMessageTimestamps(loadConfigFile().compress) under a
// scrubbed environment — the exact shape real instances see on boot.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FUNCTION_ACP_TAGS_TIMESTAMPED, LEAN_HOW_TO_COMPRESS, LEAN_HOW_TO_COMPRESS_TIMESTAMPED } from "acp-kernel";
import { loadConfigFile, resolveMessageTimestamps } from "../src/config.ts";
import { messageTimestampSections } from "../src/external-summary-surface.ts";

const SANDBOX = mkdtempSync(path.join(tmpdir(), "bili-4313-defaulton-"));
// A believable user config: unrelated keys present, NO messageTimestamps key.
const USER_CONFIG = path.join(SANDBOX, "billion-context.json");

const PREV_ENV = process.env.BILI_MESSAGE_TIMESTAMPS;
const PREV_CFG = process.env.BILI_CONFIG_FILE;

before(() => {
    writeFileSync(USER_CONFIG, JSON.stringify({
        compress: { promptPack: "lean", preserveRecentMessages: 5 },
        persist: { enabled: true },
    }, null, 2), "utf8");
});

after(() => {
    if (PREV_ENV === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
    else process.env.BILI_MESSAGE_TIMESTAMPS = PREV_ENV;
    if (PREV_CFG === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = PREV_CFG;
    rmSync(SANDBOX, { recursive: true, force: true });
});

test("production default: scrubbed env + config without the key ⇒ ON at every exit", () => {
    delete process.env.BILI_MESSAGE_TIMESTAMPS; // defeat the suite's ambient pin
    process.env.BILI_CONFIG_FILE = USER_CONFIG;
    try {
        const fileCompress = loadConfigFile().compress;
        // the exact production expression (server.ts / stream.ts / external-summary-surface.ts)
        assert.equal(resolveMessageTimestamps(fileCompress), true);
        // ...and each concrete exit resolves to the TIMESTAMPED rendering path
        assert.equal(resolveMessageTimestamps(fileCompress, {}), true);
        const sections = messageTimestampSections({ howToCompress: LEAN_HOW_TO_COMPRESS });
        assert.equal(sections?.acpTags, FUNCTION_ACP_TAGS_TIMESTAMPED);
        assert.equal(sections?.howToCompress, LEAN_HOW_TO_COMPRESS_TIMESTAMPED);
    } finally {
        delete process.env.BILI_CONFIG_FILE;
    }
});

test("opt-out still honored through the same production expression (file false, no env)", () => {
    writeFileSync(USER_CONFIG, JSON.stringify({ compress: { promptPack: "lean", messageTimestamps: false } }), "utf8");
    delete process.env.BILI_MESSAGE_TIMESTAMPS;
    process.env.BILI_CONFIG_FILE = USER_CONFIG;
    try {
        assert.equal(resolveMessageTimestamps(loadConfigFile().compress), false);
        // and zero prompt divergence when off
        const sections = { howToCompress: LEAN_HOW_TO_COMPRESS };
        assert.equal(messageTimestampSections(sections), sections);
    } finally {
        process.env.BILI_CONFIG_FILE = path.join(SANDBOX, "absent.json");
    }
});
