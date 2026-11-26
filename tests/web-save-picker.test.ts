import test from "node:test";
import assert from "node:assert/strict";
import { WEB_CLIENT } from "../src/web/client.ts";

// #7233: web-panel exports prefer the File System Access API (showSaveFilePicker)
// so the file lands where the user picks it, and fall back to the plain blob
// download when the API is absent (Firefox/Safari, remote panel) or the user
// cancels. saveBlob + exportName live inside the browser IIFE (the WEB_CLIENT
// template literal) and cannot be imported, so they are extracted and exercised
// in a hermetic sandbox.

function extractFn(src: string, name: string): string {
    const marker = `function ${name}(`;
    let start = src.indexOf(marker);
    assert.ok(start !== -1, `${name} not found in WEB_CLIENT`);
    if (src.slice(start - 6, start) === "async ") start -= 6;
    const open = src.indexOf("{", start);
    assert.ok(open !== -1, `${name}: no body brace found`);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end !== -1, `${name}: unbalanced braces`);
    return src.slice(start, end);
}

interface SavedAnchor { download: string; clicked: boolean; }
function makeSaveBlob(windowStub: Record<string, unknown>) {
    const created: unknown[] = [];
    const appended: SavedAnchor[] = [];
    const url = {
        createObjectURL(blob: unknown) { created.push(blob); return "blob:mock-" + created.length; },
        revokeObjectURL() { },
    };
    const documentStub = {
        body: { appendChild(a: SavedAnchor) { appended.push(a); } },
        createElement() {
            const a: SavedAnchor & { click(): void; remove(): void } = { download: "", clicked: false, click() { this.clicked = true; }, remove() { } };
            return a;
        },
    };
    const fn = new Function("window", "URL", "document", "setTimeout",
        `${extractFn(WEB_CLIENT, "saveBlob")}; return saveBlob;`)
        (windowStub, url, documentStub, () => 0) as (blob: unknown, name: string) => Promise<void>;
    return { fn, created, appended };
}

function makeExportName(): (prefix: string, d: { id: string; title?: string }) => string {
    return new Function(`${extractFn(WEB_CLIENT, "exportName")}; return exportName;`)() as (prefix: string, d: { id: string; title?: string }) => string;
}

test("#7233: WEB_CLIENT still compiles as a standalone script", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT), "WEB_CLIENT must compile");
});

interface PickerOpts {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

test("#7233: saveBlob writes through showSaveFilePicker when it is available", async () => {
    const written: unknown[] = [];
    let closed = false;
    const captured: { opts: PickerOpts | null } = { opts: null };
    const windowStub = {
        showSaveFilePicker: (opts: PickerOpts) => {
            captured.opts = opts;
            return Promise.resolve({
                createWritable: async () => ({
                    write: async (b: unknown) => { written.push(b); },
                    close: async () => { closed = true; },
                }),
            });
        },
    };
    const { fn, created, appended } = makeSaveBlob(windowStub);
    const blob = { type: "text/markdown", payload: "hello" };
    await fn(blob, "billion-context-handoff-my-session-ab12cd34.md");
    assert.equal(written.length, 1, "blob written through the picker");
    assert.equal(closed, true, "writable stream closed");
    assert.equal(created.length, 0, "no object URL created (no blob-download fallback)");
    assert.equal(appended.length, 0, "no <a> element appended (no blob-download fallback)");
    const opts = captured.opts;
    assert.ok(opts, "picker was called with opts");
    assert.equal(opts.suggestedName, "billion-context-handoff-my-session-ab12cd34.md");
    assert.deepEqual(opts.types, [{ description: "File", accept: { "text/markdown": [".md"] } }]);
});

test("#7233: saveBlob falls back to the blob download when the API is absent", async () => {
    const { fn, created, appended } = makeSaveBlob({});
    const blob = { type: "text/markdown", payload: "hello" };
    await fn(blob, "billion-context-handoff-ab12cd34.md");
    assert.equal(created.length, 1, "object URL created for the fallback download");
    assert.equal(appended.length, 1, "<a> element appended for the fallback download");
    assert.equal(appended[0].download, "billion-context-handoff-ab12cd34.md");
    assert.equal(appended[0].clicked, true, "the <a> was clicked");
});

test("#7233: saveBlob does nothing when the user cancels the picker (AbortError)", async () => {
    const windowStub = {
        showSaveFilePicker: async () => { throw Object.assign(new Error("Aborted"), { name: "AbortError" }); },
    };
    const { fn, created, appended } = makeSaveBlob(windowStub);
    const blob = { type: "text/markdown", payload: "hello" };
    await fn(blob, "billion-context-handoff-ab12cd34.md");
    assert.equal(created.length, 0, "no fallback download after a cancel");
    assert.equal(appended.length, 0, "no <a> element after a cancel");
});

test("#7233: saveBlob falls back when the picker throws a non-Abort error", async () => {
    const windowStub = {
        showSaveFilePicker: async () => { throw new Error("NotAllowedError: no transient activation"); },
    };
    const { fn, created, appended } = makeSaveBlob(windowStub);
    const blob = { type: "text/markdown", payload: "hello" };
    await fn(blob, "billion-context-handoff-ab12cd34.md");
    assert.equal(created.length, 1, "fell back to the blob download");
    assert.equal(appended.length, 1, "<a> element appended");
});

test("#7233: exportName builds a title-bearing filename with an id prefix", () => {
    const exportName = makeExportName();
    assert.equal(
        exportName("handoff", { id: "ab12cd34-5678-90ef-1234-567890abcdef", title: "My Session" }),
        "billion-context-handoff-My Session-ab12cd34.md");
    assert.equal(
        exportName("handoff", { id: "ab12cd34-5678-90ef-1234-567890abcdef" }),
        "billion-context-handoff-ab12cd34.md", "no title -> id only");
    assert.equal(
        exportName("blocks", { id: "deadbeef-1234", title: 'a/b\\c:d*e?f"g<h>i|j' }),
        "billion-context-blocks-a b c d e f g h i j-deadbeef.md", "filesystem-unsafe chars replaced");
    const long = "x".repeat(60);
    assert.equal(
        exportName("cacherpt", { id: "0123456789abcdef", title: long }),
        "billion-context-cacherpt-" + "x".repeat(39) + "…-01234567.md", "long title truncated to 40 with ellipsis");
});

test("#7233: the download sites are wired to saveBlob + exportName", () => {
    assert.ok(WEB_CLIENT.includes('saveBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), exportName("handoff", d))'), "handoff wired");
    assert.ok(WEB_CLIENT.includes('saveBlob(new Blob([buildBlocksMd(d)], { type: "text/markdown;charset=utf-8" }), exportName("blocks", d))'), "blocks wired");
    assert.ok(WEB_CLIENT.includes('saveBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), exportName("cacherpt", d))'), "cacherpt wired");
    assert.ok(WEB_CLIENT.includes('await saveBlob(blob, all ? "billion-context-full-log.txt" : "billion-context-log.txt")'), "log wired");
    assert.ok(WEB_CLIENT.includes('await saveBlob(new Blob([r.md], { type: "text/markdown;charset=utf-8" }), base + ".md")'), "report md wired");
    assert.ok(WEB_CLIENT.includes("await saveBlob(blob, base + \".png\")"), "report png wired");
    assert.ok(!WEB_CLIENT.includes("downloadUrl"), "stale downloadUrl helper removed");
});
