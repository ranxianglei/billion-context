// Kiro CLI lane: gateway quirks (roles, identity) and the `bili kiro` launcher wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
    KIRO_COMPAT_ROLES,
    KIRO_DEFAULT_MODEL_HOSTS,
    builtinCompatRoles,
    isKiroRequest,
    kiroConversationId,
    preferKiroConversationIdentity,
} from "../src/kiro.js";
import { applyCompatRoles } from "../src/compat-roles.js";
import { buildKiroEnv, discoverRoutes, isLaunchClient, LAUNCH_CLIENTS, resolveClientCommand } from "../src/launcher.js";

// Headers as kiro-cli 2.37 sends them (observed; credentials omitted).
const KIRO_HEADERS = {
    "content-type": "application/json",
    "x-amzn-kiro-origin": "AI_EDITOR",
    "user-agent": "KiroCLI/2.37.0 KAS/0.66.70 os/macos md/appVersion-2.37.0 app/AmazonQ-For-CLI acp-client/kiro-cli-non-interactive",
};
const KIRO_URL = "https://runtime.us-east-1.kiro.dev/v1/responses";

test("isKiroRequest: Kiro UA or origin header, on a Kiro runtime host", () => {
    assert.equal(isKiroRequest(KIRO_HEADERS, KIRO_URL), true);
    assert.equal(isKiroRequest(KIRO_HEADERS, "https://runtime.eu-central-1.kiro.dev/v1/responses"), true);
    assert.equal(isKiroRequest({ "x-amzn-kiro-origin": "AI_EDITOR" }, KIRO_URL), true);
    assert.equal(isKiroRequest(KIRO_HEADERS), true); // upstream unknown: header evidence suffices
    // Kiro UA towards a non-Kiro host (e.g. a user-configured relay) is not Kiro's gateway.
    assert.equal(isKiroRequest(KIRO_HEADERS, "https://api.openai.com/v1/responses"), false);
    assert.equal(isKiroRequest(KIRO_HEADERS, "https://runtime.us-east-1.kiro.dev.evil.example/v1/responses"), false);
    assert.equal(isKiroRequest({ "user-agent": "codex_cli_rs/0.150" }, KIRO_URL), false);
    assert.equal(isKiroRequest({ "user-agent": "Mozilla/5.0 KiroCLI/2.37.0" }, KIRO_URL), false); // must lead the UA
    assert.equal(isKiroRequest(KIRO_HEADERS, "not a url"), false);
});

test("builtinCompatRoles: developer/system → user for Kiro only", () => {
    assert.deepEqual(builtinCompatRoles(KIRO_HEADERS, KIRO_URL), { developer: "user", system: "user" });
    assert.deepEqual(builtinCompatRoles({ "user-agent": "codex_cli_rs/0.150" }, "https://api.openai.com/v1/responses"), {});
    // Fresh copy each call: callers merge and may mutate.
    const a = builtinCompatRoles(KIRO_HEADERS, KIRO_URL);
    a.developer = "system";
    assert.equal(KIRO_COMPAT_ROLES.developer, "user");
});

test("compat rewrite: bili's injected developer prompt at input[0] becomes a user item (the Kiro 400 fix)", () => {
    // Shape bili forwarded when Kiro answered 400 "not supported", param input[0].
    const body = JSON.stringify({
        model: "auto",
        input: [
            { type: "message", role: "developer", content: "compression philosophy…" },
            { type: "message", role: "user", content: "Kiro system prompt…" },
            { type: "message", role: "assistant", content: "OK" },
            { type: "message", role: "user", content: "next question" },
        ],
        tools: [],
        stream: true,
        origin: "AI_EDITOR",
        metadata: { "kiro:conversation_id": "c-1" },
    });
    const applied = applyCompatRoles(body, "responses", builtinCompatRoles(KIRO_HEADERS, KIRO_URL));
    assert.equal(applied.rewritten, 1);
    const out = JSON.parse(applied.body) as { input: Array<{ role: string; content: string }>; metadata: unknown; origin: string };
    assert.deepEqual(out.input.map((i) => i.role), ["user", "user", "assistant", "user"]);
    assert.equal(out.input[0]!.content, "compression philosophy…"); // content and position untouched
    assert.equal(out.origin, "AI_EDITOR"); // Kiro-specific fields survive
    assert.deepEqual(out.metadata, { "kiro:conversation_id": "c-1" });
});

test("kiroConversationId: reads metadata['kiro:conversation_id'] defensively", () => {
    assert.equal(kiroConversationId({ metadata: { "kiro:conversation_id": " 0b4c-11 " } }), "0b4c-11");
    assert.equal(kiroConversationId({ metadata: { "kiro:conversation_id": "" } }), undefined);
    assert.equal(kiroConversationId({ metadata: { "kiro:conversation_id": 42 } }), undefined);
    assert.equal(kiroConversationId({ metadata: ["x"] }), undefined);
    assert.equal(kiroConversationId({}), undefined);
    assert.equal(kiroConversationId(null), undefined);
});

test("preferKiroConversationIdentity: promotes over a content fingerprint only, for Kiro only", () => {
    const body = { metadata: { "kiro:conversation_id": "0b4c-11" } };
    const fingerprint = { value: "hash", source: "content-fingerprint", clientProvided: false };
    assert.deepEqual(preferKiroConversationIdentity(fingerprint, body, KIRO_HEADERS), { value: "kiro-0b4c-11", source: "metadata-session", clientProvided: true });
    // A real client id stays stronger.
    const header = { value: "sess-9", source: "header", clientProvided: true };
    assert.equal(preferKiroConversationIdentity(header, body, KIRO_HEADERS), header);
    const pck = { value: "pck-1", source: "prompt-cache-key", clientProvided: true };
    assert.equal(preferKiroConversationIdentity(pck, body, KIRO_HEADERS), pck);
    // Not Kiro traffic, or no id: unchanged.
    assert.equal(preferKiroConversationIdentity(fingerprint, body, { "user-agent": "codex_cli_rs/0.150" }), fingerprint);
    assert.equal(preferKiroConversationIdentity(fingerprint, {}, KIRO_HEADERS), fingerprint);
    assert.equal(preferKiroConversationIdentity(undefined, body, KIRO_HEADERS), undefined);
    // Filesystem-safe (session ids name state files; ':' is invalid on Windows).
    assert.doesNotMatch(preferKiroConversationIdentity(fingerprint, body, KIRO_HEADERS)!.value, /[:\\/]/);
});

test("launcher: kiro is a launch client that cert-MITMs only the Kiro model gateways", () => {
    assert.equal(isLaunchClient("kiro"), true);
    assert.ok((LAUNCH_CLIENTS as readonly string[]).includes("kiro"));
    const routes = discoverRoutes("kiro", {});
    assert.deepEqual(routes.httpsDomains, [...KIRO_DEFAULT_MODEL_HOSTS]);
    assert.ok(routes.httpsDomains.every((h) => /^runtime\.[a-z0-9-]+\.kiro\.dev$/.test(h)));
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("buildKiroEnv: HTTPS_PROXY + combined CA on SSL_CERT_FILE and NODE_EXTRA_CA_CERTS, loopback direct", () => {
    const env = buildKiroEnv("http://127.0.0.1:18787", "/ca/combined-ca.pem", { PATH: "/usr/bin", KEEP: "1" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:18787");
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.SSL_CERT_FILE, "/ca/combined-ca.pem");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/ca/combined-ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:18787");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
    assert.equal(env.KEEP, "1");
    assert.equal(env.PATH, "/usr/bin");
});

test("resolveClientCommand: kiro launches kiro-cli (PATH, else ~/.local/bin/kiro-cli; BILI_CLIENT_BIN wins)", () => {
    const noPath = { PATH: path.join(os.tmpdir(), "bili-kiro-empty-path") };
    if (process.platform !== "win32") {
        assert.equal(resolveClientCommand("kiro", noPath, "darwin").command, path.join(os.homedir(), ".local", "bin", "kiro-cli"));
    }
    assert.equal(resolveClientCommand("kiro", { ...noPath, BILI_CLIENT_BIN: "/opt/kiro/kiro-cli" }).command, "/opt/kiro/kiro-cli");
});

test("judge role restore: only built-in re-voicings, overridable by config, applied to a copy", async () => {
    const { builtinRoleRestorePoints, withRestoredRoles } = await import("../src/kiro.js");
    const body = JSON.stringify({ input: [
        { type: "message", role: "developer", content: "bili prompt" },
        { type: "message", role: "user", content: "Kiro system prompt" },
        { type: "message", role: "system", content: "x" },
        { type: "message", role: "assistant", content: "ok" },
    ] });
    const builtin = { developer: "user", system: "user" };
    assert.deepEqual(builtinRoleRestorePoints(body, "responses", builtin, builtin), [[0, "developer"], [2, "system"]]);
    // A configured compat.roles entry (system→assistant, say) wins: not a built-in re-voicing.
    assert.deepEqual(builtinRoleRestorePoints(body, "responses", builtin, { developer: "user", system: "assistant" }), [[0, "developer"]]);
    assert.deepEqual(builtinRoleRestorePoints("not json", "responses", builtin, builtin), []);

    const sent = { input: [{ role: "user", content: "bili prompt" }, { role: "user", content: "Kiro system prompt" }], model: "auto" };
    const restored = withRestoredRoles(sent, [[0, "developer"]]);
    assert.deepEqual((restored.input as Array<{ role: string }>).map((i) => i.role), ["developer", "user"]);
    assert.equal((sent.input[0] as { role: string }).role, "user"); // the wire body is untouched
    assert.equal(withRestoredRoles(sent, []), sent);
    assert.equal(withRestoredRoles(null, [[0, "developer"]]), null);
});
