// #1996 — a client-origin mid-history role:"system" item on the Responses wire
// (OMP forwards host-compaction checkpoints verbatim; the plugin-mode
// position-preserving pass-through of #1638 keeps it in place) trips
// placement-strict Jinja backends (Qwen family served by vLLM/SGLang):
// "System message must be at the beginning." That error names no role, so the
// #552/#583 learn-on-failure ladder used to sit idle and every post-compression
// request 400-looped. This pins the #1996 entry path: the ladder fires from
// the placement marker plus the wire carrying the shape, repairs with one
// system→user hop, remembers it for the session, and turn 2 rides clean
// proactively. Hermetic (validation-parity fake upstream), always runs in CI.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { startFakeUpstream } from "./wire-contract-fakes.ts";
import { rmrf } from "./tmp-rm.ts";

interface Item {
    role?: string;
    content?: string;
}

function systemIdx(items: Item[]): number {
    return items.findIndex((it) => it.role === "system");
}

test("e2e #1996: off-head client system on the Responses wire — one learn-on-failure repair, then clean", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "offhead-sys-test-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const fake = await startFakeUpstream("responses");
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: fake.url,
        routes: { [fake.url]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/${fake.url}/v1/responses`;
    const conv = `offhead-${Date.now().toString(36)}`;
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-bili-plugin": "omp-plugin/0.0.1",
        "x-bili-plugin-conversation": conv,
        "x-acp-session": conv,
    };
    try {
        // OMP wire form: type-less items, a head developer prompt, and a
        // mid-history role:"system" checkpoint — the #1996 offender shape.
        const hist1: Item[] = [
            { role: "developer", content: "You are a helpful assistant." },
            { role: "user", content: "q1 tell me about compression" },
            { role: "system", content: "CONTEXT CHECKPOINT — early turns folded by host compaction." },
            { role: "assistant", content: "a1 compression keeps context lean" },
            { role: "user", content: "q2 and why does it help" },
        ];
        const res1 = await fetch(base, { method: "POST", headers, body: JSON.stringify({ model: "gpt-test", stream: true, input: hist1 }) });
        assert.equal(res1.status, 200, "client sees a transparent 200 after the learn-on-failure repair");
        await res1.arrayBuffer();

        assert.equal(fake.requests.length, 2, "original forward + one repaired retry");
        const sent1 = fake.requests[0]!.body as { input: Item[] };
        assert.ok(systemIdx(sent1.input) >= 1, "bili forwards the client-origin system verbatim (faithful wire)");
        assert.ok(fake.violations.some((v) => v.includes("WC-014")), `fake recorded the WC-014 violation, got: ${JSON.stringify(fake.violations)}`);
        const sent2 = fake.requests[1]!.body as { input: Item[] };
        assert.equal(systemIdx(sent2.input), -1, "retry carries zero literal system roles (system→user hop)");

        // Turn 2: learned {system:user} applied proactively at egress — no
        // second 400, no new violation.
        const hist2: Item[] = [...hist1, { role: "assistant", content: "a2 it saves tokens" }, { role: "user", content: "q3 thanks" }];
        const res2 = await fetch(base, { method: "POST", headers, body: JSON.stringify({ model: "gpt-test", stream: true, input: hist2 }) });
        assert.equal(res2.status, 200);
        await res2.arrayBuffer();
        assert.equal(fake.requests.length, 3, "turn 2 needed exactly one forward (learned mapping proactive)");
        assert.equal(fake.violations.filter((v) => v.includes("WC-014")).length, 1, "no second WC-014 violation");
        const sent3 = fake.requests[2]!.body as { input: Item[] };
        assert.equal(systemIdx(sent3.input), -1, "turn 2 rides clean");
    } finally {
        proxy.closeAllConnections?.();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await fake.close();
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(stateDir);
    }
});
