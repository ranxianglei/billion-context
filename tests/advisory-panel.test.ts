// #1577: native/plugin-lane users can't reach the stderr warn, the Web UI banner or
// /__bili/status (proxy child on an ephemeral port, stdio→log fd); the /acp panel is
// the one surface they see, so an active advisory must land there. It MUST sit BEFORE
// PANEL_BOX_FOOTER: the LLM-context stripper (src/acp-panel.ts) anchors its match on
// that footer, so appending after it would ship the panel into model context.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCore, defaultConfig } from "acp-kernel";
import { _resetSessionsForTest, getSession } from "../src/session.ts";
import { handlePluginStatus } from "../src/plugin.ts";
import { PANEL_BOX_FOOTER } from "../src/acp-panel.ts";
import { _resetAdvisoryWatcherForTest, _setAdvisoryStateForTest } from "../src/advisory.ts";

function mockRes(): { res: http.ServerResponse; status: number; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, body: "" };
    const res = {
        writeHead(code: number) { out.status = code; return res; },
        end(chunk?: unknown) { if (typeof chunk === "string") out.body = chunk; return res; },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

test("#1577: /acp panel surfaces an active advisory before the footer (stripper-safe), byte-exact when clean", () => {
    _resetSessionsForTest();
    _resetAdvisoryWatcherForTest();
    try {
        getSession("adv-sess", { protocol: "anthropic", label: "ADV" });
        const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

        const r0 = mockRes();
        handlePluginStatus("never-seen", r0.res, deps, true);
        assert.equal(r0.status, 200);
        const p0 = JSON.parse(r0.body).panel as string | undefined;
        assert.ok(p0, "panel renders for the live session");
        assert.ok(!p0.includes("CRITICAL ADVISORY"), "no advisory line when none is active");
        assert.ok(p0.includes(PANEL_BOX_FOOTER), "footer present when clean");

        _setAdvisoryStateForTest({ active: { id: "bc-2026-001", affected: ">=1.0.0", target: "0.1.157", reason: "corrupts tool-call arguments", currentVersion: "0.1.156" } });
        const r1 = mockRes();
        handlePluginStatus("never-seen", r1.res, deps, true);
        assert.equal(r1.status, 200);
        const p1 = JSON.parse(r1.body).panel as string;
        assert.ok(p1.includes("⚠️ CRITICAL ADVISORY:"), "advisory line present");
        assert.match(p1, /\[bc-2026-001\] version 0\.1\.156 is affected \(corrupts tool-call arguments\)/, "carries the reason");
        assert.ok(p1.includes("npm install -g billion-context@0.1.157"), "carries the manual command");
        assert.ok(p1.includes(PANEL_BOX_FOOTER), "footer still present with the advisory");
        assert.ok(p1.indexOf("CRITICAL ADVISORY") < p1.indexOf(PANEL_BOX_FOOTER), "advisory sits BEFORE the footer so the stripper still matches");

        // Remote-doc content must render verbatim: $ sequences are replace()
        // pattern syntax and would corrupt the box lines unescaped.
        const dollarReason = "costs $5M; echo $& back";
        _setAdvisoryStateForTest({ active: { id: "bc-2026-002", affected: ">=1.0.0", target: "1.0.9", reason: dollarReason, currentVersion: "1.0.1" } });
        const r2 = mockRes();
        handlePluginStatus("never-seen", r2.res, deps, true);
        const p2 = JSON.parse(r2.body).panel as string;
        assert.ok(p2.includes(dollarReason), "dollar-sign reason survives byte-exact");
        assert.equal((p2.match(new RegExp(PANEL_BOX_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1, "footer appears exactly once");
    } finally {
        _setAdvisoryStateForTest({});
        _resetAdvisoryWatcherForTest();
        _resetSessionsForTest();
    }
});
