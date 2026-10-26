import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// Hermetic config: point at a per-process absent file so these tests never read
// a developer machine's real billion-context.json.
process.env.BILI_CONFIG_FILE = path.join(tmpdir(), `issue3226-absent-${process.pid}.json`);
// Fail fast on rejected summaries so the 401 surfaces immediately (no budget burn).
process.env.BILI_REPLAY_RETRY_MAX = "1";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import {
    APIG_RESIGN_CREDENTIAL_HEADER,
    APIG_RESIGN_HEADER,
    APIG_RESIGN_SCHEME,
    encodeApigCredential,
    signApigHeaders,
    type ApigCredential,
} from "../src/apig-resign.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { defaultConfig } from "acp-kernel";

// #3226 (CodeArts/Huawei-APIG SDK-HMAC-SHA256): the #1884 re-sign arm covers the
// MAIN forward, but the preflight SUMMARIZATION egress was the one body-covering
// lane that still forwarded the inbound signature verbatim. That signature
// covers the ORIGINAL request body, while the summary call ships a body bili
// built itself — so the gateway recomputed the body hash, saw a mismatch, and
// answered 401, which bili treats as a non-retryable auth rejection → the whole
// turn fail-fasted 502 preflight_compress_failed. Compression was therefore dead
// on signed lanes the moment a session crossed the window. These tests pin the
// fix: every summarization egress is re-signed over its OWN bytes, so the
// gateway accepts it and the turn compresses + forwards instead of dying.

const CRED: ApigCredential = { ak: "AKTEST123", sk: "SKTEST456", token: "tok-789" };
const MODEL = "deepseek-v4.1-flash";

// A reply long enough to clear MIN_SUMMARY_CHARS (50) so a summarized range is
// accepted as a real fold rather than diagnosed as an empty/short completion.
const MODEL_REPLY =
    "PREFLIGHT-3226 SUMMARY: the folded segment held a deterministic load-growth payload across several turns; every raw marker is derivable from the seed, so the compressed view loses nothing of value.";

function sha256Hex(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
}

/** Independent verifier: recompute the SDK-HMAC-SHA256 signature from what a
 * server ACTUALLY received (method / full URL / lowercased headers / raw body).
 * Written from the wire format on purpose — it shares no code with the signer.
 * Crucially it fails with "declared payload hash != sha256(body)" when the
 * x-sdk-content-sha256 header does not match sha256(the real body) — the exact
 * #3226 failure mode (a signature computed over one body sent with another). */
function verifySdkHmac(req: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    sk: string;
}): { ok: boolean; reason?: string } {
    const auth = String(req.headers["authorization"] ?? "");
    const m = /^SDK-HMAC-SHA256 Access=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(auth);
    if (m === null) return { ok: false, reason: `authorization shape: ${auth}` };
    const [, , signedHeaders, sig] = m;
    const names = signedHeaders.split(";");
    if (names.length === 0 || new Set(names).size !== names.length) return { ok: false, reason: "duplicate/empty signed headers" };
    if ([...names].sort().join(";") !== signedHeaders) return { ok: false, reason: "signed headers not sorted" };
    const u = new URL(req.url);
    let uri = u.pathname;
    if (!uri.endsWith("/")) uri += "/";
    const headerVal = (n: string): string => {
        const v = req.headers[n];
        return Array.isArray(v) ? v.join(",") : String(v ?? "");
    };
    const payloadHash = sha256Hex(req.body);
    if (headerVal("x-sdk-content-sha256") !== payloadHash) return { ok: false, reason: "declared payload hash != sha256(body)" };
    const canonical = [
        req.method.toUpperCase(),
        uri,
        u.search.slice(1),
        names.map((n) => `${n}:${headerVal(n)}`).join("\n"),
        "",
        names.join(";"),
        payloadHash,
    ].join("\n");
    const stringToSign = `SDK-HMAC-SHA256\n${headerVal("x-sdk-date")}\n${sha256Hex(canonical)}`;
    const expect = createHmac("sha256", req.sk).update(stringToSign).digest("hex");
    if (expect !== sig) return { ok: false, reason: "signature mismatch" };
    return { ok: true };
}

interface UpstreamRecord {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    status: number;
    rejectReason?: string;
}

// Mock upstream that VALIDATES every incoming signature with the sk it issued,
// like the real APIG gateway. Any body/signature disagreement → 401 APIG.0301
// (carrying the verifier's reason); a valid signature → 200 with the fixed reply.
function startVerifyingUpstream(sk: string): Promise<{ server: http.Server; port: number; calls: UpstreamRecord[] }> {
    const calls: UpstreamRecord[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            const verdict = verifySdkHmac({
                method: req.method ?? "POST",
                url: `http://${String(req.headers["host"])}${req.url}`,
                headers: req.headers,
                body,
                sk,
            });
            const status = verdict.ok ? 200 : 401;
            calls.push({ method: req.method ?? "POST", url: req.url ?? "/", headers: req.headers, body, status, rejectReason: verdict.reason });
            res.writeHead(status, { "content-type": "application/json" });
            res.end(verdict.ok
                ? JSON.stringify({ id: "cmpl-3226", choices: [{ index: 0, message: { role: "assistant", content: MODEL_REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })
                : JSON.stringify({ error: { code: "APIG.0301", message: `signature verification failed: ${verdict.reason}` } }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, calls }));
    });
}

// Small-window proxy so a moderate payload crosses the model window and forces
// the preflight overflow walk (mirrors the issue1993 trigger setup).
async function startProxy(upstreamPort: number): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: (proxy.address() as { port: number }).port };
}

// Over-window conversation: alternating turns, each carrying a large unique
// marker block so the kernel has real, foldable spans (mirrors issue1993's
// longResponsesInput, reshaped for the chat/completions wire).
function longChatMessages(count: number): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [];
    for (let i = 0; i < count; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return messages;
}

async function closeAll(...servers: http.Server[]): Promise<void> {
    servers.forEach((s) => { s.close(); s.closeAllConnections?.(); s.closeIdleConnections?.(); });
    await new Promise<void>((resolve) => void Promise.allSettled(servers.map((s) => once(s, "close"))).then(() => resolve()));
}

test("#3226 signed lane: preflight summarization egress is re-signed over its own body (no 401 body-hash-mismatch)", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    const { server: upstream, port: upstreamPort, calls } = await startVerifyingUpstream(CRED.sk);
    const { proxy, port: proxyPort } = await startProxy(upstreamPort);
    try {
        // The client signs its OWN (original) body — a valid signature over the
        // ORIGINAL bytes. bili must NOT reuse it for the summary call.
        const bodyStr = JSON.stringify({ model: MODEL, stream: false, messages: longChatMessages(12), max_tokens: 512 });
        const clientHeaders: Record<string, string> = {
            "content-type": "application/json",
            "x-acp-session": "issue3226-signed",
        };
        signApigHeaders(clientHeaders, CRED, "POST", `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, Buffer.from(bodyStr, "utf8"));
        // Arm the #1884 re-sign tunnel with the credential marker.
        clientHeaders[APIG_RESIGN_HEADER] = APIG_RESIGN_SCHEME;
        clientHeaders[APIG_RESIGN_CREDENTIAL_HEADER] = encodeApigCredential(CRED);

        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: clientHeaders,
            body: bodyStr,
        });
        const text = await r.text();

        // THE regression: pre-fix this was 502 preflight_compress_failed because
        // the summary call rode the stale inbound signature into a 401.
        assert.equal(r.status, 200, `signed-lane over-window turn must compress+forward, got ${r.status}: ${text.slice(0, 400)}`);

        // Preflight genuinely ran (trigger line logged) AND spent at least one
        // summarization call upstream — otherwise the test would pass trivially
        // on a payload that never crossed the window.
        assert.ok(
            lines.some((l) => l.includes("preflight compressing before forward")),
            `preflight must have been triggered, got: ${lines.filter((l) => l.includes("preflight")).slice(0, 4).join(" | ") || "(no preflight log)"}`,
        );
        assert.ok(calls.length >= 2, `expected a summarization call plus the forward, saw ${calls.length}: ${JSON.stringify(calls.map((c) => ({ url: c.url, status: c.status })))}`);

        // NO upstream call may have failed signature verification. Pre-fix, the
        // summary call specifically failed with the body-hash mismatch.
        const rejected = calls.filter((c) => c.status === 401);
        assert.equal(rejected.length, 0, `every egress must carry a valid signature over its own body; 401s: ${JSON.stringify(rejected.map((c) => ({ url: c.url, reason: c.rejectReason })))}`);
        assert.ok(!calls.some((c) => c.rejectReason?.includes("payload hash")), "no body-hash-mismatch may reach the gateway");

        // The loopback arm markers never leak past the proxy onto the wire.
        for (const c of calls) {
            assert.equal(c.headers[APIG_RESIGN_HEADER], undefined, "arm marker stripped before egress");
            assert.equal(c.headers[APIG_RESIGN_CREDENTIAL_HEADER], undefined, "credential NEVER reaches the wire");
        }
        // Every accepted call was re-signed with the tunneled credential (not the
        // stale inbound Access key that the client put on the original body).
        assert.ok(calls.every((c) => String(c.headers["authorization"] ?? "").includes("Access=AKTEST123")), "egress re-signed with the tunneled credential");
    } finally {
        setLogCapture(null);
        await closeAll(proxy, upstream);
    }
});
