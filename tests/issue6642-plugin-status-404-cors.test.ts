// #6642: the plugin-status 404 fallthrough must carry the SAME cors-mode
// headers the 2xx branches do. The dsh Context tab polls this route
// cross-origin (its own loopback port / dsh-app:// scheme); a bare 404
// without access-control-allow-origin is rejected by the browser as
// "Failed to fetch", masking the real "unknown plugin conversation" error
// the panel is trying to surface — which is exactly how the DSH 0.2.2-rc.1
// takeover-dead case hid behind a network error for 10 days.
//
// Both directions are pinned (gate discipline #3617): the header is present
// when a trusted origin is admitted, and ABSENT when the request is same-origin
// (no trustedOrigin) so we never leak an allow-origin to an untrusted caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCore, defaultConfig } from "acp-kernel";
import { handlePluginStatus, _resetPluginStateForTest } from "../src/plugin.ts";

const ORIGIN = "http://127.0.0.1:51162";

function mockRes(): { res: http.ServerResponse; status: number; headers: Record<string, string>; body: string } {
    const out = { res: undefined as unknown as http.ServerResponse, status: 0, headers: {} as Record<string, string>, body: "" };
    const res = {
        writeHead(code: number, headers?: Record<string, string>) {
            out.status = code;
            if (headers) out.headers = headers;
            return res;
        },
        end(chunk?: unknown) {
            if (typeof chunk === "string") out.body = chunk;
            return res;
        },
    } as unknown as http.ServerResponse;
    out.res = res;
    return out;
}

const deps = { core: createCore(), config: defaultConfig(200000), log: (_l: string, _m: string) => {} };

test("plugin-status 404 carries access-control-allow-origin when a trusted origin is admitted (#6642)", async () => {
    _resetPluginStateForTest();

    // fallback=latest: no session with post-boot activity → the "since boot" 404.
    const r1 = mockRes();
    await handlePluginStatus("never-seen", r1.res, deps, true, ORIGIN);
    assert.equal(r1.status, 404, "no post-boot activity → 404");
    assert.ok(r1.body.includes("since boot"), "the fallback=latest 404 names the no-activity cause");
    assert.equal(r1.headers["access-control-allow-origin"], ORIGIN, "the 404 echoes the admitted origin so the cross-origin browser fetch can read it");
    assert.equal(r1.headers["content-type"], "application/json");

    // bare (no fallback): the "unknown plugin conversation" 404.
    const r2 = mockRes();
    await handlePluginStatus("never-seen", r2.res, deps, false, ORIGIN);
    assert.equal(r2.status, 404);
    assert.ok(r2.body.includes("unknown plugin conversation"), "the bare 404 names the unknown conversation");
    assert.equal(r2.headers["access-control-allow-origin"], ORIGIN, "the bare 404 also echoes the admitted origin");
});

test("plugin-status 404 omits access-control-allow-origin for a same-origin (untrusted) caller (#6642 negative)", async () => {
    _resetPluginStateForTest();
    const r = mockRes();
    await handlePluginStatus("never-seen", r.res, deps, false);
    assert.equal(r.status, 404);
    assert.ok(r.body.includes("unknown plugin conversation"));
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no trusted origin → no allow-origin header (never echoed to an untrusted caller)");
    assert.equal(r.headers["content-type"], "application/json", "content-type is still set");
});
