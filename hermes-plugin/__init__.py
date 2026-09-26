"""billion-context native plugin for Hermes (#958).

Installed by ``bili plugin install hermes`` — a plain ``hermes`` session then becomes a full
billion-context client with no launcher, no env vars and no fixed port:

* spawns its own bili proxy on an ephemeral port (or attaches to a healthy one) and routes
  model traffic through it via ``HTTPS_PROXY`` + ``SSL_CERT_FILE`` (combined CA bundle) —
  the same wire path the ``bili hermes`` launcher uses (CONNECT + certificate MITM);
* registers the proxy's ACP tools (compress / decompress / acp_status) as native Hermes tools;
* stamps plugin-mode headers on every LLM request once the tools are ready — round 1 rides
  wire mode so strict backends see a clean head;
* reports runtime info (model + max output tokens) to the proxy via bootstrap POSTs.

Fail-open everywhere: if anything here fails, hermes simply talks to the upstream directly.
Nothing in this file may raise out of register().

Stdlib only; PyYAML is imported best-effort for MITM-domain discovery (it is a hard
dependency of hermes itself).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("billion_context.hermes")

AGENT_NAME = "hermes"
PLUGIN_ID = "billion-context"
OPT_OUT_ENV = "BILI_NATIVE_HERMES"
ATTACH_ENV = "BILLION_CONTEXT_ATTACH"
ATTACH_EXTERNAL_ENV = "BILI_NATIVE_ATTACH_EXTERNAL"
MANIFEST_TIMEOUT_S = 5.0
TOOL_TIMEOUT_S = 60.0
RUNTIME_INFO_TIMEOUT_S = 5.0
HEALTH_PROBE_TIMEOUT_S = 2.0
SPAWN_WAIT_S = 10.0
SPAWN_POLL_S = 0.1
STARTING_MARKER_TTL_S = 90.0
MAX_TRACKED_SESSIONS = 256
_PROXY_ENV_KEYS = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")

# mode values: "attach" | "spawn"; child: Popen of the spawned proxy;
# max_output: OrderedDict[session_id -> int(max_tokens)]; runtime_info_sent: (model, max_output) pairs;
# refused: origins refused by the #1338 attach gate (log dedup per process).
_state: Dict[str, Any] = {
    "origin": None,
    "mode": None,
    "child": None,
    "tools_ready": False,
    "env_applied": False,
    "max_output": OrderedDict(),
    "runtime_info_sent": set(),
    "refused": set(),
}


def _reset_for_test() -> None:
    _state["origin"] = None
    _state["mode"] = None
    _state["child"] = None
    _state["tools_ready"] = False
    _state["env_applied"] = False
    _state["max_output"].clear()
    _state["runtime_info_sent"].clear()
    _state["refused"].clear()


# — paths ---------------------------------------------------------------------

def state_dir() -> Path:
    # Mirrors src/paths.ts: XDG_STATE_HOME replaces ~/.local/state wholesale.
    raw = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".local" / "state"
    return base / "billion-context"


def data_dir() -> Path:
    raw = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".local" / "share"
    return base / "billion-context"


def hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".hermes"


def sidecar_path() -> Path:
    return Path(__file__).resolve().parent / "bili.json"


def load_sidecar() -> Optional[Dict[str, str]]:
    """The installer's sidecar: which bili dist + node binary to spawn."""
    try:
        data = json.loads(sidecar_path().read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    script = data.get("proxyScript")
    node = data.get("nodePath") or shutil.which("node")
    if not script or not isinstance(script, str) or not Path(script).is_file():
        return None
    if not node or not isinstance(node, str):
        return None
    return {"script": script, "node": node}


# — gating --------------------------------------------------------------------

def gated_off(env: Dict[str, str]) -> bool:
    """Mirror nativeBootstrapGate (src/agent/native-bootstrap.ts): an explicit owner of this
    client's wire (launcher-set BILLION_CONTEXT_PROXY, provider rewrites) means someone else
    already does the routing — stand down."""
    if env.get("BILLION_CONTEXT_PLUGIN", "") == "0":
        return True
    if env.get(OPT_OUT_ENV, "") == "0":
        return True
    if (env.get("BILLION_CONTEXT_PROXY") or "").strip():
        return True
    if env.get("BILI_PROVIDER_REWRITES") is not None:
        return True
    return False


# — http helpers (loopback management traffic only; never through proxies) ----

def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get_json(url: str, timeout: float) -> Optional[Any]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": f"billion-context-{AGENT_NAME}"})
        with _opener().open(req, timeout=timeout) as resp:
            body = resp.read()
            return json.loads(body.decode("utf-8")) if body else None
    except Exception:
        return None


def http_post_json(url: str, payload: Dict[str, Any], timeout: float) -> Tuple[Optional[int], Any]:
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": f"billion-context-{AGENT_NAME}"},
        )
        try:
            with _opener().open(req, timeout=timeout) as resp:
                body = resp.read()
                return resp.status, (json.loads(body.decode("utf-8")) if body else None)
        except urllib.error.HTTPError as err:
            body = err.read()
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                parsed = None
            return err.code, parsed
    except Exception:
        return None, None


def probe_proxy(origin: str) -> bool:
    manifest = http_get_json(origin.rstrip("/") + "/__bili/plugin/manifest", HEALTH_PROBE_TIMEOUT_S)
    return isinstance(manifest, dict) and bool(manifest.get("version"))


def config_file_path() -> Path:
    """Same file src/paths.ts configFile() reads: BILI_CONFIG_FILE override, else
    XDG config dir /billion-context/billion-context.json."""
    env = os.environ.get("BILI_CONFIG_FILE", "").strip()
    if env:
        return Path(env).expanduser()
    raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(raw).expanduser() if raw else Path.home() / ".config"
    return base / "billion-context" / "billion-context.json"


def resolve_attach_external() -> bool:
    """#1335/#1338 escape hatch: env BILI_NATIVE_ATTACH_EXTERNAL > bili config
    native.attachExternal > False — mirrors resolveNativeAttachExternal (src/config.ts)."""
    val = (os.environ.get(ATTACH_EXTERNAL_ENV) or "").strip().lower()
    if val in ("1", "true"):
        return True
    if val in ("0", "false"):
        return False
    try:
        data = json.loads(config_file_path().read_text(encoding="utf-8"))
    except Exception:
        return False
    native = data.get("native") if isinstance(data, dict) else None
    return isinstance(native, dict) and native.get("attachExternal") is True


def watchdog_armed(origin: str) -> Optional[bool]:
    """#1330 watchdog state from /__bili/health; None = field absent (older build)."""
    health = http_get_json(origin.rstrip("/") + "/__bili/health", HEALTH_PROBE_TIMEOUT_S)
    if not isinstance(health, dict):
        return None
    wd = health.get("watchdog")
    if isinstance(wd, dict) and isinstance(wd.get("armed"), bool):
        return wd["armed"]
    return None


def register_watcher(origin: str) -> None:
    """Register this host pid as a watchdog owner of a shared proxy (#1199). The spawner's
    BILI_PARENT_PID watches only the FIRST session's process; without this, the shared proxy
    exits when that session dies while this one still runs. Same policy as the TS launcher:
    409 = daemon proxy (no watchdog) → nothing to do; any other failure degrades to the
    single-owner watchdog and never blocks session start."""
    try:
        status, _body = http_post_json(origin + "/__bili/watcher", {"pid": os.getpid()}, HEALTH_PROBE_TIMEOUT_S)
        if status is None:
            logger.warning("billion-context: watcher registration failed (no response from %s) — "
                           "the shared proxy may exit when its first owner does", origin)
        elif status != 200 and status != 409:
            logger.warning("billion-context: watcher registration returned HTTP %s — "
                           "the shared proxy may exit when its first owner does", status)
    except Exception as exc:
        logger.warning("billion-context: watcher registration failed (%s) — "
                       "the shared proxy may exit when its first owner does", exc)


# — instance discovery (written by the bili proxy itself) ----------------------

def read_instance_file() -> Optional[Dict[str, Any]]:
    try:
        text = (state_dir() / "proxy-origin").read_text(encoding="utf-8").strip()
    except Exception:
        return None
    if not text:
        return None
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        origin = str(data.get("origin") or "").rstrip("/")
        if not origin.startswith(("http://", "https://")):
            return None
        pid = data.get("pid")
        token = data.get("launchToken")
        return {
            "origin": origin,
            "pid": int(pid) if isinstance(pid, int) else None,
            "launch_token": str(token) if isinstance(token, str) else None,
        }
    if text.startswith(("http://", "https://")):
        return {"origin": text.rstrip("/"), "pid": None, "launch_token": None}
    return None


def pid_alive(pid: Optional[int]) -> bool:
    if not isinstance(pid, int) or pid <= 1:
        return False
    if os.name == "nt":
        # os.kill() on Windows calls TerminateProcess — never usable as a liveness probe.
        # Unknown => assume alive; the HTTP health probe is the real gate.
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def discover_instance() -> Optional[str]:
    inst = read_instance_file()
    if not inst:
        return None
    if inst["pid"] is not None and not pid_alive(inst["pid"]):
        return None
    if not probe_proxy(inst["origin"]):
        return None
    # #1338: the Python twin of #1335's attach gate (src/launcher.ts
    # pickAttachable). Discovery must not ride a lifecycle-less listener —
    # unarmed (or unverifiable: older build, field absent) => refuse and fall
    # through to a session-owned spawn. Explicit BILLION_CONTEXT_ATTACH stays
    # exempt: user-directed, like the TS lanes' explicit-attach paths.
    if not resolve_attach_external():
        armed = watchdog_armed(inst["origin"])
        if armed is not True:
            if inst["origin"] not in _state["refused"]:
                _state["refused"].add(inst["origin"])
                logger.warning(
                    "billion-context: refusing to attach to %s — it reports %s (#1322/#1335). "
                    "Starting a session-owned proxy instead; set native.attachExternal=true "
                    "or %s=1 to attach anyway.",
                    inst["origin"],
                    "NO session-lifecycle watchdog (started without BILI_PARENT_PID, e.g. manual `bili start`)"
                    if armed is False
                    else "no watchdog state (older bili build) — its lifecycle is unverifiable",
                    ATTACH_EXTERNAL_ENV,
                )
            return None
    return inst["origin"]


# — cross-process startup coordination (mirrors ensureProxyRunning, #707) ------

def _marker_path() -> Path:
    return state_dir() / "proxy-starting"


def _marker_is_stale(marker: Dict[str, Any]) -> bool:
    pid = marker.get("pid")
    if isinstance(pid, int) and pid > 1 and not pid_alive(pid):
        return True
    started_at = marker.get("startedAt")
    if isinstance(started_at, (int, float)):
        if time.time() - started_at / 1000.0 > STARTING_MARKER_TTL_S:
            return True
    return False


def _read_marker() -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(_marker_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def claim_starting_marker(token: str, port: int) -> bool:
    path = _marker_path()
    marker = {"token": token, "pid": os.getpid(), "host": "127.0.0.1", "port": port,
              "startedAt": int(time.time() * 1000)}
    while True:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(marker))
            return True
        except FileExistsError:
            cur = _read_marker()
            if cur is not None and not _marker_is_stale(cur):
                return False
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                return False
        except Exception:
            return False


def clear_starting_marker(token: str) -> None:
    try:
        cur = _read_marker()
        if cur is not None and cur.get("token") == token:
            _marker_path().unlink()
    except Exception:
        pass


def pick_port() -> Optional[int]:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]
    except Exception:
        return None


def mitm_domains_from_config() -> List[str]:
    """https hosts of the hermes providers (best effort) — the CONNECT+MITM whitelist that lets
    bili see (and compress) the model traffic instead of blind-tunneling it."""
    cfg = hermes_home() / "config.yaml"
    try:
        text = cfg.read_text(encoding="utf-8")
    except Exception:
        return []
    try:
        import yaml  # type: ignore  # noqa: PLC0415 — hard dependency of hermes core
    except Exception:
        return []
    try:
        data = yaml.safe_load(text)
    except Exception:
        return []
    hosts: List[str] = []

    def add(url: Any) -> None:
        u = str(url or "").strip()
        if u.lower().startswith("https://"):
            host = u.split("://", 1)[1].split("/", 1)[0].split("@")[-1].split(":")[0]
            if host and host not in hosts:
                hosts.append(host)

    if isinstance(data, dict):
        providers = data.get("providers")
        if isinstance(providers, dict):
            for entry in providers.values():
                if isinstance(entry, dict):
                    for key in ("base_url", "url", "api"):
                        if entry.get(key):
                            add(entry[key])
                            break
        legacy = data.get("custom_providers")
        if isinstance(legacy, list):
            for entry in legacy:
                if isinstance(entry, dict):
                    for key in ("base_url", "url", "api"):
                        if entry.get(key):
                            add(entry[key])
                            break
    return hosts


def _spawn_child(sidecar: Dict[str, str], port: int, token: str) -> Optional[subprocess.Popen]:
    log_path = os.path.join(tempfile.gettempdir(), f"bili-proxy-{port}.log")
    env = {k: v for k, v in os.environ.items() if k not in _PROXY_ENV_KEYS}
    env["BILI_LAUNCH_TOKEN"] = token
    env["BILI_PARENT_PID"] = str(os.getpid())
    domains = mitm_domains_from_config()
    if domains:
        env["BILI_MITM_DOMAINS"] = ",".join(domains)
    argv = [sidecar["node"], sidecar["script"], "start", "--port", str(port)]
    try:
        log_fh = open(log_path, "ab")
        proc = subprocess.Popen(
            argv, env=env, stdin=subprocess.DEVNULL, stdout=log_fh, stderr=subprocess.STDOUT,
            start_new_session=True, close_fds=True,
        )
        log_fh.close()
        return proc
    except Exception as exc:
        logger.warning("billion-context: failed to spawn the proxy (%s)", exc)
        return None


def _attach(origin: str) -> str:
    """Record the attach and register this host as a watchdog owner (see register_watcher)."""
    _state.update(origin=origin, mode="attach")
    register_watcher(origin)
    return origin


def ensure_origin(sidecar: Dict[str, str]) -> Optional[str]:
    """Return a healthy proxy origin. Attach when possible (explicit target, then any recorded
    instance); otherwise spawn our own behind the starting-marker arbiter."""
    attach = (os.environ.get(ATTACH_ENV) or "").strip().rstrip("/")
    if attach:
        if probe_proxy(attach):
            return _attach(attach)
        logger.warning("billion-context: %s %s is not healthy — falling back to local bootstrap", ATTACH_ENV, attach)

    found = discover_instance()
    if found:
        return _attach(found)

    port = pick_port()
    if port is None:
        return None
    token = uuid.uuid4().hex
    claimed = claim_starting_marker(token, port)
    if not claimed:
        deadline = time.monotonic() + SPAWN_WAIT_S
        while time.monotonic() < deadline:
            found = discover_instance()
            if found:
                return _attach(found)
            marker = _read_marker()
            if marker is None or _marker_is_stale(marker):
                break
            time.sleep(SPAWN_POLL_S)
        if not claim_starting_marker(token, port):
            return None
        claimed = True
    try:
        child = _spawn_child(sidecar, port, token)
        if child is None:
            return None
        _state["child"] = child
        deadline = time.monotonic() + SPAWN_WAIT_S
        while time.monotonic() < deadline:
            inst = read_instance_file()
            if inst and inst.get("launch_token") == token and probe_proxy(inst["origin"]):
                _state.update(origin=inst["origin"], mode="spawn")
                return inst["origin"]
            if child.poll() is not None:
                logger.warning("billion-context: proxy child exited before becoming healthy "
                               "(code %s); log: %s", child.returncode,
                               os.path.join(tempfile.gettempdir(), f"bili-proxy-{port}.log"))
                return None
            time.sleep(SPAWN_POLL_S)
        logger.warning("billion-context: proxy did not become healthy within %ss", SPAWN_WAIT_S)
        try:
            child.terminate()
        except Exception:
            pass
        return None
    finally:
        if claimed:
            clear_starting_marker(token)


# — runtime effects -------------------------------------------------------------

def apply_env(origin: str) -> None:
    """Route hermes's model traffic through the proxy. Only called once the proxy is healthy —
    the same pair `bili hermes` sets for the launched process."""
    os.environ["HTTPS_PROXY"] = origin
    os.environ["https_proxy"] = origin
    ca_dir = data_dir() / "ca"
    root = ca_dir / "root-ca.pem"
    if root.is_file():
        os.environ["HERMES_CA_BUNDLE"] = str(root)
    combined = ca_dir / "combined-ca.pem"
    if combined.is_file():
        # Current hermes' main client ignores HERMES_CA_BUNDLE (agent/ssl_verify.py: platform
        # store + per-provider ssl_ca_cert); ambient trust rides SSL_CERT_FILE — OpenSSL
        # REPLACE semantics, so it must be the COMBINED bundle (MITM root + public roots) to
        # keep blind-tunnelled hosts validating (#1375).
        os.environ["SSL_CERT_FILE"] = str(combined)
    _state["env_applied"] = True


def make_tool_handler(tool_name: str) -> Callable[..., str]:
    def handler(args: Dict[str, Any], **kwargs: Any) -> str:
        origin = _state.get("origin")
        conversation = kwargs.get("session_id") or (args or {}).get("conversation_id")
        if not origin:
            return json.dumps({"error": "billion-context proxy is not available in this session"})
        if not conversation:
            return json.dumps({"error": "no hermes session id — cannot bind the compression conversation"})
        status, payload = http_post_json(
            origin.rstrip("/") + "/__bili/plugin/tool",
            {"conversationId": str(conversation), "tool": tool_name, "args": args or {}},
            TOOL_TIMEOUT_S,
        )
        if status == 200 and isinstance(payload, dict) and payload.get("ok"):
            result = payload.get("result")
            return result if isinstance(result, str) else json.dumps(result)
        detail = payload.get("error") if isinstance(payload, dict) else None
        return json.dumps({"error": f"billion-context tool failed (http {status}): {detail or 'unknown error'}"})
    return handler


def on_llm_request(request: Optional[Dict[str, Any]] = None, **context: Any) -> Optional[Dict[str, Any]]:
    """llm_request middleware: stamp plugin-mode headers once the native tools are registered.
    Round 1 (before tools are ready) deliberately returns None — it rides wire mode."""
    try:
        if not _state.get("tools_ready") or request is None or not isinstance(request, dict):
            return None
        origin = _state.get("origin")
        session_id = context.get("session_id")
        if not origin or not session_id:
            return None
        headers = request.get("extra_headers")
        merged = dict(headers) if isinstance(headers, dict) else {}
        merged["x-bili-plugin"] = AGENT_NAME
        merged["x-bili-plugin-conversation"] = str(session_id)
        model = context.get("model")
        if model:
            merged["x-bili-plugin-model"] = str(model)[:256]
        max_output = _state["max_output"].get(str(session_id))
        if isinstance(max_output, (int, float)) and max_output > 0:
            merged["x-bili-plugin-max-output"] = str(int(max_output))
        updated = dict(request)
        updated["extra_headers"] = merged
        return {"request": updated, "source": PLUGIN_ID, "reason": "plugin-mode headers"}
    except Exception:
        return None


def report_runtime_info(model: str, max_output: Optional[int]) -> None:
    try:
        origin = _state.get("origin")
        if not origin:
            return
        key: Tuple[Any, Any] = (model, int(max_output) if isinstance(max_output, (int, float)) else None)
        sent: set = _state["runtime_info_sent"]
        if key in sent:
            return
        sent.add(key)
        if len(sent) > MAX_TRACKED_SESSIONS:
            sent.clear()
        body: Dict[str, Any] = {"agent": AGENT_NAME, "model": model[:256], "source": "hermes-native"}
        if isinstance(max_output, (int, float)) and max_output > 0:
            body["maxOutput"] = int(max_output)

        def send() -> None:
            http_post_json(origin.rstrip("/") + "/__bili/plugin/runtime-info", body, RUNTIME_INFO_TIMEOUT_S)

        threading.Thread(target=send, daemon=True).start()
    except Exception:
        pass


def on_pre_api_request(*, session_id: str = "", model: str = "", max_tokens: Any = None, **_: Any) -> None:
    """pre_api_request observer (fires AFTER llm_request middleware): remember the session's
    max output tokens for the NEXT request's header, and report runtime info to the proxy."""
    try:
        session = str(session_id or "")
        if session and isinstance(max_tokens, (int, float)) and max_tokens > 0:
            table: "OrderedDict[str, int]" = _state["max_output"]
            table[session] = int(max_tokens)
            while len(table) > MAX_TRACKED_SESSIONS:
                table.popitem(last=False)
        if model:
            report_runtime_info(str(model)[:256], table.get(session) if session else None)
    except Exception:
        pass


# — entry point -----------------------------------------------------------------

def register(ctx: Any) -> None:
    try:
        if gated_off(os.environ):
            return
        if _state.get("tools_ready"):
            return
        sidecar = load_sidecar()
        if not sidecar:
            logger.warning("billion-context: no usable bili.json sidecar next to the hermes plugin "
                           "(run `bili plugin install hermes`) — staying inert")
            return
        origin = ensure_origin(sidecar)
        if not origin:
            logger.warning("billion-context: could not reach or start a bili proxy — staying inert "
                           "(hermes talks to the upstream directly)")
            return
        apply_env(origin)
        manifest = http_get_json(origin.rstrip("/") + "/__bili/plugin/manifest", MANIFEST_TIMEOUT_S)
        tools = manifest.get("tools", {}).get("anthropic") if isinstance(manifest, dict) else None
        if not isinstance(tools, list) or not tools:
            logger.warning("billion-context: proxy manifest had no tool definitions — staying inert")
            return
        names: List[str] = []
        for tool in tools:
            if not isinstance(tool, dict) or not tool.get("name"):
                continue
            ctx.register_tool(
                name=str(tool["name"]),
                toolset=PLUGIN_ID,
                schema=tool.get("input_schema") or {},
                handler=make_tool_handler(str(tool["name"])),
                description=str(tool.get("description") or ""),
            )
            names.append(str(tool["name"]))
        ctx.register_middleware("llm_request", on_llm_request)
        ctx.register_hook("pre_api_request", on_pre_api_request)
        _state["tools_ready"] = True
        logger.info("billion-context: hermes native mode active (%s, tools: %s)",
                    _state.get("mode"), ", ".join(names))
    except Exception as exc:
        logger.warning("billion-context: plugin registration failed (%s) — staying inert", exc)
