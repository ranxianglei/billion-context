// Deterministic fake chat-completions upstream for the native-client E2E lanes
// (#1239): drives a REAL host client (`pi`, `opencode`) through bili's native
// extension so interception, plugin-mode stamping, ACP tool registration and
// compression ACTUALLY happen in-process, no real model/network. The prompt of
// the FIRST user message scripts the conversation: every "请调用<tool>" marker
// becomes one queued tool round ("请调用<tool> {json}" pins the arguments —
// braces may nest); when the queue is exhausted the model answers plain text
// "收到#done". `compress` with no explicit args is
// special-cased: the fake cites REAL refs harvested from the request's ACP tags
// so the kernel has a foldable range. Every request — /chat/completions AND
// /v1/messages (anthropic SSE, #2791 cross-protocol lanes) — is appended to
// FAKE_REQLOG (JSONL) as the assertion oracle, with a `wire` field.
// The anthropic wire renders the same logical conversation differently
// (top-level system, content BLOCKS, tool_use objects, tool_result inside the
// next user message), so /v1/messages bodies are normalized to the openai-ish
// shape this scripting core already understands; a session that switches
// wires mid-flight keeps its directive queue and oracle fields.

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
            // 400 (not 160): the compress receipt carries its subagent-session
            // note AFTER the fingerprint line (~185 chars total) — 160 would
            // cut exactly that assertion surface off (e2e-subagent-sessions).
            out.push({ name: names.get(msg.tool_call_id) ?? "?", content: String(flatContent(msg.content)).slice(0, 400) });
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
    // #4823 narrowed the advertised schema to the single string form; hosts
    // like opencode/pi validate tool args against it client-side, so the
    // scripted call must use the canonical string (the array form is still
    // accepted by bili's lenient parser but dies at host validation).
    return { content: `${start}–${start} e2e fold\nscripted compress round over the run-one filler message` };
}

// A chain-checkpoint carrier (<bili-chain ... /> #1421 step 3) rides as a
// standalone trailing USER message on the openai wire. It is transport
// metadata, not conversation: "last user message" semantics below (the
// scripted directive queue source and the lastUserRef oracle) must skip it,
// or the carrier masks the real prompt and the scripted compress never fires.
const isChainCarrierMsg = (m) =>
    m?.role === "user" && /^\s*\x3cbili-chain\s[\s\S]*\/\x3e\s*$/.test(String(flatContent(m.content)));

function anthropicToOpenai(body) {
    const out = [];
    const sys = body.system;
    const sysText = typeof sys === "string" ? sys : Array.isArray(sys) ? sys.map((b) => (b && b.text) || "").join("") : "";
    if (sysText) out.push({ role: "system", content: sysText });
    for (const m of body.messages ?? []) {
        const blocks = Array.isArray(m?.content)
            ? m.content
            : typeof m?.content === "string" ? [{ type: "text", text: m.content }] : [];
        if (m?.role === "assistant") {
            const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
            const tus = blocks.filter((b) => b?.type === "tool_use");
            if (tus.length > 0) {
                out.push({ role: "assistant", content: text || null, tool_calls: tus.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) });
            } else if (text) {
                out.push({ role: "assistant", content: text });
            }
        } else {
            for (const tr of blocks.filter((b) => b?.type === "tool_result")) {
                out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "") });
            }
            const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
            if (text) out.push({ role: "user", content: text });
        }
    }
    return {
        messages: out,
        model: body.model,
        stream: body.stream,
        tools: (body.tools ?? []).map((t) => ({ function: { name: t?.name } })),
        nmsgNative: (body.messages ?? []).length,
    };
}

function responsesToOpenai(body) {
    // Responses-API input items (pi `openai-responses`, codex): message items
    // carry content blocks; function_call / function_call_output arrive as
    // SIBLING items. Normalized to the openai-ish shape the scripting core
    // understands so a session that switches onto this wire keeps its
    // directive queue and oracle fields.
    const out = [];
    if (typeof body.instructions === "string" && body.instructions) {
        out.push({ role: "system", content: body.instructions });
    }
    for (const it of body.input ?? []) {
        if (it?.type === "function_call") {
            out.push({ role: "assistant", content: null, tool_calls: [{ id: it.call_id ?? it.id, type: "function", function: { name: it.name, arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) } }] });
        } else if (it?.type === "function_call_output") {
            out.push({ role: "tool", tool_call_id: it.call_id, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
        } else if (it?.type === "message") {
            const text = flatContent(it.content);
            if (text) out.push({ role: it.role, content: text });
        }
    }
    return {
        messages: out,
        model: body.model,
        stream: body.stream,
        tools: (body.tools ?? []).map((t) => ({ function: { name: t?.name } })),
        nmsgNative: (body.input ?? []).length,
    };
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
    const users = messages.filter((x) => x?.role === "user" && !isChainCarrierMsg(x));
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
    if (isTitleCall) return { content: "e2e-title", queueIdx: -1, title: true };
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
                const users = messages.filter((x) => x?.role === "user" && !isChainCarrierMsg(x));
                const firstUserText = users.length > 0 ? flatContent(users[0].content) : "";
                // ACP tag prefix of the LAST user message: lets suites cite the
                // exact ref of a known message (e.g. run-one's filler) without
                // guessing among example tags embedded in kernel prompt text.
                const lastUserMsg = users.length > 0 ? users[users.length - 1] : null;
                const lastUserRefMatch = lastUserMsg
                    ? flatContent(lastUserMsg.content).match(/\x3cacp\s+[^>]*?\x3e(m\d{5})\x3c\/acp\x3e/)
                    : null;
                const convKey = req.headers["x-bili-plugin-conversation"] ?? "anon";
                // #2546: user messages carrying an acp_delegate completion
                // notification ("[acp_delegate ..." prefix — notification texts
                // only). Lets suites assert the notification PERSISTS across
                // requests: a request-local injection would show up in exactly
                // one row, a persisted session message in every later one.
                const notifCount = users.filter((u) => flatContent(u.content).replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "").includes("[acp_delegate")).length;
                const reply = answerFor(convKey, firstUserText, parsed);
                try {
                    fs.appendFileSync(REQLOG, JSON.stringify({
                        t: Date.now(),
                        url: req.url,
                        wire: "openai",
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
                        fillerHits: (raw.match(/filler line \d+/g) ?? []).length,
                        toolResults: toolResultsOf(messages),
                        queueIdx: reply.queueIdx,
                        toolName: reply.toolName ?? null,
                        toolArgs: reply.toolArgs ?? null,
                        lastUser: firstUserText.slice(0, 120),
                        // head of the TRUE last user message (lastUser above
                        // is the first user message's head — historical
                        // field name): lets follow-up runs be identified by
                        // their own prompt once the filler dominates the head.
                        lastUserHead: (lastUserMsg ? flatContent(lastUserMsg.content) : "").slice(0, 120),
                        lastUserRef: lastUserRefMatch ? lastUserRefMatch[1] : null,
                        // #1699: title side-channel marker — after the fix these
                        // rows route VERBATIM (no ref tags, no injected tools),
                        // so suites must not mistake them for main turns.
                        title: reply.title === true,
                        notifCount,
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
        if (req.method === "POST" && /\/messages\/count_tokens$/.test(req.url)) {
            let raw = ""; req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
            });
            return;
        }
        if (req.method === "POST" && /\/(v1\/)?messages$/.test(req.url)) {
            let raw = "";
            req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                let parsed = {};
                try { parsed = JSON.parse(raw || "{}"); } catch { /* noop */ }
                if (process.env.FAKE_DUMP) { try { fs.appendFileSync(process.env.FAKE_DUMP, raw + "\n"); } catch { /* noop */ } }
                const norm = anthropicToOpenai(parsed);
                const messages = norm.messages;
                const users = messages.filter((x) => x?.role === "user" && !isChainCarrierMsg(x));
                const firstUserText = users.length > 0 ? flatContent(users[0].content) : "";
                const lastUserMsg = users.length > 0 ? users[users.length - 1] : null;
                const lastUserRefMatch = lastUserMsg
                    ? flatContent(lastUserMsg.content).match(/\x3cacp\s+[^>]*?\x3e(m\d{5})\x3c\/acp\x3e/)
                    : null;
                const convKey = req.headers["x-bili-plugin-conversation"] ?? "anon";
                const notifCount = users.filter((u) => flatContent(u.content).replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "").includes("[acp_delegate")).length;
                const reply = answerFor(convKey, firstUserText, { messages, tools: norm.tools });
                try {
                    fs.appendFileSync(REQLOG, JSON.stringify({
                        t: Date.now(),
                        url: req.url,
                        wire: "anthropic",
                        stream: !!parsed.stream,
                        model: parsed.model,
                        plugin: req.headers["x-bili-plugin"] ?? null,
                        conv: req.headers["x-bili-plugin-conversation"] ?? null,
                        ctxwin: req.headers["x-bili-plugin-context-window"] ?? null,
                        maxout: req.headers["x-bili-plugin-max-output"] ?? null,
                        tools: (parsed.tools ?? []).map((t) => t?.name),
                        nmsg: norm.nmsgNative,
                        roles: messages.map((x) => x?.role).join(","),
                        acpRefs: acpRefs(parsed),
                        acpToolRefs: acpRefs(parsed, "tool"),
                        acpTagCount: (JSON.stringify(parsed.messages ?? []).match(/\x3cacp\s/g) ?? []).length,
                        fillerHits: (raw.match(/filler line \d+/g) ?? []).length,
                        toolResults: toolResultsOf(messages),
                        queueIdx: reply.queueIdx,
                        toolName: reply.toolName ?? null,
                        toolArgs: reply.toolArgs ?? null,
                        lastUser: firstUserText.slice(0, 120),
                        lastUserHead: (lastUserMsg ? flatContent(lastUserMsg.content) : "").slice(0, 120),
                        lastUserRef: lastUserRefMatch ? lastUserRefMatch[1] : null,
                        title: reply.title === true,
                        notifCount,
                    }) + "\n");
                } catch { /* noop */ }
                const usageIn = estIn(raw);
                if (parsed.stream) {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    ev("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: parsed.model ?? MODEL, usage: { input_tokens: usageIn, output_tokens: 1 } } });
                    ev("content_block_start", { type: "content_block_start", index: 0, content_block: reply.tool_calls ? { type: "tool_use", id: reply.tool_calls[0].id, name: reply.tool_calls[0].function.name, input: {} } : { type: "text", text: "" } });
                    if (reply.tool_calls) {
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: reply.tool_calls[0].function.arguments } });
                    } else {
                        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.content } });
                    }
                    ev("content_block_stop", { type: "content_block_stop", index: 0 });
                    ev("message_delta", { type: "message_delta", delta: { stop_reason: reply.tool_calls ? "tool_use" : "end_turn" }, usage: { output_tokens: reply.tool_calls ? 5 : estOut(String(reply.content ?? "")) } });
                    ev("message_stop", { type: "message_stop" });
                    res.end();
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        id: "msg_fake", type: "message", role: "assistant", model: parsed.model ?? MODEL,
                        content: reply.tool_calls
                            ? [{ type: "tool_use", id: reply.tool_calls[0].id, name: reply.tool_calls[0].function.name, input: JSON.parse(reply.tool_calls[0].function.arguments || "{}") }]
                            : [{ type: "text", text: reply.content }],
                        stop_reason: reply.tool_calls ? "tool_use" : "end_turn",
                        usage: { input_tokens: usageIn, output_tokens: estOut(String(reply.content ?? "tool")) },
                    }));
                }
            });
            return;
        }
        if (req.method === "POST" && /\/responses$/.test(req.url)) {
            let raw = "";
            req.on("data", (c) => { raw += c; });
            req.on("end", () => {
                let parsed = {};
                try { parsed = JSON.parse(raw || "{}"); } catch { /* noop */ }
                if (process.env.FAKE_DUMP) { try { fs.appendFileSync(process.env.FAKE_DUMP, raw + "\n"); } catch { /* noop */ } }
                const norm = responsesToOpenai(parsed);
                const messages = norm.messages;
                const users = messages.filter((x) => x?.role === "user" && !isChainCarrierMsg(x));
                const firstUserText = users.length > 0 ? flatContent(users[0].content) : "";
                const lastUserMsg = users.length > 0 ? users[users.length - 1] : null;
                const lastUserRefMatch = lastUserMsg
                    ? flatContent(lastUserMsg.content).match(/\x3cacp\s+[^>]*?\x3e(m\d{5})\x3c\/acp\x3e/)
                    : null;
                const convKey = req.headers["x-bili-plugin-conversation"] ?? "anon";
                const notifCount = users.filter((u) => flatContent(u.content).replace(/\x3cacp\b[^>]*\x3e[\s\S]*?\x3c\/acp\x3e/g, "").includes("[acp_delegate")).length;
                const reply = answerFor(convKey, firstUserText, { messages, tools: norm.tools });
                try {
                    fs.appendFileSync(REQLOG, JSON.stringify({
                        t: Date.now(),
                        url: req.url,
                        wire: "responses",
                        stream: !!parsed.stream,
                        model: parsed.model,
                        plugin: req.headers["x-bili-plugin"] ?? null,
                        conv: req.headers["x-bili-plugin-conversation"] ?? null,
                        ctxwin: req.headers["x-bili-plugin-context-window"] ?? null,
                        maxout: req.headers["x-bili-plugin-max-output"] ?? null,
                        tools: (parsed.tools ?? []).map((t) => t?.name),
                        nmsg: norm.nmsgNative,
                        roles: messages.map((x) => x?.role).join(","),
                        acpTagCount: (JSON.stringify(parsed.input ?? []).match(/\x3cacp\s/g) ?? []).length,
                        fillerHits: (raw.match(/filler line \d+/g) ?? []).length,
                        toolResults: toolResultsOf(messages),
                        queueIdx: reply.queueIdx,
                        toolName: reply.toolName ?? null,
                        toolArgs: reply.toolArgs ?? null,
                        lastUser: firstUserText.slice(0, 120),
                        lastUserHead: (lastUserMsg ? flatContent(lastUserMsg.content) : "").slice(0, 120),
                        lastUserRef: lastUserRefMatch ? lastUserRefMatch[1] : null,
                        title: reply.title === true,
                        notifCount,
                    }) + "\n");
                } catch { /* noop */ }
                const usageIn = estIn(raw);
                const rid = `resp_fake_${++globalCallN}`;
                const fcId = `fc_${rid}`;
                const msgId = `msg_${rid}`;
                const item = reply.tool_calls
                    ? { type: "function_call", id: fcId, call_id: reply.tool_calls[0].id, name: reply.tool_calls[0].function.name, arguments: reply.tool_calls[0].function.arguments, status: "completed" }
                    : { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: String(reply.content ?? ""), annotations: [] }] };
                if (parsed.stream) {
                    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
                    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    ev("response.created", { type: "response.created", response: { id: rid, object: "response", status: "in_progress", output: [] } });
                    ev("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(reply.tool_calls ? { arguments: "" } : { content: [] }) } });
                    if (reply.tool_calls) {
                        ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: fcId, output_index: 0, delta: reply.tool_calls[0].function.arguments });
                        ev("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: fcId, output_index: 0, arguments: reply.tool_calls[0].function.arguments });
                    } else {
                        ev("response.content_part.added", { type: "response.content_part.added", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
                        ev("response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: String(reply.content ?? "") });
                        ev("response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text: String(reply.content ?? "") });
                        ev("response.content_part.done", { type: "response.content_part.done", item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: String(reply.content ?? ""), annotations: [] } });
                    }
                    ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
                    ev("response.completed", { type: "response.completed", response: { id: rid, object: "response", model: parsed.model ?? MODEL, status: "completed", output: [item], usage: { input_tokens: usageIn, output_tokens: reply.tool_calls ? 5 : estOut(String(reply.content ?? "")), total_tokens: usageIn + 10 } } });
                    res.write("data: [DONE]\n\n");
                    res.end();
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ id: rid, object: "response", status: "completed", model: parsed.model ?? MODEL, output: [item], usage: { input_tokens: usageIn, output_tokens: estOut(String(reply.content ?? "tool")) } }));
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
