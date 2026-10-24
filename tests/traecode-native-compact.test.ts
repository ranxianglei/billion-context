import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";
import { createHash } from "node:crypto";
import { TRAE_NATIVE_COMPACT_SENTENCE, neutralizeTraeNativeCompactInstruction, stripTraeCodeNativeCompactInstruction } from "../src/server/traecode-compact.js";
import { looksLikeNativeCompactionRequest, stripLeadingAcpTags } from "../src/server/native-compact-shape.js";

process.env.NODE_ENV = "test";

// #2411 Phase 1: TRAE Code's native auto-compact instruction must not reach
// the model in the same request as bili's injected compression philosophy.
// Fixtures reproduce the reporter's verbatim local context (#2411 floor 4):
// bullet at char offset 1270 of the single 42,385-char role=system string,
// system sha256 prefix e477d92761e39731 stable across 4 dumps / 2 sessions.

const PREV_BULLET = "…terminal status, linter errors, and current mode. This information is provided in case it is helpful to the task.";
const SYSTEM_HEAD = `${PREV_BULLET}\n`;
const TRACKED_LINE = `  - ${TRAE_NATIVE_COMPACT_SENTENCE}`;
const SYSTEM_TAIL = `\n\n# Doing tasks\nbe decisive.`;
const TRAECODE_SYSTEM = SYSTEM_HEAD + TRACKED_LINE + SYSTEM_TAIL;
const EXPECTED_CLEAN = `${SYSTEM_HEAD}\n# Doing tasks\nbe decisive.`;

test("neutralizer: removes exactly the tracked bullet line, head/tail bytes intact", () => {
    const r = neutralizeTraeNativeCompactInstruction(TRAECODE_SYSTEM);
    assert.equal(r.removed, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, EXPECTED_CLEAN);
    assert.ok(r.text.startsWith(SYSTEM_HEAD), "head prefix byte-stable (cache-neutral)");
    assert.ok(!r.text.includes(TRAE_NATIVE_COMPACT_SENTENCE));
});

test("neutralizer: idempotent — second pass removes nothing", () => {
    const once = neutralizeTraeNativeCompactInstruction(TRAECODE_SYSTEM);
    const twice = neutralizeTraeNativeCompactInstruction(once.text);
    assert.equal(twice.removed, 0);
    assert.equal(twice.text, once.text);
});

test("neutralizer: no tracked sentence → byte-identical passthrough", () => {
    const r = neutralizeTraeNativeCompactInstruction(SYSTEM_HEAD + "# Doing tasks\ntext");
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, SYSTEM_HEAD + "# Doing tasks\ntext");
});

test("neutralizer: sentence embedded mid-line → shapeDrift, NOT modified", () => {
    const drifted = SYSTEM_HEAD + `  - ${TRAE_NATIVE_COMPACT_SENTENCE} Additionally, context may reset.\n\n# Doing tasks`;
    const r = neutralizeTraeNativeCompactInstruction(drifted);
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, true);
    assert.equal(r.text, drifted);
});

test("neutralizer: sentence without a bullet marker → shapeDrift, NOT modified", () => {
    const drifted = SYSTEM_HEAD + `${TRAE_NATIVE_COMPACT_SENTENCE}\n\n# Doing tasks`;
    const r = neutralizeTraeNativeCompactInstruction(drifted);
    assert.equal(r.removed, 0);
    assert.equal(r.shapeDrift, true);
    assert.equal(r.text, drifted);
});

test("neutralizer: CRLF line endings handled", () => {
    const crlf = `A\r\n  - ${TRAE_NATIVE_COMPACT_SENTENCE}\r\n\r\nB`;
    const r = neutralizeTraeNativeCompactInstruction(crlf);
    assert.equal(r.removed, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal(r.text, `A\r\n\r\nB`);
});

test("strip: system string rewritten in place, other messages untouched", () => {
    const user = { role: "user", content: "hi" };
    const assistant = { role: "assistant", content: "yo" };
    const msgs = [
        { role: "system", content: TRAECODE_SYSTEM },
        user,
        assistant,
        { role: "tool", content: "result" },
    ];
    const r = stripTraeCodeNativeCompactInstruction(msgs);
    assert.equal(r.neutralized, 1);
    assert.equal(r.shapeDrift, false);
    assert.equal((msgs[0] as { content: string }).content, EXPECTED_CLEAN);
    assert.deepEqual(user.content, "hi");
    assert.deepEqual(assistant.content, "yo");
});

test("strip: parts-array system content degrades to no-op (evidence covers string form only)", () => {
    const part = { type: "text", text: TRAECODE_SYSTEM };
    const msgs = [{ role: "system", content: [part] }, { role: "user", content: "hi" }];
    const r = stripTraeCodeNativeCompactInstruction(msgs);
    assert.equal(r.neutralized, 0);
    assert.equal(r.shapeDrift, false);
    assert.equal(part.text, TRAECODE_SYSTEM);
});

test("strip: non-array input → zero", () => {
    assert.deepEqual(stripTraeCodeNativeCompactInstruction(undefined), { neutralized: 0, shapeDrift: false });
    assert.deepEqual(stripTraeCodeNativeCompactInstruction({}), { neutralized: 0, shapeDrift: false });
});

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function startMockUpstream(bodies: string[]): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
            res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

async function postChat(url: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 1024, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    await res.arrayBuffer();
}

test("e2e: TraeCode-shaped chat-completions request forwards ONE compression philosophy (#2411)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const bodies: string[] = [];
    const upstream = startMockUpstream(bodies);
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    try {
        // the conflicting native instruction is gone, the acp tool surface is
        // present, surrounding system bytes are intact
        await postChat(url, [
            { role: "system", content: TRAECODE_SYSTEM },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
        ]);
        assert.equal(bodies.length, 1, "request reached upstream");
        const sent1 = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function?: { name?: string } }> };
        const sys1 = sent1.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(!sys1.includes(TRAE_NATIVE_COMPACT_SENTENCE), "native auto-compact instruction stripped");
        assert.ok(sys1.startsWith(PREV_BULLET), "system head prefix intact");
        assert.ok(sys1.includes("# Doing tasks"), "system tail intact after removal");
        assert.ok(sent1.tools?.some((t) => t.function?.name === "compress"), "acp compress tool injected in the same request");

        // continuation of the same conversation stays clean
        await postChat(url, [
            { role: "system", content: TRAECODE_SYSTEM },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
            { role: "assistant", content: "second answer" },
            { role: "user", content: "third question" },
        ]);
        const sent2 = JSON.parse(bodies[1]) as { messages: Array<{ role: string; content: string }> };
        const sys2 = sent2.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(!sys2.includes(TRAE_NATIVE_COMPACT_SENTENCE), "continuation request stripped too");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

// #2411 Class A: host-native compaction requests (the host summarization
// template as last user message) must NOT carry bili compression surface —
// not the doctrine system text, not the compress tool schema, not the nudge.
// Fixture = the live template verbatim from the reporter thread. Canonical
// store original per reporter correction: 6861 bytes raw-LF,
// sha256 d56eeae339bd80074e43d4531e23776958cb7d9d84fc2740511d29d2dc392068;
// the thread-pasted copy below lost 4 bytes (newlines) in markdown transit —
// the pin covers THIS fixture so any accidental edit fails loudly. Anchors
// are the contract, not the full hash.
const TEMPLATE_6861 = "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.\nThis summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.\nThis summary should be in the SAME LANGUAGE as <user_input/> section.\n\nBefore providing your final summary,you should ensure you've covered all necessary points.\n1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:\n  - The user's explicit requests and intents\n  - Your approach to addressing the user's requests\n  - Key decisions, technical concepts and code patterns\n  - Specific details like:\n    - file names\n    - full code snippets\n    - function signatures\n    - file edits\n  - Errors that you ran into and how you fixed them\n  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.\n2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.\n\nYour summary should include the following sections:\n1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail\n2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.\n3. Files and Code Sections: Document ALL files and code sections examined, modified, or created during the conversation. Use absolute paths for all files. Pay special attention to the most recent messages and include full code snippets where applicable. For each file operation, include a summary of why this file read or edit is important. PRIORITIZATION: Focus detailed code snippets and descriptions on files that show signs of ongoing development (incomplete implementations, recent modifications, files referenced in current work, or files likely needed for next steps). For completed/stable files from earlier in the conversation, provide brief mentions unless they remain relevant to current tasks.\n4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.\n5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.\n6. All user messages: Document actual user communications from the conversation history, preserving original language and wording (DO NOT translate - record exact original text verbatim). For lengthy messages, focus on key user instructions and requests. **CRITICAL: DO NOT include this current summarization request.** EXCLUDE: tool results, system-generated content, content within <system-reminder> tags, and quoted materials. Focus on user's direct personal communication. (Note: quoted materials include GitHub issues, documentation excerpts, error messages, and other external referenced content)\n7. Pending Tasks: Outline any pending tasks that you have been explicitly asked to work on.\n8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.\n9. Working on Plan/Spec: If you are following or working on any plan or spec, include its **file path(s)** here. If you have worked on multiple specs, include only the lastest one.\n10. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests without confirming with the user first. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.\n11. Conversation Language: Identify the primary language the user uses for their own thoughts, questions, and instructions. Focus ONLY on the user's direct personal communication, excluding quoted content, code, documentation, system-reminder tags, and third-party materials. When mixed languages appear, prioritize the language used for personal instructions and task descriptions over quoted technical content.\n\n<example>\n\n<summary>\n1. Primary Request and Intent:\n  [Detailed description]\n\n2. Key Technical Concepts:\n  - [Concept 1]\n  - [Concept 2]\n  - [...]\n\n3. Files and Code Sections:\n  Recent/Ongoing Development (detailed):\n    - [/absolute/path/to/file1.ext]:\n      - Status: [Created/Modified]\n      - Why important: [Relevance to current work/next steps]\n      - Changes: [Summary of modifications made OR current implementation status]\n      - Key code snippets: [Important implementation details - include actual code when relevant]\n    - [/absolute/path/to/file2.ext]:\n      - Status: [Examined]\n      - Why important: [How future work depends on this file OR incomplete implementation needing attention]\n      - Current state: [Brief status and key functionality summary]\n      - Key code snippets: [Critical interfaces, configurations, or implementations that future work will reference]\n    - [...]\n\n  Stable/Completed Files (brief mentions):\n    - [/absolute/path/to/file3.ext]: [Brief description of completed functionality]\n    - [...]\n\n4. Errors and fixes:\n    - [Detailed description of error 1]:\n      - [How you fixed the error]\n      - [User feedback on the error if any]\n    - [...]\n\n5. Problem Solving:\n  [Description of solved problems and ongoing troubleshooting]\n\n6. All user messages:\n  - [User's key instructions in original language - exclude quoted content]\n  - [User's direct requests and feedback in original language]\n  - [Focus on user's personal communication, not system/quoted materials]\n  - [NOTE: This section should NOT include the current \"create a summary\" request]\n\n7. Pending Tasks:\n  - [Task 1]\n  - [Task 2]\n  - [...]\n\n8. Current Work:\n  [Precise description of current work]\n\n9. Working on Plan/Spec (Optional):\n  [File Path(s) of the plan or spec are following or working on]\n\n10. Optional Next Step:\n  [Optional Next step to take]\n\n11. Conversation Language:\n  Primary language: [Chinese/English/etc.] - based on user's direct personal communication, excluding quoted materials and system content\n\n</summary>\n</example>\n\nPlease provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.";
assert.equal(TEMPLATE_6861.length, 6857, "fixture length drift");
assert.equal(createHash("sha256").update(TEMPLATE_6861, "utf8").digest("hex"), "eaa2c6926063d25bde6b3a30fd1ed458a4c7a139ad7b082484a5deb44d5451d3", "fixture byte-drift");

const HOST_SUMMARY_SYSTEM = "You are a helpful AI assistant tasked with summarizing conversations.";
const NATIVE_TOOLS = [{ type: "function", function: { name: "run_mcp", description: "mcp" } }];

function compactBody(lastUserContent: string): { messages: Array<{ role: string; content: string }> } {
    return { messages: [
        { role: "system", content: HOST_SUMMARY_SYSTEM },
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: lastUserContent },
    ] };
}

test("shape: full live template as last user message → native compaction", () => {
    assert.equal(looksLikeNativeCompactionRequest(compactBody(TEMPLATE_6861)), true);
});

test("shape: minimal lead+tail synthetic → native compaction (both variants share these)", () => {
    const min = "Your task is to create a detailed summary of the conversation so far, paying close attention.\n\nPlease provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.";
    assert.equal(looksLikeNativeCompactionRequest(compactBody(min)), true);
});

test("shape: manual /compact form (trim-exact) → native compaction", () => {
    assert.equal(looksLikeNativeCompactionRequest(compactBody("/compact")), true);
    assert.equal(looksLikeNativeCompactionRequest(compactBody("  /compact  ")), true);
});

test("shape: ACP render-tag prefix on the template is tolerated", () => {
    const tagged = "\x3cacp tokens=\"1.2K\" type=\"text\"\x3em00042\x3c/acp\x3e" + TEMPLATE_6861;
    assert.equal(looksLikeNativeCompactionRequest(compactBody(tagged)), true);
});

test("shape: lead without tail → NOT native compaction (fail open)", () => {
    assert.equal(looksLikeNativeCompactionRequest(compactBody("Your task is to create a detailed summary of the conversation so far, please.")), false);
});

test("shape: tail without lead → NOT native compaction (fail open)", () => {
    assert.equal(looksLikeNativeCompactionRequest(compactBody("Here you go. Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.")), false);
});

test("shape: lead+tail in a non-last message → NOT native compaction (fail open)", () => {
    const body = compactBody(TEMPLATE_6861);
    body.messages.push({ role: "user", content: "and now continue" });
    assert.equal(looksLikeNativeCompactionRequest(body), false);
});

test("shape: template carried by an assistant message → NOT native compaction (fail open)", () => {
    const body = compactBody("normal turn");
    body.messages.push({ role: "assistant", content: TEMPLATE_6861 });
    assert.equal(looksLikeNativeCompactionRequest(body), false);
});

test("shape: parts-array content → NOT native compaction (evidence covers string form only)", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: TEMPLATE_6861 }] }] };
    assert.equal(looksLikeNativeCompactionRequest(body), false);
});

test("shape: degenerate inputs fail open", () => {
    assert.equal(looksLikeNativeCompactionRequest(undefined), false);
    assert.equal(looksLikeNativeCompactionRequest({}), false);
    assert.equal(looksLikeNativeCompactionRequest({ messages: [] }), false);
    assert.equal(looksLikeNativeCompactionRequest({ messages: [{ role: "user", content: "   " }] }), false);
    assert.equal(looksLikeNativeCompactionRequest({ messages: [{ role: "user", content: null }] }), false);
});

test("shape: case-mutated lead → NOT native compaction (anchors are case-sensitive)", () => {
    const lower = TEMPLATE_6861[0].toLowerCase() + TEMPLATE_6861.slice(1);
    assert.equal(looksLikeNativeCompactionRequest(compactBody(lower)), false);
});

test("e2e: host-native compaction request forwards with ZERO bili compression surface (#2411 Class A)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const bodies: string[] = [];
    const upstream = startMockUpstream(bodies);
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    try {
        // THE compaction act: host summarization system + template as last user
        await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 1024, tools: NATIVE_TOOLS, messages: compactBody(TEMPLATE_6861).messages }),
        }).then((r) => r.arrayBuffer());
        assert.equal(bodies.length, 1, "compaction request reached upstream");
        const sentA = JSON.parse(bodies[0]) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ type?: string; function?: { name?: string } }> };
        const sysA = sentA.messages.find((m) => m.role === "system")?.content ?? "";
        assert.equal(sysA, HOST_SUMMARY_SYSTEM, "host summarization system passes through byte-stable (no doctrine, no tags-only note)");
        assert.ok(!bodies[0].includes("Compression Philosophy"), "no compress doctrine anywhere in the outbound body");
        assert.ok(!sentA.tools?.some((t) => t.function?.name === "compress"), "no compress tool schema added");
        assert.deepEqual(sentA.tools, NATIVE_TOOLS, "native tool list untouched");
        assert.equal(sentA.messages.length, 4, "no injected ephemeral messages (nudge/retrieval notes)");
        assert.equal(stripLeadingAcpTags(sentA.messages[3].content), TEMPLATE_6861, "template reaches upstream intact modulo bili's standard outbound render-tag/separator normalization");

        // control: an ordinary chat request on a different session keeps the full surface
        await postChat(url, [
            { role: "system", content: "You are a coding assistant." },
            { role: "user", content: "hello" },
        ]);
        assert.equal(bodies.length, 2);
        const sentB = JSON.parse(bodies[1]) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function?: { name?: string } }> };
        const sysB = sentB.messages.find((m) => m.role === "system")?.content ?? "";
        assert.ok(sysB.includes("Compression Philosophy"), "control request carries the doctrine (gate is per-request, not global)");
        assert.ok(sentB.tools?.some((t) => t.function?.name === "compress"), "control request gets the compress tool");

        // continuation: the surface is NOT latched off after a compaction turn
        await postChat(url, [
            { role: "system", content: "You are a coding assistant." },
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "next question" },
        ]);
        const sentC = JSON.parse(bodies[2]) as { tools?: Array<{ function?: { name?: string } }> };
        assert.ok(sentC.tools?.some((t) => t.function?.name === "compress"), "surface restored on the next ordinary turn");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
