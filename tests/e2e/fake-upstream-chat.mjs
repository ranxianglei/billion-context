// Deterministic fake chat-completions upstream for the native-client E2E lanes
// (#1239): drives a REAL host client (`pi`, `opencode`) through bili's native
// extension so interception, plugin-mode stamping, ACP tool registration and
// compression ACTUALLY happen in-process, no real model/network. The prompt of
// the FIRST user message scripts the conversation: every "请调用<tool>" marker
// becomes one queued tool round ("请调用<tool> {json}" pins the arguments —
// braces may nest); when the queue is exhausted the model answers plain text
// "收到#done". `compress` with no explicit args is
// special-cased: the fake cites REAL refs harvested from the request's ACP tags
// so the kernel has a foldable range. Every /chat/completions request is
// appended to FAKE_REQLOG (JSONL) as the assertion oracle.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.FAKE_PORT || 0);
const HOST = process.env.FAKE_HOST || "127.0.0.1";
const REQLOG = process.env.FAKE_REQLOG || path.join(process.cwd(), "tmp", "fake-chat-requests.jsonl");
const PORT_FILE = process.env.FAKE_PORT_FILE || "";
const MODEL = process.env.FAKE_MODEL || "fake-model";
try { fs.mkdirSync(path.dirname(REQLOG), { recursive: true }); } catch { /* noop */ }
try { fs.rmSync(REQLOG, { force: true }); } catch { /* noop */ }

const estIn = (s) => Math.max(1, Math.round(s.length / 4));
const estOut = (s) => Math.max(1, Math.round(s.length / 4));

// Conversation-keyed directive queues: conv id -> { directives: [...], idx }
const convs = new Map();
let globalCallN = 0;

function flatContent(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join("");
    return String(c ?? "");
}

function acpRefs(body, role) {
    const raw = role === undefined
        ? JSON.stringify(body.messages ?? [])
        : JSON.stringify((body.messages ?? []).filter((x) => x?.role === role));
    const re = /\x3cacp\s+[^>]*?\x3e(m\d+)\x3c\/acp\x3e/g;
    const refs = [];
    let m;
    while ((m = re.exec(raw))) if (!refs.includes(m[1])) refs.push(m[1]);
    return refs;
}

function toolResultsOf(messages) {
    // Map assistant tool_call ids -> tool names, then collect role:"tool"
    // result contents keyed by that name (adjacency is enough for the oracle).
    const names = new Map();
    for (const msg of messages) {
        for (const tc of msg?.tool_calls ?? []) {
            if (tc?.id && tc?.function?.name) names.set(tc.id, tc.function.name);
        }
    }
    const out = [];
    for (const msg of messages) {
        if (msg?.role === "tool") {
            out.push({ name: names.get(msg.tool_call_id) ?? "?", content: String(flatContent(msg.content)).slice(0, 160) });
        }
    }
    return out;
}

// Balanced-brace JSON pinned after a directive name (braces may nest, e.g.
// compress's {"content":[{"startId":...}]}). Returns the matched slice or null.
function extractBalanced(text, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
            depth--;
            if (depth === 0) return text.slice(openIdx, i + 1);
        }
    }
    return null;
}

function parseDirectives(text) {
    const out = [];
    const re = /请调用([a-z0-9_]+)/g;
    let m;
    while ((m = re.exec(text))) {
        let args = {};
        let i = m.index + m[0].length;
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === "{") {
            const json = extractBalanced(text, i);
            if (json) {
                try { args = JSON.parse(json); } catch { args = {}; }
                re.lastIndex = i + json.length;
            }
        }
        out.push({ tool: m[1], args });
    }
    return out;
}

function compressArgs(refs) {
    // Fold ONLY the oldest user-message ref (m00001-style): run one's filler
    // message is the only oversized TAGGED payload on the wire (tool results
    // render untagged), and by run two it has left the kernel's protected
    // zone (last 5 messages / most recent user message).
    if (refs.length === 0) return {};
    const start = refs[0];
    return { content: [{ startId: start, endId: start, summary: "e2e fold: scripted compress round over the run-one filler message" }] };
}

function answerFor(convKey, firstUserText, body) {
    // Directives are parsed from the LAST user message: a `pi -p --continue`
    // follow-up run re-sends the whole history, and its fresh prompt must
    // own the queue — not the filler-heavy first message of run one.
    // Hosts that keep the scripted prompt in an EARLY user message and append
    // host-injected user-role context after it (dsh headless: the task, then
    // workspace-reminder + runtime-snapshot user messages, #1268) fall back to
    // the FIRST user message when the last one carries no markers — pi's
    // prompt always owns the last slot, so pi-lane behavior is unchanged.
    const messages = body.messages ?? [];
    const users = messages.filter((x) => x?.role === "user");
    // opencode fires a side-channel title-generation call (v1: separate
    // "Generate a title..." user message; v2: "You are a title generator"
    // system prompt) whose LAST user message is the real prompt — scripting
    // through it desyncs the queue before the main loop runs. Answer it
    // inertly, never touching queues. Contents carry ACP render-tag prefixes
    // (\x3cacp … \x3c/acp\x3e spans injected by the proxy), stripped before matching.
    const stripAcps = (s) => s.replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "");
    const isTitleCall =
        messages.some((m) => m?.role === "system" && /title generator/i.test(stripAcps(flatContent(m.content)))) ||
        users.some((u) => /^generate a title\b/i.test(stripAcps(flatContent(u.content)).trim()));
    if (isTitleCall) return { content: "e2e-title", queueIdx: -1 };
    const lastUserText = users.length > 0 ? flatContent(users[users.length - 1].content) : firstUserText;
    let sourceText = lastUserText;
    if (parseDirectives(lastUserText).length === 0 && users.length > 1) {
        const firstText = flatContent(users[0].content);
        if (firstText !== lastUserText && parseDirectives(firstText).length > 0) sourceText = firstText;
    }
    const queueKey = `${convKey}|${sourceText.slice(0, 64)}`;
    if (!convs.has(queueKey)) {
        convs.set(queueKey, { directives: parseDirectives(sourceText), idx: 0 });
    }
    const conv = convs.get(queueKey);
    const i = conv.idx++;
    const directive = conv.directives[i];
    if (!directive) return { content: "收到#done", queueIdx: i };
    let args = directive.args;
    if (directive.tool === "compress" && Object.keys(directive.args).length === 0) {
        args = compressArgs(acpRefs(body, "user"));
    }
    return {
        tool_calls: [{ id: `call_${++globalCallN}`, type: "function", function: { name: directive.tool, arguments: JSON.stringify(args) } }],
        queueIdx: i,
        toolName: directive.tool,
        toolArgs: args,
    };
}

const server = http.createServer((req, res) => {
    try {
        if (req.method === "GET" && /\/models$/.test(req.url)) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
            return;
        }
        if (req.method === "POST" && /\/chat\/completions$/.test(req.url)) {
            let raw = "";
            req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                let parsed = {};
                try { parsed = JSON.parse(raw || "{}"); } catch { /* noop */ }
                if (process.env.FAKE_DUMP) { try { fs.appendFileSync(process.env.FAKE_DUMP, raw + "\n"); } catch { /* noop */ } }
                const messages = parsed.messages ?? [];
                const users = messages.filter((x) => x?.role === "user");
                const firstUserText = users.length > 0 ? flatContent(users[0].content) : "";
                // ACP tag prefix of the LAST user message: lets suites cite the
                // exact ref of a known message (e.g. run-one's filler) without
                // guessing among example tags embedded in kernel prompt text.
                const lastUserMsg = users.length > 0 ? users[users.length - 1] : null;
                const lastUserRefMatch = lastUserMsg
                    ? flatContent(lastUserMsg.content).match(/\x3cacp\s+[^>]*?\x3e(m\d{5})\x3c\/acp\x3e/)
                    : null;
                const convKey = req.headers["x-bili-plugin-conversation"] ?? "anon";
                const reply = answerFor(convKey, firstUserText, parsed);
                try {
                    fs.appendFileSync(REQLOG, JSON.stringify({
                        t: Date.now(),
                        url: req.url,
                        stream: !!parsed.stream,
                        model: parsed.model,
                        plugin: req.headers["x-bili-plugin"] ?? null,
                        conv: req.headers["x-bili-plugin-conversation"] ?? null,
                        ctxwin: req.headers["x-bili-plugin-context-window"] ?? null,
                        maxout: req.headers["x-bili-plugin-max-output"] ?? null,
                        tools: (parsed.tools ?? []).map((t) => t?.function?.name ?? t?.name),
                        nmsg: messages.length,
                        roles: messages.map((x) => x?.role).join(","),
                        acpRefs: acpRefs(parsed),
                        acpToolRefs: acpRefs(parsed, "tool"),
                        acpTagCount: (JSON.stringify(messages).match(/\x3cacp\s/g) ?? []).length,
                        toolResults: toolResultsOf(messages),
                        queueIdx: reply.queueIdx,
                        toolName: reply.toolName ?? null,
                        toolArgs: reply.toolArgs ?? null,
                        lastUser: firstUserText.slice(0, 120),
                        lastUserRef: lastUserRefMatch ? lastUserRefMatch[1] : null,
                    }) + "\n");
                } catch { /* noop */ }
                if (parsed.stream) {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                    const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", model: parsed.model ?? MODEL, created: Math.floor(Date.now() / 1000) };
                    let chunks;
                    if (reply.tool_calls) {
                        chunks = [
                            { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: reply.tool_calls[0].id, type: "function", function: { name: reply.tool_calls[0].function.name, arguments: "" } }] }, finish_reason: null }] },
                            { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: reply.tool_calls[0].function.arguments } }] }, finish_reason: null }] },
                            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
                        ];
                    } else {
                        chunks = [
                            { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.content }, finish_reason: null }] },
                            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                        ];
                    }
                    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
                    res.write("data: [DONE]\n\n");
                    res.end();
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        id: "chatcmpl-fake", object: "chat.completion", model: parsed.model ?? MODEL, created: Math.floor(Date.now() / 1000),
                        choices: [{ index: 0, message: { role: "assistant", ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : { content: reply.content }) }, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }],
                        usage: { prompt_tokens: estIn(raw), completion_tokens: estOut(String(reply.content ?? "tool")), total_tokens: estIn(raw) + 3 },
                    }));
                }
            });
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
    } catch (e) {
        try { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(e) } })); } catch { /* noop */ }
    }
});
server.listen(PORT, HOST, () => {
    const actual = server.address().port;
    console.log(`fake chat upstream listening on http://${HOST}:${actual}/v1`);
    if (PORT_FILE) {
        try { fs.writeFileSync(PORT_FILE, String(actual)); } catch { /* noop */ }
    }
});
