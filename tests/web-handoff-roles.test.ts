// #2065: the session-detail handoff card must not split a message on in-body
// Markdown headings. The kernel writes role dividers as "### <role>"; a user's
// rules doc legitimately contains "### 7.1 …" lines, which the old renderer
// promoted into their own blocks and mislabeled `assistant`. Only known roles
// may open a block — everything else is content.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";
import { createInitialState } from "acp-kernel";
import { renderHandoff, HANDOFF_THINK_END } from "../src/export.ts";
import { snapshotMessages, type Session } from "../src/session.ts";

interface DomEl {
    tagName: string;
    innerHTML: string;
    textContent: string;
    value: string;
    hidden: boolean;
    style: Record<string, unknown>;
    dataset: Record<string, unknown>;
    className: string;
    title: string;
    children: unknown[];
    classList: { add(): void; remove(): void; contains(): boolean; toggle(): void };
    addEventListener(): void;
    removeEventListener(): void;
    appendChild(child: { tagName: string; innerHTML: string }): DomEl;
    remove(): void;
    focus(): void;
    blur(): void;
    select(): void;
    click(): void;
    getAttribute(name: string): unknown;
    setAttribute(name: string, v: unknown): void;
    querySelector(): null;
    querySelectorAll(): never[];
    closest(): null;
    getContext(): null;
}

function makeDomStub(tag: string): DomEl {
    const el = {
        tagName: tag.toUpperCase(),
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        style: {},
        dataset: {},
        className: "",
        title: "",
        children: [] as unknown[],
        classList: { add() { }, remove() { }, contains() { return false; }, toggle() { } },
        addEventListener() { },
        removeEventListener() { },
        appendChild(child: { tagName: string; innerHTML: string }) {
            el.children.push(child);
            const t = child.tagName.toLowerCase();
            el.innerHTML += `<${t}>${child.innerHTML}</${t}>`;
            return child as DomEl;
        },
        remove() { }, focus() { }, blur() { }, select() { }, click() { },
        getAttribute(name: string) { return (el as unknown as Record<string, unknown>)[name] ?? null; },
        setAttribute(name: string, v: unknown) { (el as unknown as Record<string, unknown>)[name] = String(v); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getContext() { return null; },
    };
    return el as DomEl;
}

// Load the real WEB_CLIENT in a hermetic sandbox. fetch never resolves so the
// immediate route()→loadOverview() suspends instead of touching the network.
function loadRenderer(): (md: string) => string {
    const idEl = new Map<string, DomEl>();
    const documentStub = {
        hidden: false,
        body: makeDomStub("body"),
        documentElement: makeDomStub("html"),
        getElementById: (id: string) => { let e = idEl.get(id); if (!e) { e = makeDomStub("div"); idEl.set(id, e); } return e; },
        createElement: (t: string) => makeDomStub(t),
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener() { },
        removeEventListener() { },
        execCommand() { return true; },
    };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout, clearTimeout, clearInterval,
        setInterval: () => 0,
        fetch: () => new Promise<never>(() => { }),
        document: documentStub,
        window: { addEventListener() { } },
        location: { hash: "" },
        navigator: { language: "en-US" },
        localStorage: { getItem: () => null, setItem() { } },
    };
    vm.createContext(sandbox);
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    const win = sandbox.window as { bili_renderHandoffMd?: (md: string) => string };
    assert.ok(typeof win.bili_renderHandoffMd === "function", "render seam exposed on window");
    return win.bili_renderHandoffMd!;
}

const roleCount = (html: string) => (html.match(/class="msg-role /g) || []).length;
const userRoles = (html: string) => (html.match(/class="msg-role user"/g) || []).length;
const assistantRoles = (html: string) => (html.match(/class="msg-role assistant"/g) || []).length;

test("latest reply uses the existing assistant block without adding a heading to user content", () => {
    const session: Session = {
        id: "latest-reply-layout",
        meta: {},
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: { handoffResponse: { request: 1, messages: [{ id: "reply", role: "assistant", contentType: "text", text: "ok" }] } },
        createdAt: 0,
        lastSeen: 0,
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        lastMessages: [{ id: "user", role: "user", contentType: "text", text: "测试 回复ok" }],
    };
    const render = loadRenderer();
    for (const full of [false, true]) {
        const md = renderHandoff(session, full);
        const html = render(md);
        assert.doesNotMatch(md, /## Latest assistant response/);
        assert.equal(userRoles(html), 1);
        assert.equal(assistantRoles(html), 1);
        assert.match(html, /测试 回复ok/);
        assert.match(html, /class="msg-role assistant">assistant<\/h3><p class="msg-out">ok/);
        assert.doesNotMatch(html, /Latest assistant response/);
    }
});

test("latest reply keeps thinking out of the answer text", () => {
    const session = {
        id: "reply-thinking",
        meta: { protocol: "openai", title: "Thinking reply" },
        stats: { requests: 3, inputTokens: 0, cachedTokens: 0, outputTokens: 0, contextTokens: 0 },
        metadata: {
            handoffResponse: {
                request: 3,
                messages: [
                    { id: "r1", role: "assistant", contentType: "reasoning", text: "plan the answer\n\nthen write it" },
                    { id: "r2", role: "assistant", contentType: "text", text: "最终答案在这里" },
                ],
            },
        },
        createdAt: 0,
        lastSeen: 0,
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        lastMessages: [{ id: "user", role: "user", contentType: "text", text: "提问" }],
    } as unknown as Session;
    const render = loadRenderer();
    const md = renderHandoff(session, false);
    const html = render(md);
    assert.match(md, /_reasoning_: plan the answer/);
    assert.equal(md.split("\n").filter((l) => l === "### assistant").length, 1, "one reply stays one assistant block");
    assert.ok(md.includes(HANDOFF_THINK_END), "reasoning cell is terminated inside the block");
    assert.ok(
        md.indexOf(HANDOFF_THINK_END) < md.indexOf("最终答案在这里"),
        "the marker sits between the reasoning and the answer",
    );
    const thinkBoxes = html.match(/<details class="msg-think">[\s\S]*?<\/details>/g) ?? [];
    assert.equal(thinkBoxes.length, 1);
    assert.match(thinkBoxes[0]!, /plan the answer/);
    assert.doesNotMatch(thinkBoxes[0]!, /最终答案在这里/, "answer must not be swallowed by the thinking box");
    assert.match(html, /<p class="msg-out">最终答案在这里/);
    assert.equal(assistantRoles(html), 1, "thinking and answer share one assistant card");
    assert.ok(
        html.indexOf('<details class="msg-think">') < html.indexOf('<p class="msg-out">最终答案在这里'),
        "the reasoning block renders before the answer",
    );
    assert.doesNotMatch(html, /\/reasoning/, "the end marker is not rendered as text");
});

test("reasoning boundaries survive the next request snapshot without changing stored messages", () => {
    const cells = [
        { id: "think", role: "assistant" as const, contentType: "reasoning" as const, text: "first thought" },
        { id: "answer", role: "assistant" as const, contentType: "text" as const, text: "visible answer" },
    ];
    const user = { id: "user", role: "user" as const, contentType: "text" as const, text: "question" };
    const session = {
        id: "history-boundaries", meta: {}, stats: { requests: 1 },
        metadata: { handoffResponse: { request: 1, messages: cells } },
        state: createInitialState(), lastMessages: [user], blockContents: new Map(),
    } as unknown as Session;
    const render = loadRenderer();
    for (const historical of [false, true]) {
        if (historical) {
            snapshotMessages(session, [user, ...cells, { ...user, id: "next", text: "next question" }]);
            session.stats.requests++;
            assert.equal(session.metadata.handoffResponse, undefined);
        }
        for (const folded of [false, true]) {
            session.lastMessagesFolded = folded;
            for (const full of [false, true]) {
                const before = JSON.stringify(session);
                const md = renderHandoff(session, full);
                const html = render(md);
                assert.equal(assistantRoles(html), 1);
                assert.equal(md.split("\n").filter((line) => line === "### assistant").length, 1);
                const think = html.match(/<details class="msg-think">[\s\S]*?<\/details>/g) ?? [];
                assert.equal(think.length, 1);
                assert.match(think[0]!, /first thought/);
                assert.doesNotMatch(think[0]!, /visible answer/);
                assert.match(html, /class="msg-out">visible answer/);
                assert.equal(JSON.stringify(session), before);
            }
        }
    }
});

test("literal reasoning-end markers remain visible in user, answer, and reasoning content", () => {
    const render = loadRenderer();
    for (const role of ["user", "assistant"]) {
        const html = render(`## Conversation\n### ${role}\nA literal example:\n\`\`\`html\n${HANDOFF_THINK_END}\n\`\`\`\nEnd`);
        assert.match(html, /&lt;!-- \/reasoning --&gt;/);
    }
    const session = {
        id: "literal-markers", meta: {}, stats: { requests: 1 },
        metadata: { handoffResponse: { request: 1, messages: [
            { id: "r", role: "assistant", contentType: "reasoning", text: `Before\n${HANDOFF_THINK_END}\nAfter` },
            { id: "a", role: "assistant", contentType: "text", text: `Answer\n${HANDOFF_THINK_END}\nEnd` },
        ] } },
        state: createInitialState(), lastMessages: [], blockContents: new Map(),
    } as unknown as Session;
    const html = render(renderHandoff(session, false));
    const think = html.match(/<details class="msg-think">[\s\S]*?<\/details>/g) ?? [];
    assert.equal(think.length, 1);
    assert.match(think[0]!, /Before<br\/>&lt;!-- \/reasoning --&gt;<br\/>After/);
    assert.doesNotMatch(think[0]!, /Answer/);
    assert.equal((html.match(/&lt;!-- \/reasoning --&gt;/g) ?? []).length, 2);
});

test("handoff think marker is shared by the export and the web renderer", () => {
    assert.ok(WEB_CLIENT.includes(HANDOFF_THINK_END), "WEB_CLIENT mirrors the export's think-end marker");
});

test("a reply that thinks again after a tool call keeps its chronology", () => {
    const session = {
        id: "reply-thinking-twice",
        meta: { protocol: "openai", title: "Interleaved reply" },
        stats: { requests: 4, inputTokens: 0, cachedTokens: 0, outputTokens: 0, contextTokens: 0 },
        metadata: {
            handoffResponse: {
                request: 4,
                messages: [
                    { id: "r1", role: "assistant", contentType: "reasoning", text: "第一段思考" },
                    { id: "r2", role: "assistant", contentType: "text", text: "先看工具输出" },
                    { id: "r3", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "call_1", text: "{}" },
                    { id: "r4", role: "assistant", contentType: "reasoning", text: "第二段思考" },
                    { id: "r5", role: "assistant", contentType: "text", text: "最终答案" },
                ],
            },
        },
        createdAt: 0,
        lastSeen: 0,
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        lastMessages: [{ id: "user", role: "user", contentType: "text", text: "提问" }],
    } as unknown as Session;
    const md = renderHandoff(session, false);
    const html = loadRenderer()(md);
    const order = ["第一段思考", "先看工具输出", "read(call_1)", "第二段思考", "最终答案"].map((needle) => {
        const at = md.indexOf(needle);
        assert.ok(at >= 0, `missing ${needle}`);
        return at;
    });
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "cells keep arrival order (no regrouping around the tool call)");
    assert.equal(md.split("\n").filter((l) => l === HANDOFF_THINK_END).length, 2, "each reasoning cell is closed");
    const thinkBoxes = html.match(/<details class="msg-think">[\s\S]*?<\/details>/g) ?? [];
    assert.equal(thinkBoxes.length, 2, "two thinking cells stay two collapsed boxes");
    assert.match(thinkBoxes[0]!, /第一段思考/);
    assert.doesNotMatch(thinkBoxes[0]!, /先看工具输出/);
    assert.match(thinkBoxes[1]!, /第二段思考/);
    assert.doesNotMatch(thinkBoxes[1]!, /最终答案/);
    assert.match(html, /<p class="msg-out">先看工具输出/);
    assert.match(html, /<p class="msg-out">最终答案/);
    assert.match(html, /msg-tool/);
    assert.equal(assistantRoles(html), 1, "the whole turn stays one assistant card");
});

test("#2065: in-body '### ' headings stay content, not mislabeled assistant blocks", () => {
    const render = loadRenderer();
    const md = [
        "# billion-context session handoff",
        "",
        "- session id: repro-2065",
        "",
        "## Conversation (folded view as the model saw it, 2 client messages)",
        "",
        "### user",
        "Please follow these standing rules.",
        "",
        "### 7.1 三层体系",
        "Read before acting.",
        "",
        "### 8.1 触发",
        "Compress when context grows.",
        "",
        "### assistant",
        "Understood, I will follow them.",
    ].join("\n");
    const html = render(md);

    assert.equal(roleCount(html), 2, "two real messages, no phantom blocks");
    assert.equal(userRoles(html), 1, "one user block");
    assert.equal(assistantRoles(html), 1, "exactly one assistant block — in-body headings did not inflate it");

    assert.ok(!/>7\.1 三层体系<\/h3>/.test(html), "in-body heading is not a role <h3>");
    assert.ok(!/>8\.1 触发<\/h3>/.test(html), "in-body heading is not a role <h3>");
    assert.ok(html.includes("7.1 三层体系"), "in-body heading text preserved as content");
    assert.ok(html.includes("8.1 触发"), "in-body heading text preserved as content");
});

test("#2065: genuine role transitions still open correctly-classed blocks", () => {
    const render = loadRenderer();
    const md = [
        "# billion-context session handoff",
        "",
        "## Conversation (folded view as the model saw it, 3 client messages)",
        "",
        "### user",
        "run ls",
        "",
        "### tool",
        "`bash(t1)` args: {}",
        "",
        "### assistant",
        "Here are the files.",
    ].join("\n");
    const html = render(md);
    assert.equal(roleCount(html), 3, "three real messages -> three blocks");
    assert.equal(userRoles(html), 1);
    assert.equal(assistantRoles(html), 1);
    assert.ok(html.includes('class="msg-role tool"'), "tool divider keeps its own class");
});

test("#2065: a bare '### system' line is content here (parity with the server renderer)", () => {
    const render = loadRenderer();
    const md = [
        "# billion-context session handoff",
        "",
        "## Conversation (folded view as the model saw it, 2 client messages)",
        "",
        "### user",
        "Note:",
        "",
        "### system",
        "this line looks like a role but is body text",
        "",
        "### assistant",
        "ok",
    ].join("\n");
    const html = render(md);
    // system is deliberately NOT a recognized divider in either renderer — it
    // must not spawn a block, and must not be relabeled assistant.
    assert.equal(roleCount(html), 2, "'### system' did not open a block");
    assert.equal(assistantRoles(html), 1, "'### system' was not coerced to assistant");
    assert.ok(html.includes("this line looks like a role but is body text"));
});
