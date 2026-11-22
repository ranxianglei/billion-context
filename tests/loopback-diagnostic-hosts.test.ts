import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    isLoopbackHost, isMaskHostsEnabled, maskHostPortForDisplay,
    maskUrlForDiagnostics, maskUrlsForDiagnostics, setMaskHostsEnabled,
} from "../src/log-mask.js";
import { describeUpstreamFailure } from "../src/upstream-proxy.js";
import { buildProxyFailureResponse, withUpstreamFailure } from "../src/upstream-fail.js";
import { logHostEvent } from "../src/agent/host-log.js";
import { defaultLogFile } from "../src/paths.js";
import { rmrf } from "./tmp-rm.js";

test("DNS names starting with 127 are not loopback addresses", () => {
    for (const host of ["127.customer.internal", "127.0.0.1.customer.internal", "127.dead.beef"]) {
        assert.equal(isLoopbackHost(host), false, host);
        assert.equal(maskHostPortForDisplay(`${host}:8443`), "<private-host>:8443", host);
    }
});

test("diagnostic URL masking protects 127-prefixed private DNS names", () => {
    for (const scheme of ["https", "ws", "socks5h"]) {
        const input = `${scheme}://alice:synthetic-password@127.customer.internal:8443/v1?q=synthetic#fragment`;
        assert.equal(maskUrlForDiagnostics(input), `${scheme}://<private-host>:8443/v1`);
        assert.equal(maskUrlsForDiagnostics(`dial ${input} failed`), `dial ${scheme}://<private-host>:8443/v1 failed`);
    }
});

test("the actual failure response never exposes a loopback-looking DNS name", () => {
    const host = "127.customer.internal";
    const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const failure = describeUpstreamFailure(error, `https://${host}:8443/v1`);
    assert.equal(failure.detail.host, "<private-host>:8443");
    const response = buildProxyFailureResponse(failure.message, withUpstreamFailure(error, failure.detail));
    assert.equal(response.status, 502);
    const body = JSON.parse(response.body) as { error: string; upstreamFailure: { host: string } };
    assert.equal(body.error, "acp-proxy failure: dns ENOTFOUND <private-host>:8443");
    assert.equal(body.upstreamFailure.host, "<private-host>:8443");
    assert.ok(!response.body.includes(host));
});

test("host-event file output masks loopback-looking private DNS names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-loopback-hostname-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
        logHostEvent("warn", "[test-host]", "dial https://127.customer.internal:8443/v1 failed");
        const output = fs.readFileSync(defaultLogFile(), "utf8");
        assert.match(output, /dial https:\/\/<private-host>:8443\/v1 failed/);
        assert.ok(!output.includes("127.customer.internal"));
    } finally {
        if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
        await rmrf(dir);
    }
});

test("bracketed IPv6 without a port is not split at an address colon", () => {
    assert.equal(maskHostPortForDisplay("[::1]"), "[::1]");
    assert.equal(maskHostPortForDisplay("[2001:db8::1]"), "<private-host>");
    const failure = describeUpstreamFailure(new Error("failed"), "http://[::1]/v1");
    assert.equal(failure.detail.host, "[::1]");
});

test("genuine loopback names and IPv4 aliases remain actionable", () => {
    for (const host of ["localhost", "LOCALHOST", "0.0.0.0", "127.0.0.1", "127.255.255.255", "127.1", "127.0.1", "127.0x1", "127.000.1"]) {
        assert.equal(isLoopbackHost(host), true, host);
        assert.equal(maskHostPortForDisplay(`${host}:8443`), `${host}:8443`, host);
        const origin = `http://${host}:8443`;
        assert.equal(maskUrlForDiagnostics(origin), origin, "clean loopback origins remain byte-identical");
    }
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true);
    assert.equal(maskHostPortForDisplay("[::1]:9000"), "[::1]:9000");
});

test("invalid numeric addresses and URL syntax are not loopback hosts", () => {
    for (const host of ["127.1.2.999", "127.0x1000000", "127..1", "127.0.0.1/path", "127.0.0.1@private.example", "127.0.0.1?query", "127.0.0.1\n", "localhost.private.example"]) {
        assert.equal(isLoopbackHost(host), false, JSON.stringify(host));
    }
});

test("public hosts and explicit private-host visibility keep their existing policy", () => {
    assert.equal(maskHostPortForDisplay("api.openai.com:443"), "api.openai.com:443");
    assert.equal(maskHostPortForDisplay("relay.internal:443"), "<private-host>:443");
    const previous = isMaskHostsEnabled();
    setMaskHostsEnabled(false);
    try {
        assert.equal(maskHostPortForDisplay("127.customer.internal:8443"), "127.customer.internal:8443");
        assert.equal(maskUrlForDiagnostics("https://alice:synthetic-password@127.customer.internal/v1?q=synthetic#fragment"), "https://127.customer.internal/v1");
        assert.equal(maskHostPortForDisplay("[2001:db8::1]:8443"), "[2001:db8::1]:8443");
    } finally {
        setMaskHostsEnabled(previous);
    }
});
