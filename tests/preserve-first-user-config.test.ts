import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "acp-kernel";
import { parseCompressSettings } from "../src/config.js";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.js";

describe("compress.preserveFirstUser config mapping", () => {
    it("parses boolean preserveFirstUser and maps it onto resolved kernel Config", () => {
        const parsed = parseCompressSettings({ preserveFirstUser: false });
        assert.ok(parsed);
        assert.equal(parsed.preserveFirstUser, false);
        assert.equal(parseCompressSettings({ preserveFirstUser: "nope" }), undefined);

        const merged = mergeCompress(parsed, undefined, undefined);
        const applied = applyCompressSettings(defaultConfig(200_000), 200_000, merged);
        assert.equal(applied.preserveFirstUser, false);
    });
});
