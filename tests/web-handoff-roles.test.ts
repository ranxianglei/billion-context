// #2065: the session-detail handoff card must not split a message on in-body
// Markdown headings. The kernel writes role dividers as "### <role>"; a user's
// rules doc legitimately contains "### 7.1 …" lines, which the old renderer
// promoted into their own blocks and mislabeled `assistant`. Only known roles
// may open a block — everything else is content.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";

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
