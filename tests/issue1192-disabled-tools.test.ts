// #1192: dsh registered the manifest's tools verbatim, so it called acp_rule
// even though compress.rules was disabled — every call died with a hard
// 400 "unknown tool". The manifest side (only advertise enabled opt-in tools)
// is covered by the plugin-protocol / rules / absorb suites; this pins the
// execution side: a known-but-disabled opt-in tool answers with a model-facing
// explanation (ok:true), while a genuinely unknown tool still 400s. Since
// #1399 the feature is on by default, so "disabled" here means an explicit
// `compress.rules: false`.
import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool } from "../src/plugin.ts";
import { getSession } from "../src/session.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#1192: known-but-disabled opt-in tools get an explanation, not a hard error", () => {
    let deps: PluginToolDeps;
    let sessionId: string;

    beforeEach(() => {
        _resetPluginStateForTest();
        deps = { core: createCore(), config: defaultConfig(400_000), log: () => {} };
        sessionId = getSession(`t-1192-${Math.random().toString(36).slice(2)}`).id;
    });

    async function call(tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId: sessionId, tool, args }), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
    }

    it("acp_rule with rules explicitly disabled → ok:true explanation instead of 400", async () => {
        deps.config = { ...deps.config, rules: { enabled: false } };
        const r = await call("acp_rule", { rule: "verify driver unload+reload" });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.match(String(r.json.result), /acp_rule is explicitly disabled on this bili proxy \(compress\.rules: false\)/);
        assert.match(String(r.json.result), /nothing was recorded/);
    });

    it("acp_rule with rules unset → executes by default (#1399)", async () => {
        const r = await call("acp_rule", { rule: "default-on rule" });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.match(String(r.json.result), /^Recorded rule\d+: default-on rule$/);
    });

    it("absorb disabled → ok:true explanation", async () => {
        const r = await call("absorb", { ref: "m00001", summary: "x" });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.match(String(r.json.result), /absorb is not enabled on this bili proxy \(compress\.absorb\.enabled is not true\)/);
    });

    it("truly unknown tool keeps the 400 with the allowed list", async () => {
        const r = await call("definitely_not_a_tool");
        assert.equal(r.status, 400);
        assert.equal(r.json.ok, false);
        assert.match(String(r.json.error), /unknown tool "definitely_not_a_tool"/);
        for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
            assert.ok(String(r.json.error).includes(name), `allowed list has ${name}`);
        }
    });

    it("rules enabled → acp_rule executes and records", async () => {
        deps.config = { ...deps.config, rules: { enabled: true } };
        const r = await call("acp_rule", { rule: "enabled rule" });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.match(String(r.json.result), /^Recorded rule\d+: enabled rule$/);
    });
});
