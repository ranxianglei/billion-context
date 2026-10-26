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
import { rmrf } from "./tmp-rm.ts";

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
    for (const dir of tmpDirs.splice(0)) rmrf(dir);
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
            // The exact head differs by platform: a POSIX ENOENT prints "the
            // hermes CLI was not found on PATH …", while a Windows shell probe
            // fails with a localized cmd error and prints "enabling via the
            // hermes CLI failed (…) …". Both end in the same manual instruction.
            assert.match(msg, /enable it manually: hermes plugins enable billion-context/);
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
import hashlib
import json
import logging
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
os.makedirs(os.path.join(BASE, "config"), exist_ok=True)
os.environ["XDG_CONFIG_HOME"] = os.path.join(BASE, "config")
os.environ.pop("BILI_CONFIG_FILE", None)
for k in ("BILLION_CONTEXT_ATTACH", "BILLION_CONTEXT_PROXY", "BILI_NATIVE_HERMES",
          "BILLION_CONTEXT_PLUGIN", "BILI_PROVIDER_REWRITES",
          "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
          "ALL_PROXY", "all_proxy", "HERMES_CA_BUNDLE", "SSL_CERT_FILE"):
    os.environ.pop(k, None)

RECORDED = {"tool": [], "runtime_info": [], "watcher": [], "health": [], "status": []}

# --- hermetic YAML backend stubs for the MITM-domain discovery tests (#2838) ---
# A minimal parser for the restricted config shape under test; lets each scenario pin exactly
# which backend(s) are importable without depending on what the host happens to have installed.
MINI_YAML_PARSER = """
def parse(text):
    root = {}
    stack = [(-1, root)]
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if ":" not in s:
            raise ValueError("invalid yaml line: %r" % s)
        indent = len(raw) - len(raw.lstrip(" "))
        key, _, val = s.partition(":")
        key = key.strip()
        val = val.strip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if val == "":
            child = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = val
    return root
"""
YAML_STUB_SRC = "def safe_load(text):\n    from _bcminiyaml import parse\n    return parse(text)\n"
RUAMEL_INIT_SRC = ""
RUAMEL_YAML_SRC = ("class YAML:\n    def __init__(self, typ=None):\n        pass\n"
                   "    def load(self, text):\n        from _bcminiyaml import parse\n"
                   "        return parse(text)\n")
WARNINGS = []


class _WarnCapture(logging.Handler):
    def emit(self, record):
        WARNINGS.append(record.getMessage())


_warn_lg = logging.getLogger("billion_context.hermes")
_warn_lg.addHandler(_WarnCapture())
_warn_lg.setLevel(logging.WARNING)


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
        elif self.path.startswith("/__bili/plugin/status"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            RECORDED["status"].append({"conversationId": (q.get("conversationId") or [""])[0],
                                       "fallback": (q.get("fallback") or [""])[0]})
            canned = os.environ.get("BC_CMD_STATUS")
            if SCENARIO == "cmd-acp-multi":
                cid = (q.get("conversationId") or [""])[0]
                if cid not in ("sess-a", "sess-b"):
                    if q.get("fallback") == ["latest"]:
                        cid = "sess-b"
                    else:
                        self._send({"ok": False, "error": "unknown plugin conversation"}, 404)
                        return
                self._send({"ok": True, "conversationId": cid, "panel": "PANEL-" + cid})
            else:
                self._send(json.loads(canned) if canned else
                           {"ok": True, "conversationId": "sess-real", "panel": "PANEL-TEXT"})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/__bili/plugin/tool":
            RECORDED["tool"].append(body)
            canned = os.environ.get("BC_CMD_TOOL_RESULT")
            self._send(json.loads(canned) if canned else {"ok": True, "result": "compressed 3 blocks"})
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
    # binary write: text mode would CRLF-convert on Windows and desync the
    # on-disk bytes from fp_of(), which discovery hashes (#2905 CI windows)
    with open(script, "wb") as f:
        f.write(("process.exit(3);\n" if bad else "// dummy bili dist entry point\n").encode())
    with open(os.path.join(PLUGIN_DIR, "bili.json"), "w") as f:
        json.dump({"proxyScript": script, "nodePath": os.environ["BC_NODE"]}, f)

# --- #2905 instance-record fixtures (identity fields discovery now checks) ---

def fp_of(bad):
    return hashlib.sha256(("process.exit(3);\n" if bad else "// dummy bili dist entry point\n").encode()).hexdigest()

def inst_rec(bad, lane="hermes", token="tok", instance_id="drv-1", started_at=1):
    rec = {"origin": ORIGIN, "pid": os.getpid(), "instanceId": instance_id,
           "codeFingerprint": fp_of(bad), "host": "127.0.0.1", "passthrough": False,
           "mitmDomains": [], "modelWindows": {}, "startedAt": started_at}
    if lane is not None:
        rec["lane"] = lane
    if token is not None:
        rec["launchToken"] = token
    return rec

def write_origin(rec):
    sd = os.path.join(os.environ["XDG_STATE_HOME"], "billion-context")
    os.makedirs(sd, exist_ok=True)
    with open(os.path.join(sd, "proxy-origin"), "w") as f:
        json.dump(rec, f)

def write_registry(inst_id, rec):
    rd = os.path.join(os.environ["XDG_STATE_HOME"], "billion-context", "instances")
    os.makedirs(rd, exist_ok=True)
    with open(os.path.join(rd, inst_id + ".json"), "w") as f:
        json.dump(rec, f)

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
        self.commands = {}

    def register_tool(self, name=None, toolset=None, schema=None, handler=None, description="", **kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "description": description}

    def register_middleware(self, kind, cb):
        self.middlewares[kind] = cb

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_command(self, name=None, handler=None, description="", args_hint="", argument_mode=None):
        self.commands[name] = {"handler": handler, "description": description}
        return object()

mod = load_module()
mod._reset_for_test()
ctx = FakeCtx()
out = {"scenario": SCENARIO, "origin": ORIGIN}

if SCENARIO == "discover-foreign-lane":
    install_sidecar(False)
    write_origin(inst_rec(False, lane="dsh"))
    mod.register(ctx)
elif SCENARIO == "discover-user-zone":
    install_sidecar(True)
    write_origin(inst_rec(True, lane=None, token=None))
    mod.register(ctx)
elif SCENARIO == "discover-lane-first":
    install_sidecar(True)
    write_origin(inst_rec(True, lane=None, token=None, instance_id="uz-new", started_at=999))
    write_registry("uz-new", inst_rec(True, lane=None, token=None, instance_id="uz-new", started_at=999))
    write_registry("hm-old", inst_rec(True, lane="hermes", token=None, instance_id="hm-old", started_at=1))
    mod.register(ctx)
elif SCENARIO == "discover-priority-config":
    install_sidecar(True)
    cfgf = os.path.join(BASE, "bili-config.json")
    with open(cfgf, "w") as f:
        json.dump({"native": {"attachLanePriority": ["dsh"]}}, f)
    os.environ["BILI_CONFIG_FILE"] = cfgf
    write_registry("dsh-1", inst_rec(True, lane="dsh", token=None, instance_id="dsh-1", started_at=5))
    mod.register(ctx)
elif SCENARIO == "spawn-env":
    # .cjs: the tmp dir sits inside this repo ("type": "module" would treat .js as ESM)
    script = os.path.join(BASE, "proxy.cjs")
    with open(script, "w") as f:
        f.write('require("fs").writeFileSync(require("path").join(process.env.XDG_STATE_HOME, "spawn-env.json"), '
                'JSON.stringify({lane: process.env.BILI_LAUNCHER_LANE, token: !!process.env.BILI_LAUNCH_TOKEN, '
                'parent: !!process.env.BILI_PARENT_PID}));\n')
    with open(os.path.join(PLUGIN_DIR, "bili.json"), "w") as f:
        json.dump({"proxyScript": script, "nodePath": os.environ["BC_NODE"]}, f)
    mod.register(ctx)
    try:
        with open(os.path.join(os.environ["XDG_STATE_HOME"], "spawn-env.json")) as f:
            out["spawn_env"] = json.load(f)
    except Exception:
        out["spawn_env"] = None
elif SCENARIO.startswith("discover-"):
    install_sidecar(SCENARIO == "discover-armed")
    write_origin(inst_rec(SCENARIO == "discover-armed"))
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
elif SCENARIO.startswith("attach-window"):
    # #3261: the host knows the model window (context_length_cache.yaml) — verify it now
    # rides both report channels; the ambiguous leg pins "no guess" on conflicting entries.
    install_sidecar(False)
    os.environ["BILLION_CONTEXT_ATTACH"] = ORIGIN
    ca_dir = os.path.join(os.environ["XDG_DATA_HOME"], "billion-context", "ca")
    os.makedirs(ca_dir, exist_ok=True)
    with open(os.path.join(ca_dir, "root-ca.pem"), "w") as f:
        f.write("dummy-ca\n")
    with open(os.path.join(ca_dir, "combined-ca.pem"), "w") as f:
        f.write("dummy-combined-ca\n")
    try:
        mod._yaml_loader()
        out["yaml_ok"] = True
    except Exception:
        out["yaml_ok"] = False
    home = os.environ["HERMES_HOME"]
    if SCENARIO == "attach-window":
        with open(os.path.join(home, "context_length_cache.yaml"), "w") as f:
            f.write("group/sol@http://127.0.0.1:3425/v1: 500000\n"
                    "unrelated@https://other.example/v1: 123456\n")
        with open(os.path.join(home, "config.yaml"), "w") as f:
            f.write("providers:\n  solprov:\n    base_url: http://127.0.0.1:3425\n")
        win_model, win_provider = "group/sol", "solprov"
    elif SCENARIO == "attach-window-nested":
        # #3730 regression: hermes persists a NESTED {"context_lengths": {...}} document (via
        # agent/model_metadata_cache._write_context_cache); the pre-#3730 reader looked at the top
        # level only and matched nothing, so the window never reached the proxy. Same fixture as
        # the flat leg above, wrapped in the section hermes actually writes.
        with open(os.path.join(home, "context_length_cache.yaml"), "w") as f:
            f.write("context_lengths:\n"
                    "  group/sol@http://127.0.0.1:3425/v1: 500000\n"
                    "  unrelated@https://other.example/v1: 123456\n")
        with open(os.path.join(home, "config.yaml"), "w") as f:
            f.write("providers:\n  solprov:\n    base_url: http://127.0.0.1:3425\n")
        win_model, win_provider = "group/sol", "solprov"
    else:
        with open(os.path.join(home, "context_length_cache.yaml"), "w") as f:
            f.write("amb@http://a.example/v1: 100000\n"
                    "amb@http://b.example/v1: 200000\n")
        win_model, win_provider = "amb", "solprov"
    mod.register(ctx)
    mw = ctx.middlewares.get("llm_request")
    hook = ctx.hooks.get("pre_api_request")
    req = {"model": win_model, "max_tokens": 100}
    frozen = json.loads(json.dumps(req))
    first = mw(request=req, original_request=frozen, session_id="sess-w", model=win_model, provider=win_provider, api_mode="chat")
    hook(session_id="sess-w", model=win_model, max_tokens=4096)
    deadline = __import__("time").monotonic() + 3.0
    while not RECORDED["runtime_info"] and __import__("time").monotonic() < deadline:
        __import__("time").sleep(0.05)
    out.update({
        "req_unmutated": req == frozen,
        "win_headers": first["request"]["extra_headers"] if isinstance(first, dict) else None,
    })
elif SCENARIO == "output-limits":
    import types
    def fetch(base):
        if base == "http://offline.example/v1":
            raise OSError("metadata unavailable")
        return {"group/sol": {"max_completion_tokens": 393216 if "other" not in base else 8192},
                "group/no-cap": {"context_length": 500000}}
    mod._host_import = lambda name: types.SimpleNamespace(fetch_endpoint_model_metadata=fetch)
    mod._host_resolve = lambda name, base: 500000
    mod._state.update(origin=ORIGIN, tools_ready=True)
    out["limits"] = []
    for model, base, explicit in [
        ("group/sol", "http://upstream.example/v1", None),
        ("group/no-cap", "http://upstream.example/v1", None),
        ("sol", "http://upstream.example/v1", None),
        ("unknown", "http://upstream.example/v1", None),
        ("group/sol", "http://other.example/v1", None),
        ("group/sol", "http://offline.example/v1", None),
        ("group/sol", "http://upstream.example/v1", 4096),
    ]:
        session = "limit-" + str(len(out["limits"]))
        req = {"model": model, "messages": []}
        context = dict(session_id=session, model=model, base_url=base)
        mod.on_llm_request(request=req, **context)
        for thread in threading.enumerate():
            if thread.name.startswith("bili-"):
                thread.join(3)
        mod.on_pre_api_request(max_tokens=explicit, **context)
        headers = mod.on_llm_request(request=req, **context)["request"]["extra_headers"]
        out["limits"].append(headers.get("x-bili-plugin-max-output"))
    deadline = __import__("time").monotonic() + 3
    while len(RECORDED["runtime_info"]) < 7 and __import__("time").monotonic() < deadline:
        __import__("time").sleep(0.01)
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
        cjk_req = {"model": "m-cjk", "messages": []}
        cjk = mw(request=cjk_req, original_request=cjk_req, session_id="sess-1", model="浮生云算/gpt-6.1-sol", provider="p", api_mode="chat")
        tool_result = ctx.tools.get("compress", {}).get("handler")({}, session_id="sess-1", task_id="t1")
        no_session_result = ctx.tools.get("compress", {}).get("handler")({}, task_id="t1")
        # #2072 negative leg: the model-transcribed conversation_id channel stays UNFLAGGED
        transcribed_result = ctx.tools.get("compress", {}).get("handler")({"conversation_id": "transcribed-9"}, task_id="t2")
        out.update({
            "round1_none": round1 is None,
            "req_unmutated": req == frozen,
            "first_headers": first["request"]["extra_headers"] if isinstance(first, dict) else None,
            "second_headers": second["request"]["extra_headers"] if isinstance(second, dict) else None,
            "second_model_kept": second["request"].get("model") if isinstance(second, dict) else None,
            "cjk_headers": cjk["request"]["extra_headers"] if isinstance(cjk, dict) else None,
            "tool_result": tool_result,
            "no_session_result": no_session_result,
            "transcribed_result": transcribed_result,
        })
elif SCENARIO.startswith("cmd-acp"):
    # no-proxy leg: no sidecar installed -> register() stays inert, origin unset
    if SCENARIO != "cmd-acp-no-proxy":
        install_sidecar(False)
        os.environ["BILLION_CONTEXT_ATTACH"] = ORIGIN
        mod.register(ctx)
    import inspect
    import types
    route = types.ModuleType("hermes_cli.plugin_session")
    route.session_key = lambda: "route-for-another-session"
    sys.modules["hermes_cli.plugin_session"] = route
    os.environ["HERMES_SESSION_ID"] = "stale-process-session"
    def command(name, session_id):
        handler = ctx.commands[name]["handler"]
        context = dict(session_id=session_id, session_key="route-for-another-session", platform="cli", source=None)
        params = inspect.signature(handler).parameters
        return handler("", **{k: v for k, v in context.items() if k in params})
    if SCENARIO == "cmd-acp-multi":
        from concurrent.futures import ThreadPoolExecutor
        def reports(cid):
            return {"session": cid, "panel": command("acp", cid), "cache": command("acp-cache", cid)}
        with ThreadPoolExecutor(max_workers=4) as pool:
            out["command_results"] = list(pool.map(reports, ("sess-a", "sess-b", "sess-a", "sess-new")))
    else:
        cid = "" if SCENARIO == "cmd-acp-no-session" else "sess-real"
        out.update({
            "cmd_acp": command("acp", cid) if ctx.commands else mod.acp_command(""),
            "cmd_acp_cache": command("acp-cache", cid) if ctx.commands else mod.acp_cache_command(""),
        })
elif SCENARIO.startswith("mitm-"):
    kind = SCENARIO[len("mitm-"):]
    libdir = os.path.join(BASE, "lib-" + kind)
    os.makedirs(libdir, exist_ok=True)
    with open(os.path.join(libdir, "_bcminiyaml.py"), "w") as f:
        f.write(MINI_YAML_PARSER)
    if kind in ("pyyaml", "parse"):
        with open(os.path.join(libdir, "yaml.py"), "w") as f:
            f.write(YAML_STUB_SRC)
    if kind == "ruamel":
        rdir = os.path.join(libdir, "ruamel")
        os.makedirs(rdir, exist_ok=True)
        with open(os.path.join(rdir, "__init__.py"), "w") as f:
            f.write(RUAMEL_INIT_SRC)
        with open(os.path.join(rdir, "yaml.py"), "w") as f:
            f.write(RUAMEL_YAML_SRC)
    if kind in ("ruamel", "none"):
        sys.modules["yaml"] = None  # block the host's PyYAML so only the intended backend resolves
    if kind == "none":
        sys.modules["ruamel"] = None  # block the host's ruamel too — nothing may resolve on any host
    sys.path.insert(0, libdir)
    cfg_text = (
        "providers:\n"
        "  openrouter:\n"
        "    base_url: https://openrouter.ai/api/v1\n"
        "  legacy:\n"
        "    url: https://legacy.example.com/v1\n"
    ) if kind != "parse" else "providers:\n  broken line without any colon\n"
    with open(os.path.join(os.environ["HERMES_HOME"], "config.yaml"), "w") as f:
        f.write(cfg_text)
    out["mitm_kind"] = kind
    out["mitm_domains"] = mod.mitm_domains_from_config()
    out["mitm_warnings"] = list(WARNINGS)
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
    "instance_id": mod._state.get("instance_id"),
    "commands": {k: v["description"] for k, v in ctx.commands.items()},
    "status_calls": RECORDED["status"],
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
    instance_id?: string | null;
    spawn_env?: { lane?: string | null; token?: boolean; parent?: boolean } | null;
    yaml_ok?: boolean;
    win_headers?: Record<string, string> | null;
    limits?: Array<string | null>;
    round1_none?: boolean;
    req_unmutated?: boolean;
    first_headers?: Record<string, string> | null;
    second_headers?: Record<string, string> | null;
    second_model_kept?: string | null;
    cjk_headers?: Record<string, string> | null;
    tool_result?: string;
    no_session_result?: string;
    transcribed_result?: string;
    mitm_kind?: string;
    mitm_domains?: string[];
    mitm_warnings?: string[];
    commands?: Record<string, string>;
    status_calls?: Array<Record<string, string>>;
    cmd_acp?: string | null;
    cmd_acp_cache?: string | null;
    command_results?: Array<{ session: string; panel: string; cache: string }>;
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
        assert.deepEqual(out!.commands, {
            acp: "Show bili context-compression status for this session",
            "acp-cache": "Prompt-cache reconciliation (same report as the acp_cache tool)",
        });
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
        assert.equal(h1["x-bili-plugin-context-window"], undefined, "#3261 fail-open: no host cache file -> no window header");
        const h2 = out!.second_headers!;
        assert.equal(h2["x-bili-plugin-max-output"], "4096");
        assert.equal(out!.second_model_kept, "test-model");
        // #2455: a non-ASCII (Chinese) model id must never reach the header — the host
        // HTTP stack throws on ByteString conversion when building the request.
        const hc = out!.cjk_headers!;
        assert.equal(hc["x-bili-plugin"], "hermes");
        assert.equal(hc["x-bili-plugin-conversation"], "sess-1");
        assert.equal(hc["x-bili-plugin-model"], undefined);
        assert.equal(out!.tool_result, "compressed 3 blocks");
        // #2072: kwargs session_id channel is flagged; the model-transcribed
        // conversation_id channel must stay unflagged (fail closed, #1685)
        assert.deepEqual(out!.tool_calls, [
            { conversationId: "sess-1", tool: "compress", args: {}, nativeCaller: true },
            { conversationId: "transcribed-9", tool: "compress", args: { conversation_id: "transcribed-9" } },
        ]);
        assert.equal(out!.transcribed_result, "compressed 3 blocks");
        assert.deepEqual(out!.runtime_info, [{ agent: "hermes", model: "test-model", maxOutput: 4096, source: "hermes-native" }]);
        // #1199: an attaching session registers its host pid so the shared proxy
        // outlives the first (spawning) owner's exit.
        assert.deepEqual(out!.watcher_calls, [{ pid: out!.pid }], "attached session registers its host pid as a watchdog owner");
    });

    // #3261: the host knows the model's window (HERMES_HOME/context_length_cache.yaml) but the
    // plugin never carried it up — now stamped on the header channel AND reported in
    // runtime-info. The header leg resolves the base URL via the provider entry in config.yaml
    // (origin-granularity match: cache keeps /v1, config omits it); the hook leg runs WITHOUT
    // a provider kwarg — the known minimum hook surface — so it must work off the unambiguous
    // single-entry fallback.
    test("attach-window: host context_length_cache.yaml window rides header + runtime-info (#3261)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach-window");
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "attached");
        if (!out!.yaml_ok) {
            console.warn("skip positive leg: no YAML backend on this host — the cache is unreadable and the feature fails open");
            return;
        }
        const h = out!.win_headers!;
        assert.equal(h["x-bili-plugin"], "hermes");
        assert.equal(h["x-bili-plugin-conversation"], "sess-w");
        assert.equal(h["x-bili-plugin-model"], "group/sol");
        assert.equal(h["x-bili-plugin-context-window"], "500000", "header channel: the host's own window value");
        assert.equal(out!.req_unmutated, true);
        assert.deepEqual(out!.runtime_info, [
            { agent: "hermes", model: "group/sol", maxOutput: 4096, contextWindow: 500000, source: "hermes-native" },
        ]);
    });

    // #3730: hermes persists the same host cache as a NESTED {"context_lengths": {...}} document;
    // the pre-#3730 reader inspected the top level only and matched nothing, so the window never
    // reached the proxy. Pin the nested-section read — the flat leg above stays green for legacy files.
    test("attach-window-nested: hermes' nested context_lengths doc resolves the window (#3730)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach-window-nested");
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "attached");
        if (!out!.yaml_ok) {
            console.warn("skip positive leg: no YAML backend on this host — the cache is unreadable and the feature fails open");
            return;
        }
        const h = out!.win_headers!;
        assert.equal(h["x-bili-plugin"], "hermes");
        assert.equal(h["x-bili-plugin-conversation"], "sess-w");
        assert.equal(h["x-bili-plugin-model"], "group/sol");
        assert.equal(h["x-bili-plugin-context-window"], "500000", "nested context_lengths section must resolve the host's own window");
        assert.equal(out!.req_unmutated, true);
        assert.deepEqual(out!.runtime_info, [
            { agent: "hermes", model: "group/sol", maxOutput: 4096, contextWindow: 500000, source: "hermes-native" },
        ]);
    });

    test("attach-window-ambiguous: conflicting per-upstream windows are not guessed (#3261)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("attach-window-ambiguous");
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "attached");
        const h = out!.win_headers!;
        assert.equal(h["x-bili-plugin"], "hermes");
        assert.equal(h["x-bili-plugin-context-window"], undefined, "same model mapped to different windows per upstream -> no guess");
        assert.deepEqual(out!.runtime_info, [{ agent: "hermes", model: "amb", maxOutput: 4096, source: "hermes-native" }]);
    });

    test("output-limits: exact endpoint model, missing cap, upstream isolation and explicit budget", () => {
        if (!PY) return;
        const { out, err } = runDriver("output-limits");
        assert.ok(out, err);
        assert.deepEqual(out.limits, ["393216", null, null, null, "8192", null, "4096"]);
        assert.deepEqual(
            out.runtime_info.map((r) => [r.model, r.maxOutput ?? null]).sort(),
            [["group/sol", 393216], ["group/no-cap", null], ["sol", null], ["unknown", null],
                ["group/sol", 8192], ["group/sol", null], ["group/sol", 4096]].sort(),
        );
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

    // #2905: lane isolation — the reported bug was hermes riding a dsh-spawned instance
    // (last writer of proxy-origin), whose MITM whitelist doesn't cover hermes's providers,
    // so model traffic blind-tunneled and every tool call 404'd as an unknown conversation.
    test("discover-foreign-lane: another lane's live instance is refused, not ridden", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-foreign-lane", { BC_HEALTH_WATCHDOG: "armed" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, null, "never rode the dsh instance");
        assert.deepEqual(out!.refused, [out!.origin], "lane refusal recorded for operators");
        assert.deepEqual(out!.tools_registered, [], "spawn fallback failed (dummy sidecar) — inert, not attached");
    });

    test("discover-user-zone: an unarmed manual daemon (the 8787 global) is a legitimate last-resort target (#1660 twin)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-user-zone", { BC_HEALTH_WATCHDOG: "false" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "user zone is exempt from the lifecycle gate, like the TS lanes");
        assert.equal(out!.watcher_calls.length, 1);
        assert.deepEqual(out!.refused, []);
    });

    test("discover-lane-first: own-lane instance beats a NEWER user-zone one; registry is scanned beyond the last-writer file", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-lane-first", { BC_HEALTH_WATCHDOG: "armed" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin);
        assert.equal(out!.instance_id, "hm-old", "own lane pinned first regardless of recency — the 8787 global can no longer win by being newer");
        assert.deepEqual(out!.refused, []);
    });

    test("discover-priority-config: native.attachLanePriority opts in to riding a listed foreign lane", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("discover-priority-config", { BC_HEALTH_WATCHDOG: "armed" });
        assert.ok(out, err);
        assert.equal(out!.env_https_proxy, out!.origin, "listed foreign lane becomes attachable");
        assert.equal(out!.instance_id, "dsh-1");
        assert.deepEqual(out!.refused, []);
    });

    test("spawn-env: spawned proxies declare their lane (BILI_LAUNCHER_LANE=hermes)", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("spawn-env");
        assert.ok(out, err);
        assert.ok(out!.spawn_env, "sidecar observed the spawn env");
        assert.equal(out!.spawn_env!.lane, "hermes", "declared lane — other lanes can no longer ride this proxy");
        assert.equal(out!.spawn_env!.token, true);
        assert.equal(out!.spawn_env!.parent, true);
        assert.equal(out!.env_https_proxy, null, "dummy sidecar never serves — inert");
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

describe("in-session slash commands (#3697)", () => {
    test("cmd-acp: uses the host session id for status and cache queries", () => {
        if (!PY) return;
        const { out, err } = runDriver("cmd-acp");
        assert.ok(out, err);
        assert.equal(out.cmd_acp, "PANEL-TEXT");
        assert.deepEqual(out.status_calls, [
            { conversationId: "sess-real", fallback: "" },
            { conversationId: "sess-real", fallback: "" },
        ]);
        assert.deepEqual(out.tool_calls, [{ conversationId: "sess-real", tool: "acp_cache", args: {} }]);
        assert.equal(out.cmd_acp_cache, "compressed 3 blocks");
    });

    test("cmd-acp: switching sessions never uses another session or latest fallback", () => {
        if (!PY) return;
        const { out, err } = runDriver("cmd-acp-multi");
        assert.ok(out, err);
        assert.deepEqual(out.command_results?.slice(0, 3).map((r) => r.panel), ["PANEL-sess-a", "PANEL-sess-b", "PANEL-sess-a"]);
        assert.deepEqual(out.status_calls?.map((r) => `${r.conversationId}:${r.fallback}`).sort(),
            ["sess-a", "sess-b", "sess-a", "sess-new"].flatMap((cid) => [`${cid}:`, `${cid}:`]).sort());
        assert.deepEqual(out.tool_calls.map((r) => r.conversationId).sort(), ["sess-a", "sess-a", "sess-b"]);
        assert.match(out.command_results![3].panel, /No model request yet/);
        assert.match(out.command_results![3].cache, /No model request yet/);
    });

    test("cmd-acp: missing host session id refuses stale route and process ids", () => {
        if (!PY) return;
        const { out, err } = runDriver("cmd-acp-no-session");
        assert.ok(out, err);
        assert.match(out.cmd_acp!, /current session ID/);
        assert.match(out.cmd_acp_cache!, /current session ID/);
        assert.deepEqual(out.status_calls, []);
        assert.deepEqual(out.tool_calls, []);
    });

    test("cmd-acp: mismatched status cannot display or forward another conversation", () => {
        if (!PY) return;
        const { out, err } = runDriver("cmd-acp-mismatch", {
            BC_CMD_STATUS: '{"ok":true,"conversationId":"sess-other","panel":"OTHER-SESSION"}',
        });
        assert.ok(out, err);
        assert.doesNotMatch(out.cmd_acp!, /OTHER-SESSION/);
        assert.deepEqual(out.tool_calls, []);
    });

    test("cmd-acp-idle: armed-but-idle notice from the manifest; cache reports no ACP session", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("cmd-acp-idle", {
            BC_CMD_STATUS: '{"ok":true,"conversationId":"sess-real","phase":"pre-first-request","panel":null}',
            BC_CMD_TOOL_RESULT: '{"ok":false,"error":"no model request has arrived for this conversation"}',
        });
        assert.ok(out, err);
        assert.match(out!.cmd_acp!, /^billion-context@test-1/);
        assert.match(out!.cmd_acp!, /proxy connected via http:\/\/127\.0\.0\.1:\d+, compression armed\. No model request yet; send one, then run \/acp again\./);
        assert.equal(
            out!.cmd_acp_cache,
            "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)",
        );
    });

    test("cmd-acp-no-proxy: error text without any HTTP traffic", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("cmd-acp-no-proxy");
        assert.ok(out, err);
        assert.match(out!.cmd_acp!, /^bili: no proxy detected/);
        assert.match(out!.cmd_acp_cache!, /^bili: no proxy detected/);
        assert.deepEqual(out!.status_calls, []);
        assert.deepEqual(out!.tool_calls, []);
    });
});

// #2838: mitm_domains_from_config() must survive runtimes shipping only ONE yaml backend; the
// driver pins which backend(s) import via hermetic stubs, so these pass on any host.
describe("MITM-domain discovery (#2838)", () => {
    const EXPECTED_DOMAINS = ["openrouter.ai", "legacy.example.com"];

    for (const kind of ["pyyaml", "ruamel"]) {
        test(`${kind} backend: discovers provider hosts without warning`, () => {
            if (!PY) {
                console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
                return;
            }
            const { out, err } = runDriver(`mitm-${kind}`);
            assert.ok(out, err);
            assert.equal(out!.mitm_kind, kind);
            assert.deepEqual(out!.mitm_domains, EXPECTED_DOMAINS);
            assert.deepEqual(out!.mitm_warnings, [], "happy path must not warn");
        });
    }

    test("neither PyYAML nor ruamel importable: fails open to [] AND warns about the blind tunnel", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("mitm-none");
        assert.ok(out, err);
        assert.deepEqual(out!.mitm_domains, [], "fail-open: empty whitelist, never raises");
        assert.equal(out!.mitm_warnings?.length, 1, "exactly one warning");
        assert.match(out!.mitm_warnings![0], /no usable YAML parser/);
        assert.match(out!.mitm_warnings![0], /blind-tunnel/);
    });

    test("unparseable config: fails open to [] AND warns", () => {
        if (!PY) {
            console.warn("skip: no python3/python interpreter on this machine (hermes requires Python 3.11+)");
            return;
        }
        const { out, err } = runDriver("mitm-parse");
        assert.ok(out, err);
        assert.deepEqual(out!.mitm_domains, [], "fail-open: empty whitelist, never raises");
        assert.equal(out!.mitm_warnings?.length, 1, "exactly one warning");
        assert.match(out!.mitm_warnings![0], /could not parse/);
        assert.match(out!.mitm_warnings![0], /blind-tunnel/);
    });
});
