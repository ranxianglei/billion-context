// #2984: default-OFF private-HTTP provider switch — gate behavior matrix.
// Pins: (1) the shared predicate (src/private-host.ts), including the
// deliberate CGNAT (100.64/10) exclusion; (2) every #2585 gate under OFF
// (byte-stable with pre-#2984 behavior — loopback only) and ON (private
// admitted, public still refused); (3) knob wiring through both tiers.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOPBACK_HOSTNAMES, isPrivateHostname, isPrivateUpstreamHost, plainHttpTrusted } from "../src/private-host.ts";
import { parseAgentProviderReport } from "../src/agent-providers.ts";
import { expandExternalSummaryChain, parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import { reportAgentProviders, type Ctx } from "../src/agent/pi.ts";

process.env.NODE_ENV = "test";

const root = mkdtempSync(path.join(tmpdir(), "bili-private-http-"));
// #2831: pre-skip warns land in the shared bili.log via logHostEvent —
// hermetic state-dir redirect so the pi gate case can read them back.
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = path.join(root, "state");
const HOST_LOG_FILE = path.join(root, "state", "billion-context", "bili.log");
const cfgFile = path.join(root, "billion-context.json");
const prevConfigFile = process.env.BILI_CONFIG_FILE;
const prevSwitch = process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS;
process.env.BILI_CONFIG_FILE = cfgFile;

function setConfig(obj: unknown): void {
    writeFileSync(cfgFile, JSON.stringify(obj, null, 2), "utf8");
    process.env.BILI_CONFIG_FILE = cfgFile;
}
function clearConfig(): void {
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-private-http-test-config.json";
}
async function withSwitch(value: string | undefined, fn: () => Promise<void>): Promise<void> {
    if (value === undefined) delete process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS;
    else process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS = value;
    try { await fn(); } finally {
        if (prevSwitch === undefined) delete process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS;
        else process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS = prevSwitch;
    }
}

const LAN_ENTRY = { baseUrl: "http://192.168.1.5:8000/v1", api: "openai", apiKey: "k", models: { m: {} } };

test("#2984 predicate: private classes in, public + CGNAT out", async () => {
    const privates = [
        "http://192.168.1.5:8000/v1", "http://10.0.0.1", "http://172.31.255.255", "http://169.254.1.1",
        "http://127.0.0.1", "http://0.0.0.0:8000", "http://localhost:8000",
        "http://gpu.local:8000", "http://infer.lan:8000", "http://vllm.internal:8000",
        "http://[::1]:8000", "http://[fd00::1]:8000", "http://[fe80::1]:8000", "http://[::ffff:10.1.2.3]:8000",
    ];
    for (const url of privates) assert.equal(isPrivateUpstreamHost(url), true, url);
    const publics = [
        "http://8.8.8.8:8000", "http://example.com:8000", "http://[2001:db8::1]:8000",
        "http://100.64.0.1:11434/v1", // CGNAT/Tailscale deliberately excluded (#2585 pin)
        "http://172.32.0.1", "http://172.15.0.1", "not-a-url",
    ];
    for (const url of publics) assert.equal(isPrivateUpstreamHost(url), false, url);
    // hostname-level pins (the gates pass parsed URL hostnames, IPv6 bracketed)
    assert.deepEqual([...LOOPBACK_HOSTNAMES], ["localhost", "127.0.0.1", "[::1]"], "loopback set unchanged");
    assert.equal(isPrivateHostname("[::1]"), true);
    assert.equal(isPrivateHostname("LOCALHOST"), true);
    assert.equal(isPrivateHostname("100.64.0.1"), false);
});

test("#2984 plainHttpTrusted: OFF trusts exactly the loopback set; ON adds private nets", async () => {
    assert.equal(plainHttpTrusted(new URL("http://127.0.0.1:8000"), false), true);
    assert.equal(plainHttpTrusted(new URL("http://localhost:8000"), false), true);
    assert.equal(plainHttpTrusted(new URL("http://[::1]:8000"), false), true);
    assert.equal(plainHttpTrusted(new URL("http://192.168.1.5:8000"), false), false, "OFF: private stays out");
    assert.equal(plainHttpTrusted(new URL("http://8.8.8.8:8000"), false), false);
    assert.equal(plainHttpTrusted(new URL("http://192.168.1.5:8000"), true), true, "ON: private joins");
    assert.equal(plainHttpTrusted(new URL("http://10.0.0.1"), true), true);
    assert.equal(plainHttpTrusted(new URL("http://gpu.local:8000"), true), true);
    assert.equal(plainHttpTrusted(new URL("http://[fd00::1]:8000"), true), true);
    assert.equal(plainHttpTrusted(new URL("http://100.64.0.1:11434"), true), false, "ON: CGNAT still out");
    assert.equal(plainHttpTrusted(new URL("http://8.8.8.8"), true), false, "ON: public IP still out");
    assert.equal(plainHttpTrusted(new URL("http://example.com"), true), false, "ON: public domain still out");
    assert.equal(plainHttpTrusted(new URL("http://127.0.0.1"), true), true, "loopback trusted either way");
});

test("#2984 intake gate: OFF refuses private plain-HTTP (pre-#2984 behavior), ON admits it", async () => {
    clearConfig();
    await withSwitch(undefined, async () => {
        const r = parseAgentProviderReport({ agent: "pi", providers: { lan: LAN_ENTRY } });
        assert.deepEqual(r.registered, {}, "OFF: nothing registered");
        assert.match(r.skipped[0].reason, /must be HTTPS \(or loopback HTTP\)/, "refusal wording byte-stable");
    });
    await withSwitch("1", async () => {
        const r = parseAgentProviderReport({ agent: "pi", providers: { lan: LAN_ENTRY } });
        assert.equal(r.skipped.length, 0);
        assert.equal(r.registered.lan.baseUrl, "http://192.168.1.5:8000/v1");
    });
});

test("#2984 intake gate: ON never admits public hosts or CGNAT", async () => {
    clearConfig();
    await withSwitch("true", async () => {
        for (const [name, baseUrl] of [["cg", "http://100.64.0.1:11434/v1"], ["pubip", "http://8.8.8.8:8000/v1"], ["pubdom", "http://example.com/v1"]] as const) {
            const r = parseAgentProviderReport({ agent: "pi", providers: { [name]: { baseUrl, api: "openai", apiKey: "k", models: { m: {} } } } });
            assert.deepEqual(r.registered, {}, name);
            assert.match(r.skipped[0].reason, /must be HTTPS \(or loopback HTTP\)/, name);
        }
        const ok = parseAgentProviderReport({ agent: "pi", providers: { https: { baseUrl: "https://example.com/v1", api: "openai", apiKey: "k", models: { m: {} } } } });
        assert.equal(ok.registered.https.baseUrl, "https://example.com/v1", "https control unaffected by the switch");
    });
});

test("#2984 explicit summary target gate: OFF refuses private plain-HTTP url, ON admits", async () => {
    clearConfig();
    const target = { name: "t", protocol: "openai", url: "http://192.168.1.5:8000/v1/chat/completions", model: "m", apiKey: "k" };
    await withSwitch(undefined, async () => {
        assert.throws(() => parseExternalSummarySettings({ enabled: true, targets: [target] }, { inlineKeys: true }), /use HTTPS/, "OFF: loopback-only");
    });
    await withSwitch("1", async () => {
        const parsed = parseExternalSummarySettings({ enabled: true, targets: [target] }, { inlineKeys: true });
        assert.equal(parsed.targets[0].url, "http://192.168.1.5:8000/v1/chat/completions");
    });
});

test("#2984 derived summary endpoint gate: recipe baseUrl on a private net", async () => {
    clearConfig();
    const chain = { enabled: true, targets: ["local/m"] };
    const recipes = { local: { baseUrl: "http://192.168.1.5:8000/v1", api: "openai" as const, models: { m: {} } } };
    await withSwitch(undefined, async () => {
        assert.throws(() => expandExternalSummaryChain(chain, recipes), /not usable/, "OFF: derived endpoint refused");
    });
    await withSwitch("1", async () => {
        const settings = expandExternalSummaryChain(chain, recipes);
        assert.equal(settings.targets[0].url, "http://192.168.1.5:8000/v1/chat/completions");
    });
});

test("#2984 pi reportAgentProviders: private plain-HTTP pre-skipped OFF, reported ON; CGNAT always skipped", async () => {
    const realFetch = globalThis.fetch;
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787";
    const calls: Array<{ url: string; body: unknown }> = [];
    const logLinesSince = (offset: number): string[] => (existsSync(HOST_LOG_FILE) ? readFileSync(HOST_LOG_FILE, "utf8") : "").slice(offset).split("\n").filter((l) => l.length > 0);
    const logOffset = (): number => (existsSync(HOST_LOG_FILE) ? readFileSync(HOST_LOG_FILE, "utf8").length : 0);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const ctx = {
        model: { baseUrl: "http://127.0.0.1:8787", api: "not-virtual" },
        modelRegistry: {
            getAll: () => [
                { id: "qwen2", provider: "lanvllm", api: "openai-completions" },
                { id: "o1", provider: "tailnet", api: "openai-completions" },
                // https control: keeps the POST alive when both privates are pre-skipped
                // (an all-skipped registry returns before any fetch, so there would be
                // no payload to assert against otherwise)
                { id: "gpt", provider: "publlm", api: "openai-completions" },
            ],
            getProvider: (p: string) => ({ lanvllm: { baseUrl: "http://192.168.1.5:8000/v1" }, tailnet: { baseUrl: "http://100.64.0.1:11434/v1" }, publlm: { baseUrl: "https://api.example.com/v1" } })[p],
            getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
            getApiKeyForProvider: async (p: string) => `key-${p}`,
        },
    } as unknown as Ctx;
    try {
        clearConfig();
        await withSwitch(undefined, async () => {
            calls.length = 0;
            const offBefore = logOffset();
            assert.equal(await reportAgentProviders(ctx, "pi"), true);
            const body = calls[0].body as { providers: Record<string, unknown> };
            assert.ok(!("lanvllm" in body.providers), "OFF: private plain-HTTP not reported");
            assert.ok("publlm" in body.providers, "control: https provider still reported");
            const offWarns = logLinesSince(offBefore);
            assert.ok(offWarns.some((l) => l.includes('provider "lanvllm" not reported')), "OFF: skip named locally");
        });
        await withSwitch("1", async () => {
            calls.length = 0;
            const onBefore = logOffset();
            assert.equal(await reportAgentProviders(ctx, "pi"), true);
            const body = calls[0].body as { providers: Record<string, { baseUrl: string }> };
            assert.equal(body.providers.lanvllm?.baseUrl, "http://192.168.1.5:8000/v1", "ON: private plain-HTTP reported");
            const onWarns = logLinesSince(onBefore);
            assert.ok(!onWarns.some((l) => l.includes('provider "lanvllm"')), "ON: no pre-skip warn");
            assert.ok(!("tailnet" in body.providers), "ON: CGNAT still refused");
            assert.ok(onWarns.some((l) => l.includes('provider "tailnet" not reported')), "ON: CGNAT skip named locally");
        });
    } finally {
        globalThis.fetch = realFetch;
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
});

test("#2984 file tier: network.allowPrivateHttpProviders=true admits without env; explicit-off env wins", async () => {
    setConfig({ network: { allowPrivateHttpProviders: true } });
    await withSwitch(undefined, async () => {
        const r = parseAgentProviderReport({ agent: "pi", providers: { lan: LAN_ENTRY } });
        assert.equal(r.registered.lan.baseUrl, "http://192.168.1.5:8000/v1", "file tier reaches the gates");
    });
    await withSwitch("0", async () => {
        const r = parseAgentProviderReport({ agent: "pi", providers: { lan: LAN_ENTRY } });
        assert.deepEqual(r.registered, {}, "set env owns the knob over the file");
    });
    clearConfig();
});

test("teardown", () => {
    if (prevConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = prevConfigFile;
    if (prevSwitch === undefined) delete process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS;
    else process.env.BILI_ALLOW_PRIVATE_HTTP_PROVIDERS = prevSwitch;
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    rmSync(root, { recursive: true, force: true });
});
