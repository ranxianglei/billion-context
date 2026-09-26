// #958: hermes three-mode alignment — Mode 3 (native plugin) tests.
// Two halves: (1) the TS installer lane (`bili plugin install|remove|update hermes`)
// under a fake HERMES_HOME + fake `hermes` CLI; (2) the shipped Python plugin's
// runtime logic driven through subprocess python3 against a stub bili proxy.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_AGENTS, pluginInstall, pluginRemove, pluginStatusAll, pluginUpdate, selfPackageRoot } from "../src/plugin-install.ts";

const ROOT = selfPackageRoot();
const HERMES_SRC_DIR = path.join(ROOT, "hermes-plugin");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

function makeTmp(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `bili-hermes-${label}-`));
}

const tmpDirs: string[] = [];
function track(dir: string): string {
    tmpDirs.push(dir);
    return dir;
}
after(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeHermesBin(binDir: string, logFile: string, failing: boolean): void {
    if (process.platform === "win32") {
        const body = failing
            ? `@echo off\r\necho boom 1>&2\r\nexit /b 1\r\n`
            : `@echo off\r\n>>"${logFile}" echo %*\r\nexit /b 0\r\n`;
        fs.writeFileSync(path.join(binDir, "hermes.cmd"), body);
    } else {
        const sh = path.join(binDir, "hermes");
        const body = failing
            ? "#!/bin/sh\necho boom >&2\nexit 1\n"
            : `#!/bin/sh\necho "$@" >> "${logFile}"\nexit 0\n`;
        fs.writeFileSync(sh, body);
        fs.chmodSync(sh, 0o755);
    }
}

function setHermesEnv(home: string, binDir?: string): () => void {
    const prevHome = process.env.HERMES_HOME;
    const prevPath = process.env.PATH;
    process.env.HERMES_HOME = home;
    if (binDir !== undefined) process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
    return () => {
        if (prevHome === undefined) delete process.env.HERMES_HOME;
        else process.env.HERMES_HOME = prevHome;
        if (binDir !== undefined) process.env.PATH = prevPath ?? "";
    };
}

function hermesStatus(): string {
    return pluginStatusAll().find((r) => r.agent === "hermes")!.status;
}

describe("installer lane (bili plugin install hermes)", () => {
    test("fresh install copies the Python plugin verbatim + versioned manifest + sidecar, and delegates enablement to the host CLI", () => {
        const home = track(makeTmp("install"));
        const bin = track(makeTmp("bin"));
        const log = path.join(home, "calls.log");
        fakeHermesBin(bin, log, false);
        const restore = setHermesEnv(home, bin);
        try {
            assert.equal(hermesStatus(), "not installed");
            const msg = pluginInstall("hermes");
            assert.match(msg, /wrote the billion-context plugin into .* and enabled it/);
            const dir = path.join(home, "plugins", "billion-context");
            assert.equal(fs.readFileSync(path.join(dir, "__init__.py"), "utf8"), fs.readFileSync(path.join(HERMES_SRC_DIR, "__init__.py"), "utf8"));
            const yaml = fs.readFileSync(path.join(dir, "plugin.yaml"), "utf8");
            assert.ok(yaml.includes(`version: "${PKG_VERSION}"`), yaml);
            assert.ok(yaml.includes("name: billion-context"), yaml);
            const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "bili.json"), "utf8")) as Record<string, string>;
            assert.equal(sidecar.proxyScript, path.join(ROOT, "dist", "index.js"));
            assert.equal(sidecar.nodePath, process.execPath);
            const calls = fs.readFileSync(log, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            assert.ok(calls.includes("plugins enable billion-context"), calls.join("|"));
            assert.equal(hermesStatus(), "installed");
        } finally {
            restore();
        }
    });

    test("re-install is idempotent", () => {
        const home = track(makeTmp("reinstall"));
        const bin = track(makeTmp("bin"));
        const log = path.join(home, "calls.log");
        fakeHermesBin(bin, log, false);
        const restore = setHermesEnv(home, bin);
        try {
            pluginInstall("hermes");
            const before = fs.readFileSync(path.join(home, "plugins", "billion-context", "__init__.py"), "utf8");
            const msg = pluginInstall("hermes");
            assert.match(msg, /and enabled it/);
            assert.equal(fs.readFileSync(path.join(home, "plugins", "billion-context", "__init__.py"), "utf8"), before);
        } finally {
            restore();
        }
    });

    test("remove deletes the plugin dir and delegates disablement; second remove reports not installed", () => {
        const home = track(makeTmp("remove"));
        const bin = track(makeTmp("bin"));
        const log = path.join(home, "calls.log");
        fakeHermesBin(bin, log, false);
        const restore = setHermesEnv(home, bin);
        try {
            pluginInstall("hermes");
            const msg = pluginRemove("hermes");
            assert.match(msg, /removed the billion-context plugin .* and disabled it/);
            assert.ok(!fs.existsSync(path.join(home, "plugins", "billion-context")));
            const calls = fs.readFileSync(log, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            assert.ok(calls.includes("plugins disable billion-context"), calls.join("|"));
            assert.equal(pluginRemove("hermes"), "not installed");
            assert.equal(hermesStatus(), "not installed");
        } finally {
            restore();
        }
    });

    test("missing hermes CLI: install still succeeds and prints the manual enable instruction", () => {
        const home = track(makeTmp("nocli"));
        const emptyBin = track(makeTmp("emptybin"));
        const restore = setHermesEnv(home, emptyBin);
        try {
            const msg = pluginInstall("hermes");
            assert.match(msg, /the hermes CLI was not found on PATH — enable it manually: hermes plugins enable billion-context/);
            assert.equal(hermesStatus(), "installed");
        } finally {
            restore();
        }
    });

    test("failing hermes CLI: install succeeds with the stderr detail and a manual fallback", () => {
        const home = track(makeTmp("failcli"));
        const bin = track(makeTmp("bin"));
        fakeHermesBin(bin, path.join(home, "calls.log"), true);
        const restore = setHermesEnv(home, bin);
        try {
            const msg = pluginInstall("hermes");
            assert.match(msg, /enabling via the hermes CLI failed \(boom\) — enable it manually: hermes plugins enable billion-context/);
            assert.equal(hermesStatus(), "installed");
        } finally {
            restore();
        }
    });

    test("pluginUpdate(['hermes']) re-copies drifted plugin files; not installed → nothing to update", async () => {
        const home = track(makeTmp("update"));
        const bin = track(makeTmp("bin"));
        fakeHermesBin(bin, path.join(home, "calls.log"), false);
        const restore = setHermesEnv(home, bin);
        try {
            const pristine = fs.readFileSync(path.join(HERMES_SRC_DIR, "__init__.py"), "utf8");
            const lines = await pluginUpdate(["hermes"], { packageName: "billion-context" });
            assert.equal(lines.length, 1);
            assert.match(lines[0], /hermes: not installed — nothing to update/);
            pluginInstall("hermes");
            const target = path.join(home, "plugins", "billion-context", "__init__.py");
            fs.appendFileSync(target, "\n# user drift\n");
            const again = await pluginUpdate(["hermes"], { packageName: "billion-context" });
            assert.match(again[0], new RegExp(`hermes: re-copied the plugin into .* \\(bili ${PKG_VERSION}\\)`));
            assert.equal(fs.readFileSync(target, "utf8"), pristine);
        } finally {
            restore();
        }
    });

    test("status table carries the hermes lane and its update channel", () => {
        const row = pluginStatusAll().find((r) => r.agent === "hermes")!;
        assert.ok((PLUGIN_AGENTS as readonly string[]).includes("hermes"));
        assert.match(row.channel, /bili plugin update hermes/);
    });
});

// — Python plugin runtime (subprocess harness) ----------------------------------

function findPython(): string | null {
    for (const cand of ["python3", "python"]) {
        const r = spawnSync(cand, ["--version"], { encoding: "utf8" });
        if (!r.error && r.status === 0) return cand;
    }
    return null;
}

const PY = findPython();

const DRIVER = String.raw`
import importlib.util
import json
import os
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = sys.argv[2]
SCENARIO = sys.argv[1]

for sub in ("state", "data", "home", "plugins/billion-context"):
    os.makedirs(os.path.join(BASE, sub), exist_ok=True)
os.environ["XDG_STATE_HOME"] = os.path.join(BASE, "state")
os.environ["XDG_DATA_HOME"] = os.path.join(BASE, "data")
os.environ["HERMES_HOME"] = os.path.join(BASE, "home")
for k in ("BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PROXY", "BILI_NATIVE_HERMES",
          "BILLION_CONTEXT_PLUGIN", "BILI_PROVIDER_REWRITES",
          "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
          "ALL_PROXY", "all_proxy", "HERMES_CA_BUNDLE", "SSL_CERT_FILE"):
    os.environ.pop(k, None)

RECORDED = {"tool": [], "runtime_info": [], "watcher": [], "health": []}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/__bili/health":
            RECORDED["health"].append(1)
            mode = os.environ.get("BC_HEALTH_WATCHDOG", "armed")
            if mode == "absent":
                self._send({"ok": True})
            else:
                self._send({"ok": True, "watchdog": {"armed": mode == "armed", "watchers": []}})
        elif self.path == "/__bili/plugin/manifest":
            self._send({"version": "test-1", "tools": {"anthropic": [
                {"name": "compress", "description": "compress a range", "input_schema": {"type": "object"}},
                {"name": "decompress", "description": "decompress a block", "input_schema": {"type": "object"}},
                {"name": "acp_status", "description": "context status", "input_schema": {"type": "object"}}]}})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/__bili/plugin/tool":
            RECORDED["tool"].append(body)
            self._send({"ok": True, "result": "compressed 3 blocks"})
        elif self.path == "/__bili/plugin/runtime-info":
            RECORDED["runtime_info"].append(body)
            self._send({"ok": True})
        elif self.path == "/__bili/watcher":
            RECORDED["watcher"].append(body)
            code = int(os.environ.get("BC_WATCHER_STATUS") or "200")
            self._send({"ok": code == 200, "watchers": len(RECORDED["watcher"])}, code)
        else:
            self._send({"error": "not found"}, 404)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
ORIGIN = "http://127.0.0.1:" + str(server.server_address[1])
threading.Thread(target=server.serve_forever, daemon=True).start()

PLUGIN_DIR = os.path.join(BASE, "plugins", "billion-context")
shutil.copyfile(os.path.join(os.environ["BC_PLUGIN_SRC"], "__init__.py"), os.path.join(PLUGIN_DIR, "__init__.py"))

def install_sidecar(bad):
    script = os.path.join(BASE, "proxy.js")
    with open(script, "w") as f:
        f.write("process.exit(3);\n" if bad else "// dummy bili dist entry point\n")
    with open(os.path.join(PLUGIN_DIR, "bili.json"), "w") as f:
        json.dump({"proxyScript": script, "nodePath": os.environ["BC_NODE"]}, f)

def load_module():
    spec = importlib.util.spec_from_file_location("bc_hermes", os.path.join(PLUGIN_DIR, "__init__.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

class FakeCtx:
    def __init__(self):
        self.tools = {}
        self.middlewares = {}
        self.hooks = {}

    def register_tool(self, name=None, toolset=None, schema=None, handler=None, description="", **kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def register_middleware(self, kind, cb):
        self.middlewares[kind] = cb

    def register_hook(self, name, cb):
        self.hooks[name] = cb

mod = load_module()
mod._reset_for_test()
ctx = FakeCtx()
out = {"scenario": SCENARIO, "origin": ORIGIN}

if SCENARIO.startswith("discover-"):
    install_sidecar(SCENARIO == "discover-armed")
    sd = os.path.join(os.environ["XDG_STATE_HOME"], "billion-context")
    os.makedirs(sd, exist_ok=True)
    with open(os.path.join(sd, "proxy-origin"), "w") as f:
        json.dump({"origin": ORIGIN, "pid": os.getpid(), "launchToken": "tok"}, f)
    mod.register(ctx)
elif SCENARIO.startswith("gate-"):
    flag = SCENARIO[len("gate-"):]
    envvar = {"opt-out": "BILI_NATIVE_HERMES", "plugin-0": "BILLION_CONTEXT_PLUGIN", "launcher-proxy": "BILLION_CONTEXT_PROXY"}[flag]
    os.environ[envvar] = "http://127.0.0.1:1" if envvar == "BILLION_CONTEXT_PROXY" else "0"
    mod.register(ctx)
elif SCENARIO == "no-sidecar":
    mod.register(ctx)
elif SCENARIO == "spawn-fail":
    install_sidecar(True)
    mod.register(ctx)
elif SCENARIO.startswith("attach"):
    install_sidecar(False)
    os.environ["BILLION_CONTEXT_ATTACH"] = ORIGIN
    ca_dir = os.path.join(os.environ["XDG_DATA_HOME"], "billion-context", "ca")
    os.makedirs(ca_dir, exist_ok=True)
    ca_file = os.path.join(ca_dir, "root-ca.pem")
    with open(ca_file, "w") as f:
        f.write("dummy-ca\n")
    with open(os.path.join(ca_dir, "combined-ca.pem"), "w") as f:
        f.write("dummy-combined-ca\n")
    round1 = mod.on_llm_request(request={"model": "x"}, session_id="s1")
    mod.register(ctx)
    if ctx.middlewares.get("llm_request"):
        mw = ctx.middlewares["llm_request"]
        hook = ctx.hooks.get("pre_api_request")
        req = {"model": "test-model", "max_tokens": 100, "extra_headers": {"X-Custom": "keep"}}
        frozen = json.loads(json.dumps(req))
        first = mw(request=req, original_request=frozen, session_id="sess-1", model="test-model", provider="p", api_mode="chat")
        second_req = {"model": "test-model", "messages": []}
        hook(session_id="sess-1", model="test-model", max_tokens=4096)
        deadline = __import__("time").monotonic() + 3.0
        while not RECORDED["runtime_info"] and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.05)
        second = mw(request=second_req, original_request=second_req, session_id="sess-1", model="test-model", provider="p", api_mode="chat")
        tool_result = ctx.tools.get("compress", {}).get("handler")({}, session_id="sess-1", task_id="t1")
        no_session_result = ctx.tools.get("compress", {}).get("handler")({}, task_id="t1")
        out.update({
            "round1_none": round1 is None,
            "req_unmutated": req == frozen,
            "first_headers": first["request"]["extra_headers"] if isinstance(first, dict) else None,
            "second_headers": second["request"]["extra_headers"] if isinstance(second, dict) else None,
            "second_model_kept": second["request"].get("model") if isinstance(second, dict) else None,
            "tool_result": tool_result,
            "no_session_result": no_session_result,
        })
else:
    raise SystemExit("unknown scenario: " + SCENARIO)

out.update({
    "tools_registered": sorted(ctx.tools.keys()),
    "toolsets": sorted({t["toolset"] for t in ctx.tools.values()}),
    "middlewares": sorted(ctx.middlewares.keys()),
    "hooks": sorted(ctx.hooks.keys()),
    "pid": os.getpid(),
    "env_https_proxy": os.environ.get("HTTPS_PROXY"),
    "env_https_proxy_lc": os.environ.get("https_proxy"),
    "env_ca_bundle": os.environ.get("HERMES_CA_BUNDLE"),
    "env_ssl_cert_file": os.environ.get("SSL_CERT_FILE"),
    "marker_left": os.path.exists(os.path.join(os.environ["XDG_STATE_HOME"], "billion-context", "proxy-starting")),
    "tool_calls": RECORDED["tool"],
    "runtime_info": RECORDED["runtime_info"],
    "watcher_calls": RECORDED["watcher"],
    "health_probes": len(RECORDED["health"]),
    "refused": sorted(mod._state.get("refused") or []),
})
server.shutdown()
print(json.dumps(out))
`;

interface DriverOut {
    scenario: string;
    origin: string;
    pid: number;
    tools_registered: string[];
    toolsets: string[];
    middlewares: string[];
    hooks: string[];
    env_https_proxy?: string | null;
    env_https_proxy_lc?: string | null;
    env_ca_bundle?: string | null;
    env_ssl_cert_file?: string | null;
    marker_left?: boolean;
    tool_calls: Array<Record<string, unknown>>;
    runtime_info: Array<Record<string, unknown>>;
    watcher_calls: Array<Record<string, unknown>>;
    health_probes?: number;
    refused?: string[];
    round1_none?: boolean;
    req_unmutated?: boolean;
    first_headers?: Record<string, string> | null;
    second_headers?: Record<string, string> | null;
    second_model_kept?: string | null;
    tool_result?: string;
    no_session_result?: string;
}

function runDriver(scenario: string, extraEnv: Record<string, string> = {}): { out: DriverOut | null; err: string } {
    const base = track(makeTmp(scenario));
    const driver = path.join(base, "driver.py");
    fs.writeFileSync(driver, DRIVER);
    const r = spawnSync(PY!, [driver, scenario, base], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, BC_PLUGIN_SRC: HERMES_SRC_DIR, BC_NODE: process.execPath, ...extraEnv },
    });
    if (r.error || r.status !== 0) return { out: null, err: `${r.error?.message ?? ""} stdout=${r.stdout} stderr=${r.stderr}` };
    try {
        return { out: JSON.parse(r.stdout.trim().split("\n").pop()!) as DriverOut, err: "" };
    } catch (err) {
        return { out: null, err: `unparseable driver output: ${r.stdout} (${String(err)})` };
    }
}

describe("python plugin runtime (subprocess)", () => {
    test("attach: registers the proxy tools, stamps gated headers, forwards tools, reports runtime info", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach");
        assert.ok(out, err);
        assert.deepEqual(out!.tools_registered, ["acp_status", "compress", "decompress"]);
        assert.deepEqual(out!.toolsets, ["billion-context"]);
        assert.deepEqual(out!.middlewares, ["llm_request"]);
        assert.deepEqual(out!.hooks, ["pre_api_request"]);
        assert.equal(out!.round1_none, true);
        assert.equal(out!.req_unmutated, true);
        assert.equal(out!.env_https_proxy, out!.origin);
        assert.equal(out!.env_https_proxy_lc, out!.origin);
        assert.match(out!.env_ca_bundle!, /root-ca\.pem$/);
        assert.match(out!.env_ssl_cert_file!, /combined-ca\.pem$/, "#1375: ambient trust rides the combined bundle");
        const h1 = out!.first_headers!;
        assert.equal(h1["x-bili-plugin"], "hermes");
        assert.equal(h1["x-bili-plugin-conversation"], "sess-1");
        assert.equal(h1["x-bili-plugin-model"], "test-model");
        assert.equal(h1["X-Custom"], "keep");
        assert.equal(h1["x-bili-plugin-max-output"], undefined);
        const h2 = out!.second_headers!;
        assert.equal(h2["x-bili-plugin-max-output"], "4096");
        assert.equal(out!.second_model_kept, "test-model");
        assert.equal(out!.tool_result, "compressed 3 blocks");
        assert.deepEqual(out!.tool_calls, [{ conversationId: "sess-1", tool: "compress", args: {} }]);
        assert.deepEqual(out!.runtime_info, [{ agent: "hermes", model: "test-model", maxOutput: 4096, source: "hermes-native" }]);
        // #1199: an attaching session registers its host pid so the shared proxy
        // outlives the first (spawning) owner's exit.
        assert.deepEqual(out!.watcher_calls, [{ pid: out!.pid }], "attached session registers its host pid as a watchdog owner");
    });

    test("attach to a daemon proxy: 409 watcher refusal is silent and the session still starts", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach-daemon", { BC_WATCHER_STATUS: "409" });
        assert.ok(out, err);
        assert.deepEqual(out!.tools_registered, ["acp_status", "compress", "decompress"]);
        assert.equal(out!.env_https_proxy, out!.origin);
        assert.equal(out!.watcher_calls.length, 1, "registration was attempted");
    });

    test("attach with a failing watcher endpoint: registration failure never blocks session start", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach-watcher-fail", { BC_WATCHER_STATUS: "500" });
        assert.ok(out, err);
        assert.deepEqual(out!.tools_registered, ["acp_status", "compress", "decompress"]);
        assert.equal(out!.env_https_proxy, out!.origin);
        assert.equal(out!.watcher_calls.length, 1, "registration was attempted before failing open");
    });

    // #1338: the Python discovery path carries #1335's attach gate. The stub
    // proxy-origin points at the fake listener; BC_HEALTH_WATCHDOG drives its
    // /__bili/health watchdog field.
    test("discover-armed: session attaches to a watchdog-armed shared proxy", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-armed", { BC_HEALTH_WATCHDOG: "armed" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "attached to the armed listener");
        assert.equal(out!.watcher_calls.length, 1, "registered as a watchdog owner");
        assert.deepEqual(out!.refused, [], "no refusal recorded");
    });

    test("discover-unarmed: lifecycle-less daemon is refused; falls through to a session-owned spawn (#1338)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-unarmed", { BC_HEALTH_WATCHDOG: "false" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, null, "never rode the daemon");
        assert.deepEqual(out!.watcher_calls, [], "no watcher registration on a refused attach");
        assert.deepEqual(out!.refused, [out!.origin], "refusal recorded once for operators");
        assert.ok((out!.health_probes ?? 0) >= 1, "gate consulted the health watchdog field");
        assert.deepEqual(out!.tools_registered, [], "spawn fallback failed (dummy sidecar) — plugin inert, not attached");
    });

    test("discover-absent: pre-#1330 build (no watchdog field) is unverifiable — refused like unarmed", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-absent", { BC_HEALTH_WATCHDOG: "absent" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, null);
        assert.deepEqual(out!.refused, [out!.origin], "unverifiable lifecycle is refused, matching pickAttachable");
    });

    test("discover-external: BILI_NATIVE_ATTACH_EXTERNAL=1 restores attach-to-daemon (#1338 escape hatch)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-unarmed", { BC_HEALTH_WATCHDOG: "false", BILI_NATIVE_ATTACH_EXTERNAL: "1" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "escape hatch attaches to the unarmed daemon");
        assert.equal(out!.watcher_calls.length, 1, "watcher registration still attempted (409-soft)");
        assert.deepEqual(out!.refused, []);
    });

    for (const [scenario, extraEnv] of [
        ["gate-opt-out", { BILI_NATIVE_HERMES: "0" }],
        ["gate-plugin-0", { BILLION_CONTEXT_PLUGIN: "0" }],
        ["gate-launcher-proxy", { BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999" }],
    ] as Array<[string, Record<string, string>]>) {
        test(`${scenario}: stays fully inert (no tools, no env, no markers)`, () => {
            if (!PY) {
                console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
                return;
            }
            const { out, err } = runDriver(scenario, extraEnv);
            assert.ok(out, err);
            assert.deepEqual(out!.tools_registered, []);
            assert.deepEqual(out!.middlewares, []);
            assert.deepEqual(out!.hooks, []);
            assert.equal(out!.env_https_proxy, null);
            assert.equal(out!.env_ca_bundle, null);
            assert.equal(out!.env_ssl_cert_file, null);
        });
    }

    test("no sidecar: warns and stays inert instead of raising", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("no-sidecar");
        assert.ok(out, err);
        assert.deepEqual(out!.tools_registered, []);
        assert.equal(out!.env_https_proxy, null);
    });

    test("spawn failure: child dies -> inert, env untouched, starting marker cleaned up", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("spawn-fail");
        assert.ok(out, err);
        assert.deepEqual(out!.tools_registered, []);
        assert.equal(out!.env_https_proxy, null);
        assert.equal(out!.marker_left, false);
    });
});
