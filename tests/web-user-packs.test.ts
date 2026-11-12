// #5328: user-dir prompt-pack management over the web API —
// GET/PUT/DELETE /__bili/packs/user/<name> maps 1:1 onto files under
// <XDG_CONFIG_HOME>/billion-context/packs/. Covers create/read/delete round-
// trips, rejection of invalid names and empty or non-pack payloads, and that
// /__bili/packs reports the user dir so the panel knows what it may edit.
// Loopback/origin gating is covered by the existing admin gate tests.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { rmrf } from "./tmp-rm.js";
import { CHAT_COMPRESS_PHILOSOPHY, CHAT_HOW_TO_COMPRESS } from "../src/chat-pack.js";

async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

function request(method: string, port: number, reqPath: string, body?: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
    return promise;
}

const packJson = (obj: unknown): string => JSON.stringify({ json: JSON.stringify(obj, null, 2) });

test("#5328: user-dir pack management endpoints", async (t) => {
    const root = path.join(tmpdir(), `bili-user-packs-${process.pid}-${Date.now()}`);
    const cfgHome = path.join(root, "xdg-config");
    const packDir = path.join(cfgHome, "billion-context", "packs");
    mkdirSync(packDir, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    await import("node:fs").then((fs) => fs.writeFileSync(biliConfig, "{}\n", "utf8"));
    const prevFile = process.env.BILI_CONFIG_FILE;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.XDG_CONFIG_HOME = cfgHome;
    t.after(() => {
        if (prevFile === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevFile;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
        rmrf(root);
    });
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
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
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        await waitReady(port);
        // /__bili/packs reports the user dir the panel may manage.
        const inv = JSON.parse((await request("GET", port, "/__bili/packs")).body) as { userDir?: string };
        assert.equal(inv.userDir, packDir, "userDir matches XDG config packs dir");

        // Create.
        const payload = { promptSections: { philosophy: "user philosophy" }, customExtra: "kept" };
        const put = await request("PUT", port, "/__bili/packs/user/my-pack", packJson(payload));
        assert.equal(put.status, 200, `create ok (${put.body})`);
        const file = path.join(packDir, "my-pack.json");
        assert.ok(existsSync(file), "file written to user packs dir");
        const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        assert.equal(onDisk.customExtra, "kept", "unknown top-level keys are preserved for host adapters");
        const inv2 = JSON.parse((await request("GET", port, "/__bili/packs")).body) as { packs: Array<{ name: string; source: string }> };
        const listed = inv2.packs.find((p) => p.name === "my-pack");
        assert.ok(listed && listed.source.startsWith("file:"), "created pack appears in inventory with file: provenance");

        // Read back the raw text.
        const got = JSON.parse((await request("GET", port, "/__bili/packs/user/my-pack")).body) as { name: string; json: string };
        assert.equal(got.name, "my-pack");
        assert.equal(JSON.parse(got.json).promptSections.philosophy, "user philosophy");

        // #5344: base texts for the guided editor — exactly the three
        // resolvable shipped/builtin packs, tri-state resolved like
        // buildCompressSystemPrompt (chat overrides both sections verbatim,
        // default has none so the kernel default prose comes through).
        const tplRes = await request("GET", port, "/__bili/packs/templates");
        assert.equal(tplRes.status, 200, `templates ok (${tplRes.body})`);
        const tpl = JSON.parse(tplRes.body) as { packs: Record<string, { philosophy: string; howToCompress: string }> };
        assert.deepEqual(Object.keys(tpl.packs).sort(), ["chat", "default", "lean"]);
        assert.ok(tpl.packs.default.philosophy.length > 100, "default philosophy falls back to kernel prose");
        assert.ok(tpl.packs.default.howToCompress.length > 100, "default howToCompress falls back to kernel prose");
        assert.equal(tpl.packs.chat.philosophy, CHAT_COMPRESS_PHILOSOPHY, "chat philosophy is the shipped text verbatim");
        assert.equal(tpl.packs.chat.howToCompress, CHAT_HOW_TO_COMPRESS, "chat howToCompress is the shipped text verbatim");
        assert.ok(tpl.packs.lean.howToCompress.length > 50, "lean provides its condensed rules");
        assert.notEqual(tpl.packs.lean.howToCompress, tpl.packs.default.howToCompress, "lean howToCompress differs from default");

        // Invalid payloads are refused before touching disk.
        const badJson = await request("PUT", port, "/__bili/packs/user/bad-json", JSON.stringify({ json: "{nope" }));
        assert.equal(badJson.status, 400, `invalid JSON refused (${badJson.body})`);
        const emptyPack = await request("PUT", port, "/__bili/packs/user/empty-pack", packJson({}));
        assert.equal(emptyPack.status, 400, `pack without recognized fields refused (${emptyPack.body})`);
        assert.ok(!existsSync(path.join(packDir, "empty-pack.json")), "refused pack leaves no file");
        const foreignKeys = await request("PUT", port, "/__bili/packs/user/foreign", packJson({ foo: 1 }));
        assert.equal(foreignKeys.status, 400, `unrecognized-only surface refused (${foreignKeys.body})`);

        // Names: dotted interior rejected by the pack-name convention even
        // though the route charset would allow it; traversal never 2xx.
        const dotted = await request("PUT", port, "/__bili/packs/user/a..b", packJson(payload));
        assert.equal(dotted.status, 400, `name containing .. refused (${dotted.body})`);
        assert.ok(!existsSync(path.join(packDir, "a..b.json")));
        const traversal = await request("PUT", port, "/__bili/packs/user/" + encodeURIComponent("../evil"), packJson(payload));
        assert.notEqual(traversal.status, 200, "traversal-shaped name must not succeed");
        assert.ok(!existsSync(path.join(cfgHome, "evil.json")), "nothing written outside packs dir");

        // Delete.
        const del = await request("DELETE", port, "/__bili/packs/user/my-pack");
        assert.equal(del.status, 200, `delete ok (${del.body})`);
        assert.ok(!existsSync(file), "file removed");
        assert.equal((await request("DELETE", port, "/__bili/packs/user/my-pack")).status, 404, "second delete is 404");
        assert.equal((await request("GET", port, "/__bili/packs/user/my-pack")).status, 404, "get of deleted is 404");
    } finally {
        proxy.close();
    }
});
