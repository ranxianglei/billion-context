import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

type Item = Record<string, unknown>;
const run = process.env.ACP_TEST_E2E_OC_WS === "1";
const bin = process.env.E2E_OC_BIN ?? "opencode";
const repo = path.resolve(import.meta.dirname, "../..");
const entry = path.join(repo, "dist/agent/opencode-native.js");
const version = run ? spawnSync(bin, ["--version"], { timeout: 15000 }).stdout?.toString() ?? "" : "";

for (const sparseTerminal of [false, true]) {
test(`real OpenCode V2: native Responses WebSockets, fold and post-fold tools (${sparseTerminal ? "sparse" : "full"} terminal output)`, {
    skip: !run ? "set ACP_TEST_E2E_OC_WS=1 (real OpenCode V2, local WS upstream, zero tokens)" : !/v?2\./.test(version) || !fs.existsSync(entry) ? "OpenCode V2 binary and built dist required" : false,
    timeout: 180000,
}, async (t) => {
    const root = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp/opencode") : os.tmpdir(), "bili-oc-ws-e2e-"));
    const snapshots = new Map<string, Item[]>();
    const rows: Array<{ transport: "ws" | "http"; body: Item; full: Item[]; headers: http.IncomingHttpHeaders }> = [];
    let serial = 0;
    let postFoldStatusCalls = 0;
    const itemText = (item: Item | undefined): string => typeof item?.content === "string" ? item.content : Array.isArray(item?.content) ? item.content.map(part => typeof part === "object" && part !== null ? String((part as Item).text ?? "") : "").join("\n") : "";
    const reply = (body: Item, headers: http.IncomingHttpHeaders, transport: "ws" | "http", send: (event: Item) => void) => {
        const prior = typeof body.previous_response_id === "string" ? snapshots.get(body.previous_response_id) : undefined;
        const full = [...(prior ?? []), ...(Array.isArray(body.input) ? body.input as Item[] : [])];
        rows.push({ transport, body, full, headers });
        const tools = (Array.isArray(body.tools) ? body.tools as Item[] : []).flatMap(tool => tool.type === "namespace" && Array.isArray(tool.tools) ? tool.tools as Item[] : [tool]);
        const hasStatus = tools.some(tool => tool.name === "acp_status");
        const statusCalled = full.some(item => item.type === "function_call_output");
        const lastUser = [...full].reverse().find(item => item.role === "user");
        const foldEncoded = itemText(lastUser).match(/WS_FOLD_REQUEST_B64 ([A-Za-z0-9+/=]+)/)?.[1];
        const fold = foldEncoded ? Buffer.from(foldEncoded, "base64").toString("utf8") : undefined;
        const foldDone = full.some(item => item.type === "function_call" && item.name === "compress") && full.some(item => item.type === "function_call_output" && String(item.output).includes("Compressed"));
        const compressIndex = full.findIndex(item => item.type === "function_call" && item.name === "compress");
        const postFoldStatus = full.slice(compressIndex + 1).find(item => item.type === "function_call" && item.name === "acp_status");
        const postFoldResult = postFoldStatus && full.some(item => item.type === "function_call_output" && item.call_id === postFoldStatus.call_id);
        let name = fold ? !foldDone ? "compress" : !postFoldResult ? "acp_status" : undefined : hasStatus && !statusCalled ? "acp_status" : undefined;
        if (foldDone && name === "acp_status") postFoldStatusCalls++;
        const text = postFoldStatusCalls > 1 ? "WS_E2E_REPEATED_TOOL" : "WS_E2E_OK";
        if (postFoldStatusCalls > 1) name = undefined;
        const id = `resp_e2e_ws_${++serial}`;
        const args = name === "compress" ? fold! : "{}";
        const item: Item = name
            ? { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: args, status: "completed" }
            : { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        let sequence = 0;
        const event = (type: string, data: Item) => send({ type, sequence_number: sequence++, ...data });
        event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
        event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(name ? { arguments: "" } : { content: [] }) } });
        if (name) {
            event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args });
            event("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args });
        } else {
            event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
            event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
            event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: (item.content as Item[])[0] });
        }
        event("response.output_item.done", { output_index: 0, item });
        snapshots.set(id, [...full, item]);
        event("response.completed", { response: { id, object: "response", model: body.model, status: "completed", output: sparseTerminal && foldDone ? [] : [item], usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    };
    const upstream = http.createServer(async (req, res) => {
        if (req.method !== "POST") { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Item;
        res.writeHead(200, { "content-type": "text/event-stream" });
        reply(body, req.headers, "http", event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        res.end();
    });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (peer, req) => peer.on("message", raw => reply(JSON.parse(raw.toString()) as Item, req.headers, "ws", event => peer.send(JSON.stringify(event)))));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const nativeDir = path.join(root, "native-plugin");
    const dirs = { config: path.join(root, "config"), data: path.join(root, "data"), state: path.join(root, "state"), cache: path.join(root, "cache"), cwd: path.join(root, "cwd"), home: path.join(root, "home") };
    for (const dir of [...Object.values(dirs), nativeDir, path.join(dirs.config, "opencode"), path.join(dirs.config, "billion-context")]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`);
    fs.writeFileSync(path.join(dirs.config, "opencode/opencode.json"), JSON.stringify({ model: "openai/gpt-5.2", providers: { openai: { settings: { apiKey: "test-only-no-real-key", baseURL: `${origin}/v1`, transport: "websocket" } } }, plugins: [nativeDir], compaction: { auto: false } }));
    fs.writeFileSync(path.join(dirs.config, "billion-context/billion-context.json"), JSON.stringify({ compress: { preserveRecentTokens: 0 } }));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(BILI|BILLION_CONTEXT|ACP_|OPENCODE|OPENAI|ANTHROPIC|NODE_TEST_CONTEXT)/.test(key) || /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete env[key];
    Object.assign(env, { HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache, ACP_AUTO_UPDATE: "0", BILLION_CONTEXT_NODE: process.execPath });
    t.after(async () => {
        const instances = path.join(dirs.state, "billion-context/instances");
        if (fs.existsSync(instances)) for (const file of fs.readdirSync(instances)) {
            try { const record = JSON.parse(fs.readFileSync(path.join(instances, file), "utf8")) as { pid?: number }; if (record.pid) process.kill(record.pid); } catch {}
        }
        for (const peer of wss.clients) peer.terminate();
        upstream.closeAllConnections();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
        wss.close();
        fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(rows, null, 2));
    });
    const ocRun = async (prompt: string, session?: string) => {
        const args = ["run", "--standalone", "--auto", "--format", "json", "-m", "openai/gpt-5.2"];
        if (session) args.push("-s", session);
        args.push(prompt);
        const child = spawn(bin, args, { cwd: dirs.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill(), 45000);
        const [code] = await once(child, "exit");
        clearTimeout(timer);
        fs.writeFileSync(path.join(root, `run-${Date.now()}.txt`), stdout + "\n" + stderr);
        assert.equal(code, 0, stderr);
        assert.ok(stdout.includes("WS_E2E_OK"), stdout + stderr);
    };
    await ocRun("Session purpose: verify WebSocket ACP integration.");
    const main = rows.filter(row => row.transport === "ws");
    assert.ok(main.length >= 2, `No primary WS requests; evidence at ${root}`);
    assert.ok(main.every(row => row.headers["x-bili-plugin"] === "opencode"));
    const sid = main[0].headers["x-bili-plugin-conversation"];
    assert.equal(typeof sid, "string");
    await ocRun("E2E-WS-BULKY-SENTINEL " + "deterministic filler content ".repeat(600), sid as string);
    const firstUser = rows.filter(row => row.transport === "ws").at(-1)!.full.find(item => item.role === "user" && itemText(item).includes("E2E-WS-BULKY-SENTINEL"));
    const ref = itemText(firstUser).match(/\x3cacp[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e/)?.[1];
    assert.ok(ref);
    assert.ok(main.some(row => row.full.some(item => item.type === "function_call_output" && String(item.output).includes("ACP Context Analysis"))));
    for (let i = 0; i < 3; i++) await ocRun(`push-back round ${i}`, sid as string);
    const foldArgs = { content: [{ startId: ref, endId: ref, summary: "E2E-WS-SUMMARY: the original material consisted of deterministic bulky filler and established the WebSocket ACP integration test context." }] };
    await ocRun(`WS_FOLD_REQUEST_B64 ${Buffer.from(JSON.stringify(foldArgs)).toString("base64")}`, sid as string);
    const afterFold = rows.filter(row => row.transport === "ws" && row.full.some(item => item.type === "function_call_output" && String(item.output).includes("Compressed")));
    assert.equal(afterFold.length, 2);
    assert.equal(postFoldStatusCalls, 1, "A completed status tool must not be requested again after a fold");
    const final = afterFold.at(-1)!;
    assert.ok(!JSON.stringify(final.full).includes("E2E-WS-BULKY-SENTINEL"));
    assert.ok(JSON.stringify(final.full).includes("E2E-WS-SUMMARY"));
    assert.equal(afterFold[0].body.previous_response_id, undefined);
    assert.equal(typeof final.body.previous_response_id, "string");
    assert.ok(final.full.some(item => item.type === "function_call_output" && String(item.output).includes("Compressed")));
    const statusCall = [...final.full].reverse().find(item => item.type === "function_call" && item.name === "acp_status");
    assert.ok(statusCall);
    assert.ok(final.full.some(item => item.type === "function_call_output" && item.call_id === statusCall.call_id && String(item.output).includes("ACP Context Analysis")));
    assert.ok(rows.filter(row => row.transport === "http").every(row => row.headers["x-bili-plugin-agent"] === "title"), "Primary requests must never fall back to HTTP");
    const log = fs.readFileSync(path.join(dirs.state, "billion-context/bili.log"), "utf8");
    assert.match(log, /tool compress executed via plugin/);
    assert.match(log, /forward WS/);
    assert.match(log, /acp-usage/);
    t.diagnostic(`OpenCode ${version.trim()}, evidence: ${root}`);
});
}
