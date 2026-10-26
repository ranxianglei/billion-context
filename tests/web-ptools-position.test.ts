// Web quick-config form: the protectedTools row must address the CANONICAL
// compress.protectedTools location. The original row wrote the TOP-LEVEL
// draft.protectedTools — a key the loader does not consume (absent from
// KNOWN_TOP_LEVEL_KEYS, src/config.ts), so saved values were silently ignored
// and later surfaced as `warnUnknownTopLevelKeys` noise: `"protectedTools"
// belongs under "compress" (did you mean "compress.protectedTools"?)`.
import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

test("ptools row reads the compress-level value", () => {
    assert.ok(
        WEB_CLIENT.includes("ptInp.value = (cp && Array.isArray(cp.protectedTools)) ? cp.protectedTools.join(\", \") : \"\";"),
        "syncAll reads cp.protectedTools",
    );
});

test("ptools row writes under d.compress, never top-level", () => {
    assert.ok(WEB_CLIENT.includes("if (!compressOf(d)) d.compress = {};"), "commit ensures d.compress exists");
    assert.ok(WEB_CLIENT.includes("delete d.compress.protectedTools"), "clear path deletes the compress-level key");
    assert.ok(WEB_CLIENT.includes("d.compress.protectedTools = list"), "set path assigns the compress-level key");
    assert.ok(!WEB_CLIENT.includes("draft.protectedTools"), "top-level read wiring must not regress");
    assert.ok(!WEB_CLIENT.includes("d.protectedTools"), "top-level write wiring must not regress");
});
