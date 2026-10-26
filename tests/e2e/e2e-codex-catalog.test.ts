import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProxyOptions } from "../../src/config.js";

const binary = process.env.E2E_CODEX_BIN;

test(
    "Codex catalog: online -> HTTP outage -> socket disconnect -> recovery",
    {
        skip: process.env.ACP_TEST_E2E_CODEX_CATALOG !== "1" || !binary,
        timeout: 90_000,
    },
    async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "bili-codex-catalog-"));
        const previousEnv = { ...process.env };
        const originalFetch = globalThis.fetch;
        const fixture = JSON.parse(await readFile(new URL("./fixtures/codex-catalog.json", import.meta.url), "utf8")) as {
            models: Record<string, unknown>[];
        };
        let phase = "online",
            requests = 0;
        const upstream = http.createServer((req, res) => {
            requests++;
            assert.equal(req.method, "GET");
            assert.match(req.url ?? "", /^\/backend-api\/codex\/models\?/);
            assert.equal(req.headers.authorization, "Bearer SYNTHETIC_ACCESS_ONLY");
            if (phase === "disconnect") {
                req.socket.destroy();
                return;
            }
            if (phase === "offline") {
                res.writeHead(503);
                res.end("synthetic outage");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(fixture));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        let proxy: http.Server | undefined;
        try {
            for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(directory, key);
            process.env.NODE_ENV = "test";
            globalThis.fetch = (input, init) => {
                const url = String(input);
                if (url.startsWith("https://chatgpt.com/backend-api/codex/models?")) {
                    return originalFetch(url.replace("https://chatgpt.com", upstreamOrigin), init);
                }
                throw new Error("Unexpected external request in catalog fixture");
            };
            const { startServer } = await import("../../src/server.js");
            const { defaultConfig } = await import("acp-kernel");
            const { SessionStore, _setStoreForTest } = await import("../../src/persist.js");
            const { _setForTest } = await import("../../src/registry.js");
            _setStoreForTest(new SessionStore({ enabled: false }));
            _setForTest({});
            proxy = await startServer({
                port: 0,
                host: "127.0.0.1",
                upstream: "https://chatgpt.com",
                routes: { "https://chatgpt.com": { proxy: "" } },
                modelContextLimit: 400_000,
                kernelConfig: defaultConfig(400_000),
                compress: { injectTool: false, injectNudge: false },
                promptCache: { routing: "auto" },
                sessionHeader: "x-acp-session",
                log: false,
                debug: false,
                passthrough: false,
                autoUpdate: false,
                autoRestartOnUpdate: false,
                advisoryCheck: false,
                releaseNotesCheck: false,
                compat: { roles: {} },
                mitm: { enabled: false, domains: [] },
            } as ProxyOptions);
            await once(proxy, "listening");
            const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/https://chatgpt.com/backend-api/codex`;
            const home = path.join(directory, "codex");
            await mkdir(home);
            await writeFile(
                path.join(home, "config.toml"),
                `model="gpt-6.1-sol"\nmodel_provider="fixture"\ncli_auth_credentials_store="file"\n[model_providers.fixture]\nname="Synthetic catalog fixture"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\nbase_url=${JSON.stringify(base)}\nmodel_catalog_url=${JSON.stringify(base + "/models")}\n`,
            );
            const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
            const jwt = `${enc({ alg: "RS256" })}.${enc({ sub: "synthetic", email: "test@example.invalid", "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "plus" } })}.${enc({ signature: "SYNTHETIC" })}`;
            await writeFile(
                path.join(home, "auth.json"),
                JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        id_token: jwt,
                        access_token: "SYNTHETIC_ACCESS_ONLY",
                        refresh_token: "SYNTHETIC_REFRESH_ONLY",
                        account_id: "synthetic-account",
                    },
                    last_refresh: new Date().toISOString(),
                }),
            );
            const env = Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !/^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i.test(key)),
            );
            for (phase of ["online", "offline", "disconnect", "recovered"]) {
                if (phase === "recovered") fixture.models[0].context_window = 400_000;
                await rm(path.join(home, "models_cache.json"), { force: true });
                const child = spawn(binary!, ["app-server"], {
                    env: {
                        ...env,
                        CODEX_HOME: home,
                        NO_PROXY: "localhost,127.0.0.1,::1",
                        RUST_LOG: "warn",
                    },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                let errors = "";
                child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
                    errors += chunk;
                });
                const lines = createInterface({ input: child.stdout });
                const replies = new Map<
                    number,
                    {
                        resolve: (value: Record<string, unknown>) => void;
                        reject: (error: Error) => void;
                    }
                >();
                lines.on("line", (line) => {
                    const message = JSON.parse(line) as {
                        id?: number;
                        result?: Record<string, unknown>;
                        error?: unknown;
                    };
                    if (message.id === undefined) return;
                    const pending = replies.get(message.id);
                    replies.delete(message.id);
                    if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
                    else if (message.result) pending?.resolve(message.result);
                });
                const rpc = (id: number, method: string, params: unknown) =>
                    new Promise<Record<string, unknown>>((resolve, reject) => {
                        replies.set(id, { resolve, reject });
                        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
                    });
                const timer = setTimeout(() => {
                    for (const pending of replies.values()) pending.reject(new Error(`Catalog RPC timeout: ${phase}`));
                }, 20_000);
                try {
                    await rpc(1, "initialize", {
                        clientInfo: { name: "catalog-regression", version: "1" },
                    });
                    child.stdin.write('{"method":"initialized"}\n');
                    const result = await rpc(2, "model/list", { includeHidden: true });
                    assert.ok(
                        Array.isArray(result.data) && result.data.some((item: { model: string }) => item.model === "gpt-6.1-sol"),
                        `${phase}: model missing; ${errors}`,
                    );
                    const cached = JSON.parse(await readFile(path.join(home, "models_cache.json"), "utf8")) as { models: Record<string, unknown>[] };
                    assert.equal(cached.models[0].tool_mode, "code_mode_only", phase);
                    assert.equal(cached.models[0].supports_search_tool, true, phase);
                    assert.equal(cached.models[0].context_window, phase === "recovered" ? 400_000 : fixture.models[0].context_window, phase);
                    assert.ok(!errors.includes("Unknown model gpt-6.1-sol"), phase);
                } finally {
                    clearTimeout(timer);
                    const closed = once(child, "close");
                    child.kill();
                    await closed;
                    lines.close();
                }
            }
            assert.ok(requests >= 4);
        } finally {
            globalThis.fetch = originalFetch;
            if (proxy) {
                proxy.closeAllConnections();
                await new Promise<void>((resolve) => proxy!.close(() => resolve()));
            }
            upstream.closeAllConnections();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
            process.env = previousEnv;
            await rm(directory, { recursive: true, force: true });
        }
    },
);
