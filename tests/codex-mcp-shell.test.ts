/**
 * #4449 — the Codex plugin's MCP launcher shell (plugins/codex/mcp-server.mjs).
 *
 * Pins the behaviors Codex users depend on, hermetically (the real shell is
 * copied into a temp tree two levels deep so its repo-layout probe can never
 * hit a real build):
 *   - no resolvable entry → loud diagnostic listing every attempted path,
 *     exit 1 (never a silent vanish)
 *   - documented resolution priority: repo layout beats plugin-dir self
 *   - byte-exact stdio relay from a foreign cwd (Codex passes unpredictable
 *     cwds between versions)
 *   - SIGTERM reaches the MCP child (POSIX; kill() is emulated on Windows)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_SRC = path.join(REPO, "plugins", "codex", "mcp-server.mjs");

const roots: string[] = [];
const live: Set<ChildProcessWithoutNullStreams> = new Set();

function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcphost-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const c of live) {
    try { c.kill(); } catch { /* already gone */ }
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copies the real shell to <root>/nested/inner/ and returns the inner dir. */
function installShell(root: string): string {
  const inner = path.join(root, "nested", "inner");
  fs.mkdirSync(inner, { recursive: true });
  fs.copyFileSync(SHELL_SRC, path.join(inner, "mcp-server.mjs"));
  return inner;
}

function waitFor(label: string, ms: number, fn: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface Proc {
  child: ChildProcessWithoutNullStreams;
  out: () => string;
  err: () => string;
  endStdin: () => void;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startShell(shellPath: string, cwd: string, env: Record<string, string | undefined>): Proc {
  const child = spawn(process.execPath, [shellPath], { cwd, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
  live.add(child);
  let so = "";
  let se = "";
  child.stdout.on("data", (d) => { so += d.toString(); });
  child.stderr.on("data", (d) => { se += d.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      live.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, out: () => so, err: () => se, endStdin: () => child.stdin.end(), done };
}

async function withDeadline<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return await Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms).unref()),
  ]);
}

test("no resolvable entry: exit 1, stderr lists every attempted path", async () => {
  const root = freshRoot();
  const inner = installShell(root);
  // Strip PATH so the global-npm probes cannot find anything anywhere;
  // APPDATA/LOCALAPPDATA would add Windows-only fallback roots.
  const p = startShell(path.join(inner, "mcp-server.mjs"), root, {
    PATH: "",
    APPDATA: undefined,
    LOCALAPPDATA: undefined,
    BILI_MCP_ENTRY: undefined,
  });
  const r = await withDeadline("no-entry exit", 15000, p.done);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}\nstdout: ${p.out()}\nstderr: ${p.err()}`);
  assert.match(p.err(), /\[bili-codex\] 找不到 billion-context 的 MCP 入口/);
  assert.match(p.err(), /已尝试/);
  assert.ok(p.err().includes(path.resolve(inner, "..", "..", "dist", "mcp.js")), "repo-layout candidate must be listed");
  assert.ok(p.err().includes(path.join(inner, "dist", "mcp.js")), "plugin-dir candidate must be listed");
  assert.match(p.err(), /BILI_MCP_ENTRY/);
}, );

test("resolution priority: repo layout wins over plugin-dir self", async () => {
  const root = freshRoot();
  const inner = installShell(root);
  const reportFile = path.join(root, "entry-report.txt");
  const entrySrc = (marker: string) =>
    `import fs from "node:fs";\nfs.writeFileSync(process.env.ENTRY_REPORT_FILE, ${JSON.stringify(marker)});\n`;
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(inner, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "mcp.js"), entrySrc("repo-layout\n"));
  fs.writeFileSync(path.join(inner, "dist", "mcp.js"), entrySrc("plugin-dir\n"));

  const p = startShell(path.join(inner, "mcp-server.mjs"), root, { ENTRY_REPORT_FILE: reportFile });
  await withDeadline("entry report", 10000, waitFor("entry report file", 10000, () => fs.existsSync(reportFile)));
  assert.equal(fs.readFileSync(reportFile, "utf8"), "repo-layout\n", "documented order: repo layout before plugin-dir");
  p.endStdin();
  await withDeadline("clean exit", 10000, p.done);
});

test("stdio is relayed byte-exact from a foreign cwd", async () => {
  const root = freshRoot();
  const inner = installShell(root);
  const stub = path.join(root, "stub-entry.mjs");
  fs.writeFileSync(stub, [
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => {',
    '  buf += d;',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i);',
    '    buf = buf.slice(i + 1);',
    '    if (line.trim()) process.stdout.write(\'{"jsonrpc":"2.0","id":1,"result":{"stub":"ok"}}\\n\');',
    '  }',
    '});',
    "",
  ].join("\n"));

  const p = startShell(path.join(inner, "mcp-server.mjs"), root, { BILI_MCP_ENTRY: stub });
  p.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  await withDeadline("relay", 10000, waitFor("relayed response", 10000, () => p.out().length > 0));
  p.endStdin();
  const r = await withDeadline("exit after EOF", 10000, p.done);
  assert.equal(r.code, 0, `expected clean exit, got ${r.code}\nstderr: ${p.err()}`);
  assert.equal(p.out(), '{"jsonrpc":"2.0","id":1,"result":{"stub":"ok"}}\n', "relay must be byte-exact");
});

test("SIGTERM on the shell reaches the MCP child (POSIX)", {
  skip: process.platform === "win32" ? "kill() is emulated on Windows; forwarding is verified on POSIX runners" : false,
}, async () => {
  const root = freshRoot();
  const inner = installShell(root);
  const readyFile = path.join(root, "ready.txt");
  const dieFile = path.join(root, "die.txt");
  const stub = path.join(root, "sig-stub.mjs");
  fs.writeFileSync(stub, [
    'import fs from "node:fs";',
    // Signal listeners do not keep a Node process alive; resume() does, which
    // mirrors Codex holding the MCP server's stdio open between requests.
    'process.stdin.resume();',
    'for (const sig of ["SIGINT", "SIGTERM"]) {',
    '  process.on(sig, () => { fs.writeFileSync(process.env.STUB_DIE_FILE, sig + "\\n"); process.exit(0); });',
    '}',
    'fs.writeFileSync(process.env.STUB_READY_FILE, "ready\\n");',
    "",
  ].join("\n"));

  const p = startShell(path.join(inner, "mcp-server.mjs"), root, {
    BILI_MCP_ENTRY: stub,
    STUB_READY_FILE: readyFile,
    STUB_DIE_FILE: dieFile,
  });
  await withDeadline("child ready", 10000, waitFor("child ready", 10000, () => fs.existsSync(readyFile)));
  p.child.kill("SIGTERM");
  const r = await withDeadline("shell exit after SIGTERM", 10000, p.done);
  assert.ok(r.code === 0 || r.signal !== null, `shell must exit, got code=${r.code} signal=${r.signal}`);
  assert.equal(fs.readFileSync(dieFile, "utf8"), "SIGTERM\n", "child must receive the forwarded signal");
});
