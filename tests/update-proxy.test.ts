import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { installViaTarball, egressDispatcher, type UpdateOptions } from "../src/update.ts";
import { proxyDispatcher } from "../src/upstream-proxy.ts";
import { rmrf } from "./tmp-rm.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

function baseOpts(): UpdateOptions {
    return { packageName: "billion-context", currentVersion: "1.2.3", autoUpdate: true };
}

test("egressDispatcher: absent resolver or undefined result means direct", () => {
    const opts = baseOpts();
    assert.equal(egressDispatcher(opts, "https://registry.npmjs.org/billion-context/latest"), undefined);
    const none: UpdateOptions = { ...opts, resolveProxy: () => undefined };
    assert.equal(egressDispatcher(none, "https://cdn.example.com/x.tgz"), undefined);
});

test("egressDispatcher: resolved proxy URL becomes the cached undici agent", () => {
    const proxyUrl = "http://127.0.0.1:7897";
    const opts: UpdateOptions = {
        ...baseOpts(),
        resolveProxy: (u) => (u.includes("npmjs.org") ? proxyUrl : undefined),
    };
    // Same proxy URL ⇒ same cached ProxyAgent instance (identity, not equality).
    assert.equal(egressDispatcher(opts, "https://registry.npmjs.org/billion-context/latest"), proxyDispatcher(proxyUrl));
    assert.notEqual(egressDispatcher(opts, "https://registry.npmjs.org/billion-context/latest"), undefined);
    // A host the resolver maps to nothing goes direct.
    assert.equal(egressDispatcher(opts, "https://cdn.other.example/t.tgz"), undefined);
});

interface Capture {
    url: string;
    init: RequestInit & { dispatcher?: unknown };
}

/** Serve a crafted tarball through a capturing fetch; never touch the network. */
function withCapturedFetch<T>(tgz: Buffer, captures: Capture[], fn: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = ((url: unknown, init?: RequestInit) => {
        captures.push({ url: String(url), init: (init ?? {}) as Capture["init"] });
        return Promise.resolve(new Response(tgz));
    }) as unknown as typeof fetch;
    return fn().finally(() => {
        globalThis.fetch = original;
    });
}

interface Fixture {
    root: string;
    installDir: string;
    cacheDir: string;
}

function makeFixture(): Fixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-update-proxy-test-"));
    const installDir = path.join(root, "install");
    const cacheDir = path.join(root, "cache");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({
            name: "billion-context",
            version: "1.2.3",
            type: "module",
            main: "dist/index.js",
            bin: { bili: "./dist/index.js" },
        }),
    );
    writeFileSync(path.join(installDir, "dist", "index.js"), "export const loaded = '1.2.3';\n");
    return { root, installDir, cacheDir };
}

function makeTarball(root: string): { tgz: Buffer; integrity: string } {
    const src = path.join(root, "pkg");
    mkdirSync(path.join(src, "package"), { recursive: true });
    writeFileSync(path.join(src, "package", "package.json"), JSON.stringify({
        name: "billion-context",
        version: "2.0.0",
        type: "module",
        main: "dist/index.js",
        bin: { bili: "./dist/index.js" },
    }));
    mkdirSync(path.join(src, "package", "dist"), { recursive: true });
    writeFileSync(path.join(src, "package", "dist", "index.js"), "export const loaded = '2.0.0';\n");
    const tgzPath = path.join(root, "pkg.tgz");
    tar.c({ cwd: src, file: tgzPath, gzip: true, sync: true }, ["package"]);
    const tgz = readFileSync(tgzPath);
    return { tgz, integrity: integrityField(tgz) };
}

test("installViaTarball: tarball fetch receives the egress dispatcher when provided", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        const { tgz, integrity } = makeTarball(fx.root);
        const marker = { __testDispatcher: true };
        const captures: Capture[] = [];
        const r = await withCapturedFetch(tgz, captures, () =>
            installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity, undefined, marker),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(captures.length, 1);
        assert.equal(captures[0].url, "https://registry.test/x.tgz");
        assert.equal(captures[0].init.dispatcher, marker);
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmrf(fx.root);
    }
});

test("installViaTarball: no dispatcher on the fetch when none provided", { timeout: 30_000 }, async () => {
    const fx = makeFixture();
    process.env.XDG_CACHE_HOME = fx.cacheDir;
    try {
        const { tgz, integrity } = makeTarball(fx.root);
        const captures: Capture[] = [];
        const r = await withCapturedFetch(tgz, captures, () =>
            installViaTarball("2.0.0", "https://registry.test/x.tgz", fx.installDir, integrity),
        );
        assert.equal(r.ok, true, r.error);
        assert.equal(captures.length, 1);
        assert.ok(!("dispatcher" in captures[0].init), "direct fetch must not carry a dispatcher");
    } finally {
        delete process.env.XDG_CACHE_HOME;
        rmrf(fx.root);
    }
});
