import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCodexHome, renderCodexDotEnv } from "../src/launcher.ts";
import { supportsFileSymlink } from "./platform-capabilities.ts";
import { rmrf } from "./tmp-rm.ts";

const ORIGIN = "http://127.0.0.1:8787";
const CA = "/home/user/.local/share/billion-context/ca/combined-ca.pem";

test("renderCodexDotEnv: socks5h proxies (upper + lower case) are replaced with the launch origin (#1802)", () => {
    const user = [
        "# user's clash setup",
        "HTTP_PROXY=socks5h://127.0.0.1:7890",
        "HTTPS_PROXY=socks5h://127.0.0.1:7890",
        "ALL_PROXY=socks5h://127.0.0.1:7890",
        "OPENAI_API_KEY=sk-user-secret",
    ].join("\n");
    const out = renderCodexDotEnv(user, { origin: ORIGIN, caPath: CA });
    assert.ok(out.includes("HTTP_PROXY=" + ORIGIN));
    assert.ok(out.includes("HTTPS_PROXY=" + ORIGIN));
    assert.ok(out.includes("ALL_PROXY=" + ORIGIN));
    assert.ok(!out.toLowerCase().includes("socks5h"), "no socks value survives");
    assert.ok(out.includes("NO_PROXY=localhost,127.0.0.1,::1"));
    assert.ok(out.includes(`SSL_CERT_FILE=${CA}`));
    assert.ok(out.includes(`BILLION_CONTEXT_PROXY=${ORIGIN}`));
    assert.ok(out.includes("# user's clash setup"), "comments preserved");
    assert.ok(out.includes("OPENAI_API_KEY=sk-user-secret"), "user vars preserved verbatim");
});

test("renderCodexDotEnv: lowercase/mixed-case managed keys are rewritten in place keeping the original spelling", () => {
    const out = renderCodexDotEnv("https_proxy=socks5h://x\nHttp_Proxy=socks5h://y\nFOO=bar", { origin: ORIGIN, caPath: CA });
    assert.ok(out.includes("https_proxy=" + ORIGIN), "lowercase spelling kept");
    assert.ok(out.includes("Http_Proxy=" + ORIGIN), "mixed spelling kept");
    assert.ok(out.includes("FOO=bar"));
    assert.ok(!out.includes("HTTP_PROXY=" + ORIGIN), "no duplicate canonical line for an already-managed key");
});

test("renderCodexDotEnv: quoted and export-prefixed managed lines are replaced wholesale", () => {
    const out = renderCodexDotEnv('HTTPS_PROXY="socks5h://127.0.0.1:7890"\nexport ALL_PROXY=socks5h://127.0.0.1:7890', { origin: ORIGIN, caPath: CA });
    assert.ok(out.includes("HTTPS_PROXY=" + ORIGIN));
    assert.ok(out.includes("ALL_PROXY=" + ORIGIN));
    assert.ok(!out.includes('"socks5h'), "old quoted value gone");
});

test("renderCodexDotEnv: no user file → managed-only file; trailing newline present", () => {
    const out = renderCodexDotEnv(undefined, { origin: ORIGIN, caPath: CA });
    assert.equal(out.split("\n").filter((l) => l.length > 0).length, 6);
    assert.ok(out.endsWith("\n"));
});

test("renderCodexDotEnv: Windows backslash ca path is forwarded to slashes (dotenv escape safety)", () => {
    const out = renderCodexDotEnv(undefined, { origin: ORIGIN, caPath: "C:\\Users\\Administrator\\.local\\share\\billion-context\\ca\\combined-ca.pem" });
    assert.ok(out.includes("SSL_CERT_FILE=C:/Users/Administrator/.local/share/billion-context/ca/combined-ca.pem"));
});

test("prepareCodexHome: generated .env is a private regular file, real .env untouched (#1802)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        const realEnv = path.join(dir, ".env");
        fs.writeFileSync(realEnv, "HTTPS_PROXY=socks5h://127.0.0.1:7890\nMY_TOKEN=tok-123\n");
        const realBefore = fs.readFileSync(realEnv);
        const realInode = fs.statSync(realEnv).ino;

        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: true });
        assert.ok(overlay);
        const overlayEnv = path.join(overlay!, ".env");
        const st = fs.lstatSync(overlayEnv);
        assert.ok(!st.isSymbolicLink(), "overlay .env must not be a link to the real one");
        assert.ok(st.isFile());
        // NTFS carries no POSIX mode bits (stat reports 0o666 for regular files)
        if (process.platform !== "win32") {
            assert.equal(st.mode & 0o777, 0o600, "generated .env holds user secrets → 0600");
        }

        const text = fs.readFileSync(overlayEnv, "utf8");
        assert.ok(text.includes(`HTTPS_PROXY=${ORIGIN}`));
        assert.ok(text.includes("MY_TOKEN=tok-123"), "user variables carried over");
        assert.ok(text.includes(`SSL_CERT_FILE=${CA}`));

        assert.deepEqual(fs.readFileSync(realEnv), realBefore, "real .env byte-identical");
        assert.equal(fs.statSync(realEnv).ino, realInode, "real .env not replaced");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: migrates a pre-existing shared .env symlink to an owned file (#1802)", (t) => {
    if (!supportsFileSymlink()) {
        t.skip("file symlinks require Developer Mode or SeCreateSymbolicLinkPrivilege on this Windows host");
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        const realEnv = path.join(dir, ".env");
        fs.writeFileSync(realEnv, "HTTPS_PROXY=socks5h://127.0.0.1:7890\nSECRET=s\n");
        const overlayDir = `${dir}-bili`;
        fs.mkdirSync(overlayDir);
        fs.symlinkSync(realEnv, path.join(overlayDir, ".env"));
        const realBefore = fs.readFileSync(realEnv);

        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: true });
        assert.ok(overlay);
        const st = fs.lstatSync(path.join(overlay, ".env"));
        assert.ok(!st.isSymbolicLink() && st.isFile(), "symlink replaced by a regular file");
        assert.ok(fs.readFileSync(path.join(overlay, ".env"), "utf8").includes(`HTTPS_PROXY=${ORIGIN}`));
        assert.deepEqual(fs.readFileSync(realEnv), realBefore, "real .env intact after migration");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: migrates a write-through hardlinked .env without touching the real file (#1802)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        const realEnv = path.join(dir, ".env");
        fs.writeFileSync(realEnv, "HTTPS_PROXY=socks5h://127.0.0.1:7890\n");
        const overlayDir = `${dir}-bili`;
        fs.mkdirSync(overlayDir);
        fs.linkSync(realEnv, path.join(overlayDir, ".env"));
        const realBefore = fs.readFileSync(realEnv);
        const realSt = fs.statSync(realEnv);

        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: true });
        assert.ok(overlay);
        const after = fs.statSync(realEnv);
        assert.deepEqual(fs.readFileSync(realEnv), realBefore, "real .env content intact");
        assert.equal(after.ino, realSt.ino, "real .env inode unchanged");
        assert.equal(after.nlink, 1, "hardlink severed — no write-through left");
        assert.ok(fs.readFileSync(path.join(overlay, ".env"), "utf8").includes(`HTTPS_PROXY=${ORIGIN}`));
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: re-launch with a new port regenerates the .env (no stale proxy residue)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:11111", caPath: CA, manageRouting: true });
        const overlay = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:22222", caPath: CA, manageRouting: true });
        assert.ok(overlay);
        const text = fs.readFileSync(path.join(overlay, ".env"), "utf8");
        assert.ok(text.includes("http://127.0.0.1:22222"));
        assert.ok(!text.includes("11111"), "previous launch's port fully gone");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: re-refresh never merges the generated .env back into the real home", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        // No real .env at all: protection must not create one in the real home.
        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: true });
        assert.ok(overlay);
        assert.ok(fs.lstatSync(path.join(overlay, ".env")).isFile());
        // Second launch (refresh pass over the now-generated .env).
        const overlay2 = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:9999", caPath: CA, manageRouting: true });
        assert.ok(overlay2);
        assert.ok(!fs.existsSync(path.join(dir, ".env")), "no .env materialized in the real home");
        assert.ok(fs.readFileSync(path.join(overlay2, ".env"), "utf8").includes("http://127.0.0.1:9999"));
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: MCP disabled still protects routing; config.toml stays shared (#1802 decoupling)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        fs.writeFileSync(path.join(dir, "config.toml"), 'model = "gpt-6"\n');
        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, conversationId: undefined, manageRouting: true });
        assert.ok(overlay);
        assert.ok(fs.lstatSync(path.join(overlay, ".env")).isFile(), ".env generated even without MCP");
        const cfgLink = path.join(overlay, "config.toml");
        const cfgStat = fs.lstatSync(cfgLink);
        assert.ok(cfgStat.isSymbolicLink() || cfgStat.nlink > 1, "config.toml shared when no bili block needed");
        assert.ok(!fs.readFileSync(cfgLink, "utf8").includes("[mcp_servers.bili]"));
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: manageRouting=false keeps the legacy shared .env (direct-URL mode unchanged)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        fs.writeFileSync(path.join(dir, ".env"), "HTTPS_PROXY=socks5h://127.0.0.1:7890\n");
        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, conversationId: "conv-z", manageRouting: false });
        assert.ok(overlay);
        const st = fs.lstatSync(path.join(overlay, ".env"));
        assert.ok(st.isSymbolicLink() || st.nlink > 1, ".env stays shared (symlink or hardlink fallback)");
        assert.ok(fs.readFileSync(path.join(overlay, "config.toml"), "utf8").includes("[mcp_servers.bili]"));
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: routed→direct switch never merges the generated .env back into the real home (#1802 review)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        const realEnv = path.join(dir, ".env");
        fs.writeFileSync(realEnv, "HTTPS_PROXY=socks5h://127.0.0.1:7890\nMY_TOKEN=tok-123\n");
        const realBefore = fs.readFileSync(realEnv);
        const realInode = fs.statSync(realEnv).ino;

        prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:11111", caPath: CA, manageRouting: true });
        const overlay = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:22222", caPath: CA, conversationId: "conv-x", manageRouting: false });
        assert.ok(overlay);

        assert.deepEqual(fs.readFileSync(realEnv), realBefore, "real .env byte-identical across the mode switch");
        assert.equal(fs.statSync(realEnv).ino, realInode, "real .env inode unchanged");
        assert.ok(!fs.existsSync(`${realEnv}.bili-conflict`), "no conflict residue left in the real home");
        const st = fs.lstatSync(path.join(overlay, ".env"));
        assert.ok(st.isSymbolicLink() || st.nlink > 1, "overlay .env is back to shared state");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: unreadable real .env after a routed launch keeps the real home intact (#1802 review)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        // A DIRECTORY where .env should be makes readFileSync throw EISDIR —
        // the same fail-closed branch an EACCES/locked file takes.
        fs.mkdirSync(path.join(dir, ".env"));
        const overlay1 = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:11111", caPath: CA, manageRouting: true });
        assert.ok(overlay1);

        const overlay = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: true });
        assert.ok(overlay);

        assert.ok(fs.statSync(path.join(dir, ".env")).isDirectory(), "real .env entry untouched");
        assert.ok(!fs.existsSync(`${path.join(dir, ".env")}.bili-conflict`), "no conflict residue left in the real home");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});

test("prepareCodexHome: a later non-MCP launch shares the real config.toml again, never bakes MCP residue (#1965)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-env-"));
    try {
        const cfgText = 'model = "gpt-6"\n';
        fs.writeFileSync(path.join(dir, "config.toml"), cfgText);
        // Launch A injects MCP → owns a generated config.toml in the overlay.
        const ovA = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, conversationId: "conv-A", manageRouting: false });
        assert.ok(ovA);
        assert.ok(!fs.lstatSync(path.join(ovA, "config.toml")).isSymbolicLink(), "launch A owns a generated config.toml");
        assert.ok(fs.readFileSync(path.join(ovA, "config.toml"), "utf8").includes("[mcp_servers.bili]"));
        // Launch B needs no MCP block: the owned residue must not merge into
        // the user's real config — sharing must be restored instead.
        const ovB = prepareCodexHome({ codexHome: dir, origin: ORIGIN, caPath: CA, manageRouting: false });
        assert.ok(ovB);
        const st = fs.lstatSync(path.join(ovB, "config.toml"));
        assert.ok(st.isSymbolicLink() || st.nlink > 1, "launch B shares the real config.toml again");
        assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), cfgText, "real config never absorbed the MCP block");
        assert.ok(!fs.existsSync(`${path.join(dir, "config.toml")}.bili-conflict`), "no conflict residue left in the real home");
    } finally {
        rmrf(dir);
        rmrf(`${dir}-bili`);
    }
});
