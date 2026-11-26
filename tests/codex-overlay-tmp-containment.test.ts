import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexHome, refreshOverlayHome, finalizeCodexHome } from "../src/launcher.js";

/** #5584: the codex-local set the launcher passes to the overlay folds. */
const LOCAL_ONLY = new Set([".tmp"]);
const GENERATED = [".env", "config.toml"];

function mkRoot(): string {
    return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "bili-codex-tmp-"));
}

// The launcher warns on console.error along several paths; swallow those lines so
// the suite output stays readable. The boolean return values still carry the verdict.
function quiet(fn: () => void): void {
    const orig = console.error;
    console.error = (): void => {};
    try { fn(); } finally { console.error = orig; }
}

// A real codex home: a git-backed marketplace checkout under $CODEX_HOME/.tmp plus an
// unrelated shared entry, and a marker proving this .tmp is distinct from any overlay copy.
function makeRealHome(root: string): string {
    const home = path.join(root, ".codex");
    const repo = path.join(home, ".tmp", "marketplaces", "context-mode", ".git");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(home, ".tmp", "real-only.marker"), "real\n");
    fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
    return home;
}

function resolvesInside(candidate: string, base: string): boolean {
    const c = fs.realpathSync(candidate);
    const b = fs.realpathSync(base);
    return c === b || c.startsWith(b + path.sep);
}

test("#5584: refresh never links the real-home .tmp into the codex overlay", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = makeRealHome(root);
    const overlay = `${real}-bili`;
    assert.equal(refreshOverlayHome(real, overlay, GENERATED, { localOnlyEntries: LOCAL_ONLY }), true);
    assert.ok(!fs.existsSync(path.join(overlay, ".tmp")), "overlay must not gain a .tmp from the real home");
    assert.ok(fs.existsSync(path.join(overlay, "auth.json")), "unrelated entries still link through");
    assert.ok(fs.existsSync(path.join(real, ".tmp", "marketplaces", "context-mode", ".git", "HEAD")), "real home untouched");
});

test("#5584: a client-owned .tmp stays inside the overlay across launch + exit (no merge-back, no relink, no pollution)", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = makeRealHome(root);
    const overlay = `${real}-bili`;
    assert.equal(refreshOverlayHome(real, overlay, GENERATED, { localOnlyEntries: LOCAL_ONLY }), true);

    // Codex running under the overlay creates its OWN .tmp holding a marketplace clone.
    const ovRepo = path.join(overlay, ".tmp", "marketplaces", "context-mode", ".git");
    fs.mkdirSync(ovRepo, { recursive: true });
    fs.writeFileSync(path.join(ovRepo, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(overlay, ".tmp", "overlay-only.marker"), "overlay\n");

    // The containment invariant: the repo's canonical path resolves INSIDE the active home.
    assert.ok(resolvesInside(ovRepo, overlay), "marketplace repo must resolve inside the active home");

    // Re-launch: refresh leaves the client-owned .tmp alone (never merged back).
    assert.equal(refreshOverlayHome(real, overlay, GENERATED, { localOnlyEntries: LOCAL_ONLY }), true);
    assert.ok(fs.existsSync(path.join(overlay, ".tmp", "overlay-only.marker")), "client-owned .tmp survives a re-launch");
    assert.ok(!fs.lstatSync(path.join(overlay, ".tmp")).isSymbolicLink(), ".tmp stays a real dir, never relinked");

    // Exit fold: finalize neither merges the overlay .tmp into the real home nor relinks it.
    quiet(() => assert.equal(finalizeCodexHome(real, overlay, GENERATED, LOCAL_ONLY), true));
    assert.ok(fs.existsSync(path.join(overlay, ".tmp", "overlay-only.marker")), "finalize leaves the client-owned .tmp in place");
    assert.ok(!fs.lstatSync(path.join(overlay, ".tmp")).isSymbolicLink(), "finalize must not relink .tmp back to the real home");
    assert.ok(!fs.existsSync(path.join(real, ".tmp", "overlay-only.marker")), "real home .tmp must not absorb the overlay's .tmp");
    assert.ok(fs.existsSync(path.join(real, ".tmp", "real-only.marker")), "real home .tmp keeps its own content");
});

test("#5584: prepareCodexHome migrates a stale escaping .tmp symlink away", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = makeRealHome(root);
    const overlay = `${real}-bili`;
    fs.mkdirSync(overlay, { recursive: true });
    let madeLink = false;
    try {
        fs.symlinkSync(path.join(real, ".tmp"), path.join(overlay, ".tmp"), process.platform === "win32" ? "junction" : "dir");
        madeLink = true;
    } catch {}
    if (!madeLink) { t.skip("directory symlink/junction unsupported on this platform"); return; }
    // Pre-fix state: overlay/.tmp -> real/.tmp, so the marketplace escapes the active home.
    const escaped = path.join(overlay, ".tmp", "marketplaces", "context-mode", ".git");
    assert.ok(!resolvesInside(escaped, overlay), "precondition: the stale symlink escapes the overlay");

    const prepared = prepareCodexHome({ codexHome: real, origin: "http://127.0.0.1:8787", caPath: "/nonexistent/ca.pem", conversationId: "conv-tmp", manageRouting: false });
    assert.ok(prepared, "prepareCodexHome should succeed");
    const tmpPath = path.join(overlay, ".tmp");
    if (fs.existsSync(tmpPath)) {
        assert.ok(!fs.lstatSync(tmpPath).isSymbolicLink(), "stale escaping .tmp symlink must be dropped");
        assert.ok(resolvesInside(path.join(tmpPath, "marketplaces", "context-mode", ".git"), overlay), "post-migration repo stays inside the active home");
    }
    // Absent is the expected steady state: codex recreates .tmp as a genuine per-overlay dir.
});

test("#5584 negative control: without the exclusion the real-home .tmp IS linked in and escapes", (t) => {
    const root = mkRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const real = makeRealHome(root);
    const overlay = `${real}-bili`;
    assert.equal(refreshOverlayHome(real, overlay, GENERATED), true);
    const linked = path.join(overlay, ".tmp");
    assert.ok(fs.existsSync(linked), "legacy behavior links the real-home .tmp into the overlay");
    assert.equal(fs.realpathSync(linked), fs.realpathSync(path.join(real, ".tmp")), "linked .tmp resolves OUTSIDE the active home (the bug)");
});
