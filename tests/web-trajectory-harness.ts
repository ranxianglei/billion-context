// #2489: hermetic mini-DOM + vm runner for the web client IIFE. Same pattern as
// tests/web-sessions.test.ts, but with working listener registries so mouse/key gestures can be driven.
import * as vm from "node:vm";
import { WEB_CLIENT } from "../src/web/client.ts";

interface EventStub {
    clientX: number;
    clientY: number;
    button: number;
    key: string;
    preventDefault(): void;
    stopPropagation(): void;
}
type EventInit = Partial<Pick<EventStub, "clientX" | "clientY" | "button" | "key">>;
type Listener = (ev: EventStub) => void;

export interface El {
    id?: string;
    _parent?: El;
    tagName: string;
    innerHTML: string;
    textContent: string;
    value: string;
    hidden: boolean;
    className: string;
    title: string;
    style: Record<string, string>;
    dataset: Record<string, string>;
    children: El[];
    classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string): void };
    addEventListener(type: string, fn: Listener): void;
    removeEventListener(type: string, fn: Listener): void;
    dispatch(type: string, ev?: EventInit): void;
    appendChild(c: El): El;
    remove(): void;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    querySelector(sel: string): null;
    querySelectorAll(sel: string): El[];
    closest(sel: string): null;
    select(): void;
    click(): void;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

interface Rect { left: number; top: number; width: number; height: number; }

// The chart stub reports its native 960x260 box, so clientX in viewBox units == clientX in px.
const CHART_RECT: Rect = { left: 0, top: 0, width: 960, height: 260 };

function makeEl(tag: string, chartRect: Rect): El {
    const listeners = new Map<string, Listener[]>();
    const el: El = {
        tagName: tag.toUpperCase(),
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        className: "",
        title: "",
        style: {},
        dataset: {},
        children: [],
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        addEventListener(type, fn) { const a = listeners.get(type) ?? []; a.push(fn); listeners.set(type, a); },
        removeEventListener(type, fn) { const a = listeners.get(type) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatch(type, ev = {}) {
            const e: EventStub = { clientX: 0, clientY: 0, button: 0, key: "", preventDefault() {}, stopPropagation() {}, ...ev };
            for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
        },
        appendChild(c) { c._parent = el; el.children.push(c); return c; },
        remove() { const p = el._parent; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); el._parent = undefined; } },
        getAttribute(name) { return name === "id" && el.id ? el.id : null; },
        setAttribute(name, value) { if (name === "id") el.id = value; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        select() {},
        click() { el.dispatch("click"); },
        getBoundingClientRect() { return el.id === "traj-chart" ? chartRect : { left: 0, top: 0, width: 100, height: 20 }; },
    };
    return el;
}

interface Doc {
    hidden: boolean;
    body: El;
    documentElement: El;
    getElementById(id: string): El;
    createElement(tag: string): El;
    createElementNS(ns: string, tag: string): El;
    querySelector(sel: string): null;
    querySelectorAll(sel: string): El[];
    addEventListener(type: string, fn: Listener): void;
    removeEventListener(type: string, fn: Listener): void;
    dispatch(type: string, ev?: EventInit): void;
    execCommand(cmd: string): boolean;
}

function makeDoc(els: Map<string, El>, chartRect: Rect): Doc {
    const listeners = new Map<string, Listener[]>();
    return {
        hidden: false,
        body: makeEl("body", chartRect),
        documentElement: makeEl("html", chartRect),
        getElementById(id) {
            let e = els.get(id);
            if (!e) { e = makeEl("div", chartRect); els.set(id, e); }
            e.id = id; // the harness routes the chart rect by element id
            return e;
        },
        createElement(tag) { return makeEl(tag, chartRect); },
        createElementNS(_ns, tag) { return makeEl(tag, chartRect); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener(type, fn) { const a = listeners.get(type) ?? []; a.push(fn); listeners.set(type, a); },
        removeEventListener(type, fn) { const a = listeners.get(type) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatch(type, ev = {}) {
            const e: EventStub = { clientX: 0, clientY: 0, button: 0, key: "", preventDefault() {}, stopPropagation() {}, ...ev };
            for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
        },
        execCommand() { return true; },
    };
}

export interface RunResult {
    els: Map<string, El>;
    document: Doc;
    window: Record<string, unknown>;
}

export function runWebClient(opts: { hash: string; fetchImpl: (url: string, init?: unknown) => Promise<unknown>; language?: string }): RunResult {
    const els = new Map<string, El>();
    const document = makeDoc(els, CHART_RECT);
    const window: Record<string, unknown> = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 };
    const sandbox: Record<string, unknown> = {
        console,
        setTimeout,
        clearTimeout,
        clearInterval,
        setInterval: () => 0,
        AbortController,
        URL,
        fetch: opts.fetchImpl,
        document,
        window,
        location: { hash: opts.hash },
        navigator: { language: opts.language ?? "en-US" },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    };
    vm.runInNewContext(WEB_CLIENT, sandbox, { timeout: 5000 });
    return { els, document, window };
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 25));
    }
}
