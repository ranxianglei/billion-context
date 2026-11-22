import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { buildAnonymousProvenance } from "../src/anon-provenance.js";
import { maskUrlsForDiagnostics, maskUrlsForPublish, maskUrlsInText, setMaskHostsEnabled } from "../src/log-mask.js";

const maskers = [
    ["log", maskUrlsInText],
    ["diagnostics", maskUrlsForDiagnostics],
    ["publish", maskUrlsForPublish],
] as const;

for (const [name, mask] of maskers) {
    test(`${name} URL masking makes bounded progress over a long non-URL run`, () => {
        const prefix = "a1.+-".repeat(40_000);
        const input = `${prefix}:/ https://alice:synthetic-password@relay.internal/v1?token=synthetic#fragment`;
        const output: unknown = runInNewContext("mask(input)", { mask, input }, { timeout: 2_000 });
        assert.equal(output, `${prefix}:/ https://<private-host>/v1`);
    });

    test(`${name} URL masking preserves scheme-prefix and Unicode boundaries`, () => {
        const suffix = "https://alice:synthetic-password@relay.internal:8443/v1?q=synthetic#fragment";
        for (const prefix of ["", "123", ".+-", "123.+-", "_", "é", "中文", "😀", "\u200b", "\u0000", "\n", "\t"]) {
            assert.equal(mask(`${prefix}${suffix}`), `${prefix}https://<private-host>:8443/v1`, JSON.stringify(prefix));
        }
        assert.equal(mask(`99ABC${suffix}`), "99abchttps://<private-host>:8443/v1");
        assert.equal(mask(`x${suffix}`), "xhttps://<private-host>:8443/v1");
        assert.equal(mask("123://not-a-scheme words mailto:user@example.test"), "123://not-a-scheme words mailto:user@example.test");
    });

    test(`${name} URL masking retains multiple URLs and surrounding punctuation`, () => {
        const input = '123https://u:p@api.openai.com/v1?q=secret "éftp://u:p@relay.internal/pub" <ws://u:p@relay.internal/ws> _socks5h://u:p@relay.internal:1080';
        assert.equal(mask(input), '123https://api.openai.com/v1 "éftp://<private-host>/pub" <ws://<private-host>/ws> _socks5h://<private-host>:1080');
    });
}

test("anonymous provenance can preview a long unbroken first user message", () => {
    const text = "x".repeat(200_000);
    const result: unknown = runInNewContext(
        "build({}, [{ role: 'user', content: text }]).firstMsg",
        { build: buildAnonymousProvenance, text },
        { timeout: 2_000 },
    );
    assert.equal(result, "x".repeat(160));
});

test("malformed URL fragments preserve each surface's existing fallback", () => {
    assert.equal(maskUrlsInText("123http://[bad"), "123<unparseable-url>");
    assert.equal(maskUrlsForPublish("123http://[bad"), "123<unparseable-url>");
    assert.equal(maskUrlsForDiagnostics("123http://[bad"), "123http://[bad");
    for (const [, mask] of maskers) assert.equal(mask(".+http:// \"https://\""), ".+http:// \"https://\"");
});

test("host-mask opt-out keeps credentials scrubbed and never weakens publishing", () => {
    const input = "123https://alice:synthetic-password@relay.internal/v1?q=synthetic#fragment";
    setMaskHostsEnabled(false);
    try {
        assert.equal(maskUrlsInText(input), "123https://relay.internal/v1");
        assert.equal(maskUrlsForDiagnostics(input), "123https://relay.internal/v1");
        assert.equal(maskUrlsForPublish(input), "123https://<private-host>/v1");
    } finally {
        setMaskHostsEnabled(true);
    }
});
