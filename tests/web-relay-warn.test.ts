import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT, adminRelayActiveInDraft } from "../src/web/client.ts";
import { MESSAGES, LOCALES } from "../src/web/i18n.ts";
import { renderPage } from "../src/web/page.ts";

// #3816 owner follow-up: while the user SETS security.adminRelay in the panel's
// config editor, a warning must be visible. The gate is strict on purpose —
// enabling the relay exposes the FULL admin surface (config edits, credential
// writes) through whoever reaches the dsh web entry, so truthy typos must not
// trip it.
test("#3816: adminRelayActiveInDraft — strict === true only", () => {
    assert.equal(adminRelayActiveInDraft('{"security":{"adminRelay":true}}'), true);
    assert.equal(adminRelayActiveInDraft('{ "security" : { "adminRelay" : true , "other": 1 } }'), true);
    assert.equal(adminRelayActiveInDraft('{"security":{"adminRelay":false}}'), false);
    assert.equal(adminRelayActiveInDraft('{"security":{"adminRelay":"true"}}'), false);
    assert.equal(adminRelayActiveInDraft('{"security":{"adminRelay":1}}'), false);
    assert.equal(adminRelayActiveInDraft('{"security":{}}'), false);
    assert.equal(adminRelayActiveInDraft('{"security":true}'), false);
    assert.equal(adminRelayActiveInDraft("{}"), false);
    assert.equal(adminRelayActiveInDraft("[]"), false);
    assert.equal(adminRelayActiveInDraft('"str"'), false);
    assert.equal(adminRelayActiveInDraft("null"), false);
    assert.equal(adminRelayActiveInDraft(""), false);
    assert.equal(adminRelayActiveInDraft("{"), false);
    assert.equal(adminRelayActiveInDraft('{"a": '), false);
});

test("#3816: JSONC-tolerant drafts still detect the enabled relay", () => {
    const draft = "// enable relay\n{\n  \"security\": {\n    \"adminRelay\": true,\n  }\n}\n";
    assert.equal(adminRelayActiveInDraft(draft), true);
});

test("#3816: the config page warns while the draft enables the relay", () => {
    assert.ok(WEB_CLIENT.includes("const adminRelayActiveInDraft = "), "the IIFE embeds the relay gate");
    assert.ok(WEB_CLIENT.includes('$("cfg-relay-warn")'), "the client targets the warning slot");
    assert.ok(WEB_CLIENT.includes('t("cfg.relay_warn")'), "the warning text is localized");
    const dirty = WEB_CLIENT.indexOf("function refreshDirtyFlag()");
    assert.ok(dirty >= 0, "refreshDirtyFlag present");
    const body = WEB_CLIENT.slice(dirty, dirty + 900);
    assert.ok(body.includes("refreshRelayWarn();"), "every editor change re-evaluates the relay warning");
    const ui = renderPage("http://127.0.0.1:1", "0.0.0-test");
    assert.match(ui, /id="cfg-relay-warn" class="banner warn"/);
    for (const locale of LOCALES) {
        assert.ok(
            typeof MESSAGES[locale]["cfg.relay_warn"] === "string" && MESSAGES[locale]["cfg.relay_warn"].length > 0,
            `cfg.relay_warn missing in ${locale}`,
        );
    }
    assert.ok(!/\p{Script=Han}/u.test(MESSAGES.en["cfg.relay_warn"]), "en value has no Chinese residue");
    assert.ok(/adminRelay/.test(MESSAGES["zh-CN"]["cfg.relay_warn"]), "zh names the knob");
});
