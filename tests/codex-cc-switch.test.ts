import assert from "node:assert/strict";
import test from "node:test";
import {
    detectCcSwitchFromText,
    isProxyManagedCredential,
} from "../src/codex-integration/cc-switch.ts";
import { credentialFingerprint } from "../src/cache-ledger.ts";

test("CC Switch Direct and Routing fixtures are detected without claiming compatibility", () => {
    const direct = detectCcSwitchFromText('{"codex":{"mode":"direct"}}');
    assert.equal(direct.discovered, true);
    assert.equal(direct.mode, "direct");
    assert.equal(direct.compatibility, "config-route-only");
    assert.match(direct.detail, /provider-database synchronization is not integrated/);
    const routing = detectCcSwitchFromText(undefined, '{"proxyMode":"routing"}');
    assert.equal(routing.mode, "routing");
    assert.equal(routing.compatibility, "unsupported");
    const unknown = detectCcSwitchFromText("{}", undefined);
    assert.equal(unknown.discovered, true);
    assert.equal(unknown.mode, "unknown");
    assert.equal(detectCcSwitchFromText().discovered, false);
});

test("CC Switch live-state apps.codex.mode schema is recognized", () => {
    const result = detectCcSwitchFromText(undefined, '{"version":1,"apps":{"codex":{"mode":"direct"}}}');
    assert.equal(result.discovered, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.compatibility, "config-route-only");
});


test("PROXY_MANAGED is not persisted as a credential fingerprint", () => {
    assert.equal(isProxyManagedCredential("Bearer PROXY_MANAGED"), true);
    assert.equal(
        credentialFingerprint({ authorization: "Bearer PROXY_MANAGED" }),
        undefined,
    );
    assert.equal(
        credentialFingerprint({
            authorization: "Bearer sk-live-example",
        })?.startsWith("sha256:"),
        true,
    );
});
