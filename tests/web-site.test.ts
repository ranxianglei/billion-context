/**
 * Bundled site copy under /__bili/site/* (src/web/site.ts) — both directions on
 * every gate: legitimate deep paths resolve (html/css/json/png), traversal,
 * unsupported extensions, missing files and malformed encodings are rejected,
 * HTML responses carry the panel breadcrumb, bare prefix redirects, and the
 * shipped-folder resolution finds website/ from the repository layout.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { handleSiteGet, SITE_PREFIX, _setSiteDirForTest, resolveSiteFile } from "../src/web/site.ts";

const FIXTURE_HTML = "<!doctype html>\n<html><head></head><body>\n<h1>fixture</h1>\n</body></html>";

let fixtureRoot = "";
let outsideRoot = "";

function fakeRes(): { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } {
    const out: { res: ServerResponse; status: number | undefined; headers: Record<string, string>; body: string } =
        { res: undefined as unknown as ServerResponse, status: undefined, headers: {}, body: "" };
    out.res = {
        writeHead(_status: number, headers?: Record<string, string>) { out.status = _status; out.headers = headers ?? {}; },
        end(chunk?: string | Uint8Array) { if (chunk !== undefined) out.body += Buffer.from(chunk).toString("utf8"); },
    } as unknown as ServerResponse;
    return out;
}

function get(url: string): ReturnType<typeof fakeRes> {
    const r = fakeRes();
    handleSiteGet(r.res, url, "http://localhost:8787");
    return r;
}

beforeEach(() => {
    outsideRoot = mkdtempSync(join(tmpdir(), "bili-site-outside-"));
    fixtureRoot = join(outsideRoot, "site");
    mkdirSync(join(fixtureRoot, "blog"), { recursive: true });
    mkdirSync(join(fixtureRoot, "nested"), { recursive: true });
    writeFileSync(join(fixtureRoot, "index.html"), FIXTURE_HTML);
    writeFileSync(join(fixtureRoot, "blog", "index.html"), "<!doctype html><body><h1>blog page</h1></body>");
    writeFileSync(join(fixtureRoot, "nested", "app.css"), ".x{color:red}");
    writeFileSync(join(fixtureRoot, "nested", "data.json"), '{"a":1}');
    writeFileSync(join(fixtureRoot, "nested", "pic.png"), "PNGSENTINEL");
    // Files that must NEVER come over the wire:
    writeFileSync(join(fixtureRoot, "seeds.yaml"), "secret: 1");
    writeFileSync(join(outsideRoot, "outside.yaml"), "traversal-target: 1");
    _setSiteDirForTest(fixtureRoot);
});

afterEach(() => {
    _setSiteDirForTest(null);
    rmSync(outsideRoot, { recursive: true, force: true });
});

test("serves index at the root and deep pages with the panel breadcrumb", () => {
    const root = get(`${SITE_PREFIX}/`);
    assert.equal(root.status, 200);
    assert.match(String(root.headers["content-type"]), /^text\/html/);
    assert.ok(root.body.includes("<h1>fixture</h1>"));
    assert.ok(root.body.includes("/__bili/"), "breadcrumb links back to the panel");
    assert.ok(root.body.startsWith("<!doctype html>\n<html><head></head><body>\n<div style="), "breadcrumb lands right after <body>");

    const blog = get(`${SITE_PREFIX}/blog/index.html`);
    assert.equal(blog.status, 200);
    assert.ok(blog.body.includes("blog page"));
});

test("asset types pass through unmodified; query strings never reach the filesystem", () => {
    const css = get(`${SITE_PREFIX}/nested/app.css`);
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /^text\/css/);
    assert.equal(css.body, ".x{color:red}");
    assert.ok(!css.body.includes("__bili"), "non-html gets no breadcrumb");

    const json = get(`${SITE_PREFIX}/nested/data.json?v=2`);
    assert.equal(json.status, 200);
    assert.equal(json.body, '{"a":1}');

    const png = get(`${SITE_PREFIX}/nested/pic.png`);
    assert.equal(png.status, 200);
    assert.match(String(png.headers["content-type"]), /^image\/png/);
    assert.equal(png.body, "PNGSENTINEL");
});

test("rejects traversal, bad encodings, unsupported extensions and missing files (and allows nothing past them)", () => {
    for (const url of [
        `${SITE_PREFIX}/../outside.yaml`,
        `${SITE_PREFIX}/%2e%2e/outside.yaml`,
        `${SITE_PREFIX}/blog/%2e%2e/%2e%2e/outside.yaml`,
        `${SITE_PREFIX}/..%5Coutside.yaml`,
        `${SITE_PREFIX}/%zz.png`,
        `${SITE_PREFIX}/seeds.yaml`,
        `${SITE_PREFIX}/nope.html`,
    ]) {
        const r = get(url);
        assert.equal(r.status, 404, `expected 404 for ${url}`);
    }
    const hit = resolveSiteFile(`${SITE_PREFIX}/../../outside.yaml`, fixtureRoot);
    assert.equal(hit, undefined);
    // The positive half of the same gate: deep nested paths DO resolve.
    const ok = resolveSiteFile(`${SITE_PREFIX}/nested/data.json`, fixtureRoot);
    assert.notEqual(ok, undefined);
});

test("bare prefix redirects to the slashed form so relative assets resolve", () => {
    const r = get(SITE_PREFIX);
    assert.equal(r.status, 302);
    assert.equal(r.headers["location"], `${SITE_PREFIX}/`);
});

test("a directory-less install degrades to a JSON error payload instead of throwing", () => {
    _setSiteDirForTest(join(outsideRoot, "does-not-exist"));
    const r = get(`${SITE_PREFIX}/index.html`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /^application\/json/);
    assert.ok(JSON.parse(r.body).error === "offline");
});

test("default probing finds the repository's website/ folder from the TS tree", () => {
    _setSiteDirForTest(null);
    const r = get(`${SITE_PREFIX}/blog/meet-bili.html`);
    assert.equal(r.status, 200);
    assert.ok(r.body.includes("billion-context"));
    assert.ok(r.body.includes("__bili/"), "shipped copy carries the breadcrumb too");
});
