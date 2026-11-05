import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.js";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { getSession } from "../src/session.ts";
import { credentialFingerprint, generationParamFp, getCacheLedger } from "../src/cache-ledger.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const testData = mkdtempSync(path.join(tmpdir(), "bili-capture-"));
const priorData = process.env.XDG_DATA_HOME;
const priorStorage = process.env.BILI_STORAGE_UNIFIED;
process.env.XDG_DATA_HOME = testData;
process.env.BILI_STORAGE_UNIFIED = "legacy";
_setStoreForTest(new SessionStore({ enabled: false }));
after(() => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    if (priorStorage === undefined) delete process.env.BILI_STORAGE_UNIFIED;
    else process.env.BILI_STORAGE_UNIFIED = priorStorage;
    rmrf(testData);
});

function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
}
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

for (const plugin of [false, true]) for (const stream of [false, true]) for (const reverse of [false, true]) {
    test(`real proxy pairs overlapping same-session forwards; plugin=${plugin}, stream=${stream}, reverse=${reverse}`, { timeout: 30_000 }, async () => {
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const ready = [gate(), gate()], release = [gate(), gate()];
        const sent: string[] = [];
        const sockets = new Set<unknown>();
        const upstream = http.createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const index = sent.length;
            assert.ok(index < 2, "no hidden upstream request");
            sent.push(Buffer.concat(chunks).toString("utf8"));
            sockets.add(req.socket);
            ready[index].open();
            await release[index].wait;
            const usage = { prompt_tokens: 100_000 + index * 100, completion_tokens: 11 + index, total_tokens: 100_011 + index * 101, prompt_tokens_details: { cached_tokens: index === 0 ? 99_000 : 20_000 } };
            const message = { id: `chatcmpl-${index}`, object: "chat.completion", model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: `answer ${index}` }, finish_reason: "stop" }], usage };
            res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
            if (stream) {
                res.write(`data: ${JSON.stringify({ ...message, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `answer ${index}` }, finish_reason: "stop" }] })}\n\n`);
                res.end("data: [DONE]\n\n");
            } else res.end(JSON.stringify(message));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { models: { "gpt-test": { context: 400_000 } } } },
            modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false,
            passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false,
            updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const sessionId = `capture-http-${plugin}-${stream}-${reverse}`;
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}/v1/chat/completions`;
        const post = async (label: string): Promise<void> => {
            const response = await fetch(url, {
                method: "POST", signal: AbortSignal.timeout(20_000),
                headers: { ...(plugin ? { "x-bili-plugin": "test-agent" } : {}), "content-type": "application/json", "x-acp-session": sessionId, connection: "close", authorization: `Bearer synthetic-${label}` },
                body: JSON.stringify({ model: "gpt-test", stream, temperature: label === "request A" ? 0.1 : 0.9, messages: [{ role: "user", content: label }], tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }] }),
            });
            assert.equal(response.status, 200);
            assert.match(await response.text(), /answer/);
        };
        try {
            const a = post("request A");
            await ready[0].wait;
            const b = post("request BBBB");
            await ready[1].wait;
            assert.equal(sockets.size, 2, "two same-session socket requests overlap before either settles");
            if (reverse) { release[1].open(); await b; release[0].open(); await a; }
            else { release[0].open(); await a; release[1].open(); await b; }
            const lines = getCacheLedger(getSession(sessionId)).lines;
            assert.equal(lines.length, 2);
            for (let index = 0; index < 2; index++) {
                const line = lines.find((sample) => sample.output === 11 + index)!;
                assert.ok(line, "both usage records settled");
                assert.equal(line.bd, createHash("sha256").update(sent[index]).digest("hex"));
                assert.equal(line.kp, credentialFingerprint({ authorization: `Bearer synthetic-${index === 0 ? "request A" : "request BBBB"}` }));
                assert.equal(line.efp, generationParamFp(JSON.parse(sent[index])));
                assert.equal(line.captureRound, 1);
                assert.ok(line.captureId);
            }
            assert.notEqual(lines[0].captureId, lines[1].captureId);
        } finally {
            for (const pending of release) pending.open();
            await close(proxy);
            await close(upstream);
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
        }
    });
}
