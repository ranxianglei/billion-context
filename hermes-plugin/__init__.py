"""billion-context native plugin for Hermes (#958).

Installed by ``bili plugin install hermes`` — a plain ``hermes`` session then becomes a full
billion-context client with no launcher, no env vars and no fixed port:

* spawns its own bili proxy on an ephemeral port (or attaches to a healthy one) and routes
  model traffic through it via ``HTTPS_PROXY``/``HTTP_PROXY`` (per-scheme; #5117) +
  ``SSL_CERT_FILE`` (combined CA bundle), loopback kept direct in ``NO_PROXY`` — the same
  wire path the ``bili hermes`` launcher uses (CONNECT + certificate MITM for https,
  absolute-form forward-proxy requests for plain-http);
* registers the proxy's ACP tools (compress / decompress / acp_status) as native Hermes tools;
* stamps plugin-mode headers on every LLM request once the tools are ready — round 1 rides
  wire mode so strict backends see a clean head;
* reports runtime info (model + max output tokens) to the proxy via bootstrap POSTs.

Fail-open everywhere: if anything here fails, hermes simply talks to the upstream directly.
Nothing in this file may raise out of register().

Stdlib only; a YAML parser is imported best-effort for MITM-domain discovery — PyYAML
when the runtime has it, else ruamel.yaml (some Hermes runtimes ship one but not the
other, #2838). If neither is importable the discovery fails open to an empty whitelist.
"""

from __future__ import annotations

import contextlib
import hashlib
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
import urllib.parse
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
STATUS_TIMEOUT_S = 5.0
HEALTH_PROBE_TIMEOUT_S = 2.0
SPAWN_WAIT_S = 10.0
SPAWN_POLL_S = 0.1
STARTING_MARKER_TTL_S = 90.0
# The host caps a plugin's import + register() at `plugins.load_timeout_seconds` (default 10s) and
# abandons the load on timeout (later registrations are ignored). register() blocks at most this
# long for a fast bootstrap and hands a slow one to the background thread.
REGISTER_WAIT_S = 4.0
# ONE total budget for a background bootstrap, from thread start to the last side effect. Attach,
# discovery, spawn and the manifest all poll this same deadline; no stage adds a budget of its own.
BOOTSTRAP_BUDGET_S = 90.0
# The explicit-attach poll is capped inside that budget; a local spawn gets whatever remains.
ATTACH_WAIT_S = 30.0
# A first model request racing the bootstrap waits for it; the wait must OUTLAST the budget, or a
# slow-but-healthy start would still let turn 1 slip out uncompressed — the defect this gate exists
# for. Derived, not hand-tuned: the two can never drift apart.
FIRST_REQUEST_WAIT_S = BOOTSTRAP_BUDGET_S + 15.0
# #4644: a failed bootstrap stage is retried with backoff instead of settling "failed" until the
# host restarts — one transient hiccup (busy disk, momentarily unavailable port) must not cost the
# whole host lifetime. Each attempt gets a FRESH BOOTSTRAP_BUDGET_S; the tuple is the sleep before
# attempts 2..N, so total attempts = len(tuple) + 1.
BOOTSTRAP_RETRY_BACKOFF_S = (10.0, 30.0, 60.0)
# #4644: a ROUTED origin that dies takes the process env with it — the proxy vars were written once
# at bootstrap and nothing would ever clear them, so every later model request hits a dead port
# (connect-refused storms, silent direct connection). Poll the routed origin; N consecutive misses
# (or our own child exiting) unroute it and re-bootstrap. Cadence mirrors the claude lane's proven
# self-heal (30 s tick x 3 failures = recovery within ~90 s, README "Self-healing").
ORIGIN_WATCH_INTERVAL_S = 30.0
ORIGIN_WATCH_FAIL_LIMIT = 3
# Core ACP tools whose absence from the OUTGOING request proves this session's tool snapshot was
# built before the background registration landed — plugin-mode headers must not be stamped then.
CORE_TOOL_NAMES = ("compress", "decompress", "acp_status")
MAX_TRACKED_SESSIONS = 256
# Host-resolution memo: (model, base_url, output) -> (limit|None, monotonic_ts).
# The window lookup runs on the request path, so a repeat must be free; a positive answer is
# trusted for an hour, a miss expires in 30s (an offline endpoint is usually transient).
_HOST_HIT_TTL_S = 3600.0
_HOST_MISS_TTL_S = 30.0
# Mirror the host's _maybe_cache_local_context_length floor: sub-minimum windows are returned but
# never blessed into the shared cache file, where they would poison every other consumer.
_MIN_PERSIST_CONTEXT = 64_000
_host_resolve_cache: Dict[Tuple[str, str, bool], Tuple[Optional[int], float]] = {}
_host_resolve_inflight: set = set()
_host_resolve_lock = threading.Lock()
_PROXY_ENV_KEYS = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")

# mode values: "attach" | "spawn"; child: Popen of the spawned proxy;
# max_output: OrderedDict[session_id -> int(max_tokens)]; runtime_info_sent: (model, max_output) pairs;
# refused: origins refused by the #1338 attach gate (log dedup per process);
# instance_id: the registry id discover_instance picked (None until an attach is chosen).
# loaded: register() installed the cheap surfaces and started a bootstrap;
# bootstrap: {"state": "starting"|"ready"|"failed"|"stopped", "started_at", "deadline", "error"} —
#   /acp reports it while the proxy is cold; tool_names: the manifest's tools (the visibility gate
#   in on_llm_request compares them against the outgoing request).
_state: Dict[str, Any] = {
    "origin": None,
    "mode": None,
    "child": None,
    "tools_ready": False,
    "env_applied": False,
    "max_output": OrderedDict(),
    "runtime_info_sent": set(),
    "refused": set(),
    "instance_id": None,
    "loaded": False,
    "bootstrap": None,
    "tool_names": (),
    "thread": None,
    "ready_event": threading.Event(),
    "stop_event": threading.Event(),
    "warned_direct": False,
    "snapshot_warned": False,
    # #4855: header name the proxy advertised for the per-request compression-channel override
    # (manifest headers.compression). Empty/None on an older proxy — then a request whose tool
    # snapshot lacks the ACP tools stays unstamped, exactly as before.
    "compression_header": None,
    # #4644 self-healing: watchdog_gen invalidates a previous generation's watchdog thread on
    # load/unload; recovering marks an origin-death recovery in flight (single-flight guard);
    # env_backup holds what apply_env overwrote so _unroute_env RESTORES it instead of deleting it.
    "watchdog_gen": 0,
    "watchdog_thread": None,
    "recovering": False,
    "env_backup": {},
}

# Serializes load/unload against bootstrap side effects (tool registration, env routing, child
# spawn). _shutdown sets the stop event first, then takes this lock: when unload returns, no side
# effect is in flight, and every bootstrap critical section re-checks its stop event under it.
_lifecycle_lock = threading.RLock()


def _reset_for_test() -> None:
    _shutdown()
    with _lifecycle_lock:
        _state["origin"] = None
        _state["mode"] = None
        _state["child"] = None
        _state["tools_ready"] = False
        _state["env_applied"] = False
        _state["max_output"].clear()
        _state["runtime_info_sent"].clear()
        _state["refused"].clear()
        _state["instance_id"] = None
        _state["loaded"] = False
        _state["bootstrap"] = None
        _state["tool_names"] = ()
        _state["thread"] = None
        _state["ready_event"] = threading.Event()
        _state["stop_event"] = threading.Event()
        _state["warned_direct"] = False
        _state["snapshot_warned"] = False
        _state["compression_header"] = None
        _state["watchdog_gen"] = 0
        _state["watchdog_thread"] = None
        _state["recovering"] = False
        _state["env_backup"] = {}


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


def resolve_attach_lane_priority() -> List[str]:
    """#2905: mirrors resolveNativeAttachLanePriority (src/config.ts) — the ordered list of
    lane names this hook may RIDE when no own-lane instance exists. Own lane always wins
    first; user-zone daemons (manual `bili start`, the 8787 global) are ALWAYS last; unlisted
    lanes stay non-attachable (#1225/#1232). Default [] = own lane → user zone → spawn."""
    try:
        data = json.loads(config_file_path().read_text(encoding="utf-8"))
    except Exception:
        return []
    native = data.get("native") if isinstance(data, dict) else None
    raw = native.get("attachLanePriority") if isinstance(native, dict) else None
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for item in raw:
        if isinstance(item, str):
            t = item.strip()
            if t and t not in out:
                out.append(t)
    return out


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

def _normalize_instance(data: Any) -> Optional[Dict[str, Any]]:
    """Coerce one raw record (proxy-origin JSON or registry marker) into the identity shape
    discovery checks; None when it is not an instance record at all."""
    if not isinstance(data, dict):
        return None
    origin = str(data.get("origin") or "").rstrip("/")
    if not origin.startswith(("http://", "https://")):
        return None
    pid = data.get("pid")
    token = data.get("launchToken")
    lane = data.get("lane")
    fp = data.get("codeFingerprint")
    host = data.get("host")
    passthrough = data.get("passthrough")
    domains = data.get("mitmDomains")
    windows = data.get("modelWindows")
    max_outputs = data.get("modelMaxOutputs")
    started_at = data.get("startedAt")
    instance_id = data.get("instanceId")
    return {
        "origin": origin,
        "pid": pid if isinstance(pid, int) else None,
        "launch_token": token if isinstance(token, str) else None,
        "instance_id": instance_id if isinstance(instance_id, str) else "",
        "lane": lane if isinstance(lane, str) and lane else None,
        "code_fingerprint": fp if isinstance(fp, str) and fp else None,
        "host": host if isinstance(host, str) else None,
        "passthrough": passthrough if isinstance(passthrough, bool) else None,
        "mitm_domains": [str(d) for d in domains] if isinstance(domains, list) else None,
        "model_windows": windows if isinstance(windows, dict) else None,
        "model_max_outputs": max_outputs if isinstance(max_outputs, dict) else None,
        "started_at": started_at if isinstance(started_at, (int, float)) else 0,
    }


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
        return _normalize_instance(data)
    if text.startswith(("http://", "https://")):
        return _normalize_instance({"origin": text})
    return None


def read_registry_entries() -> List[Dict[str, Any]]:
    """#1232 twin of discoverLiveInstances (src/instance.ts): every instance's self-registered
    marker under <state>/instances/<id>.json (one BARE entry per file), plus the legacy
    instances.json folded in read-only. Malformed markers are skipped, never fatal."""
    entries: List[Dict[str, Any]] = []
    reg_dir = state_dir() / "instances"
    try:
        names = sorted(os.listdir(str(reg_dir)))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(str(reg_dir), name), encoding="utf-8") as fh:
                entry = _normalize_instance(json.load(fh))
        except Exception:
            entry = None
        if entry:
            entries.append(entry)
    try:
        with open(os.path.join(str(state_dir()), "instances.json"), encoding="utf-8") as fh:
            legacy = json.load(fh)
        items = legacy.get("instances") if isinstance(legacy, dict) else None
        if isinstance(items, list):
            for item in items:
                entry = _normalize_instance(item)
                if entry:
                    entries.append(entry)
    except Exception:
        pass
    return entries


def _find_spawned_in_registry(child_pid: Optional[int]) -> Optional[Dict[str, Any]]:
    """#4656 / Python twin of #2954 (src/launcher.ts): locate OUR spawned child among the
    per-instance registry markers by pid. The single proxy-origin file is last-writer-wins
    machine-wide, so a concurrent bring-up registering AFTER our child overwrites it with a
    foreign launchToken and starves the shared-pointer match for the whole budget — but the
    registry omits the launcher-private token and is keyed per instance, so it cannot be
    clobbered that way; the pid WE spawned is the reliable identity proof (a concurrent writer
    cannot fake it). If several markers carry that pid — a stale one from a previous run whose
    dead pid the OS later reused for our child — the newest registration wins: our child's own
    marker always postdates the stale one (the TS twin closes the same corner with a
    responder-pid check, src/launcher.ts #2954). The caller still health-probes the returned
    origin before trusting it."""
    if not isinstance(child_pid, int) or child_pid <= 1:
        return None
    best: Optional[Dict[str, Any]] = None
    for entry in read_registry_entries():
        if entry.get("pid") == child_pid and entry.get("origin"):
            if best is None or entry.get("started_at", 0) > best.get("started_at", 0):
                best = entry
    return best


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


def _sha256_file(path: str) -> Optional[str]:
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
    except Exception:
        return None
    return h.hexdigest()


_REFUSAL_TEXT = {
    "code-fingerprint-mismatch": "it runs different bili code than this plugin would spawn (stale/foreign build)",
    "lane-mismatch": "it belongs to another lane — lane isolation (#1225/#2905); list its lane in native.attachLanePriority to allow",
    "host-or-passthrough-mismatch": "its bind host or passthrough posture differs from this hook's",
    "mitm-domains-mismatch": "its MITM whitelist does not cover this hermes's providers — model traffic would blind-tunnel",
    "model-tables-mismatch": "its model window/max-output table differs from this hook's (none)",
}


def _attach_reason(inst: Dict[str, Any], fingerprint: Optional[str], want_domains: List[str],
                   foreign_lanes: List[str]) -> Optional[str]:
    """First failing compatibility check, mirroring instanceCompatible (src/launcher.ts);
    None when the candidate is attachable."""
    if fingerprint is None or inst["code_fingerprint"] is None or inst["code_fingerprint"] != fingerprint:
        return "code-fingerprint-mismatch"
    lane = inst["lane"]
    if lane is not None and lane != AGENT_NAME and lane not in foreign_lanes:
        return "lane-mismatch"
    if inst["host"] != "127.0.0.1" or inst["passthrough"] is not False:
        return "host-or-passthrough-mismatch"
    if inst["mitm_domains"] != want_domains:
        return "mitm-domains-mismatch"
    if inst["model_windows"] != {} or inst["model_max_outputs"]:
        return "model-tables-mismatch"
    return None


def _refuse(origin: str, message: str) -> None:
    if origin in _state["refused"]:
        return
    _state["refused"].add(origin)
    logger.warning("billion-context: refusing to attach to %s — %s.", origin, message)


def discover_instance(script: str, deadline: Optional[float] = None,
                      stop: Optional[threading.Event] = None) -> Optional[str]:
    """#2905: lane-aware attach discovery — the Python twin of probeLiveInstances +
    pickAttachable (src/launcher.ts). Candidates come from EVERY live registry marker plus
    the single proxy-origin file (registry wins id collisions, mirroring probeLiveInstances).
    A candidate must match our CODE (entry-script fingerprint), our config shape (bind host,
    passthrough, MITM whitelist, model tables) and the LANE rules: own lane first, then the
    operator-listed foreign lanes (native.attachLanePriority), user-zone daemons (manual
    `bili start`, the 8787 global) ALWAYS last. The #1335 lifecycle gate still applies —
    except to the user zone (#1660): an unarmed daemon the user maintains deliberately is a
    legitimate LAST-resort target, unlike a session proxy whose watchdog drifted away."""
    candidates: Dict[str, Dict[str, Any]] = {}
    file_inst = read_instance_file()
    if file_inst:
        candidates[file_inst["instance_id"] or file_inst["origin"]] = file_inst
    for entry in read_registry_entries():
        candidates[entry["instance_id"] or entry["origin"]] = entry
    if not candidates:
        return None
    fingerprint = _sha256_file(script)
    want_domains = mitm_domains_from_config()
    foreign_lanes = resolve_attach_lane_priority()
    attach_external = resolve_attach_external()
    best_key: Optional[Tuple[int, int]] = None
    best: Optional[Dict[str, Any]] = None
    for inst in candidates.values():
        if _stopped() or (stop is not None and stop.is_set()) or (deadline is not None and time.monotonic() >= deadline):
            return None
        origin = inst["origin"]
        if inst["pid"] is not None and not pid_alive(inst["pid"]):
            continue
        reason = _attach_reason(inst, fingerprint, want_domains, foreign_lanes)
        if reason is not None:
            _refuse(origin, _REFUSAL_TEXT.get(reason, reason))
            continue
        if not probe_proxy(origin):
            continue
        health = http_get_json(origin.rstrip("/") + "/__bili/health", HEALTH_PROBE_TIMEOUT_S)
        if not isinstance(health, dict) or health.get("ok") is not True:
            continue
        hid = health.get("instanceId")
        if isinstance(hid, str) and hid != inst["instance_id"]:
            continue
        wd = health.get("watchdog")
        armed = wd.get("armed") if isinstance(wd, dict) and isinstance(wd.get("armed"), bool) else None
        user_zone = inst["lane"] is None and inst["launch_token"] is None
        if not attach_external and armed is not True and not user_zone:
            _refuse(origin, "it reports "
                            + ("NO session-lifecycle watchdog (started without BILI_PARENT_PID, e.g. manual `bili start`)"
                               if armed is False
                               else "no watchdog state (older bili build) — its lifecycle is unverifiable")
                            + " (#1322/#1335). Starting a session-owned proxy instead; set native.attachExternal=true "
                            + "or " + ATTACH_EXTERNAL_ENV + "=1 to attach anyway.")
            continue
        lane = inst["lane"]
        if lane == AGENT_NAME:
            cls = 0
        elif lane is not None:
            cls = 1 + foreign_lanes.index(lane)
        else:
            cls = len(foreign_lanes) + 1
        key = (cls, -inst["started_at"])
        if best_key is None or key < best_key:
            best_key, best = key, inst
    if best is None:
        return None
    _state["instance_id"] = best["instance_id"]
    return best["origin"]


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


def claim_starting_marker(token: str, port: int, lane: Optional[str] = None) -> bool:
    """Pure O_EXCL claim (#707). A live holder — of ANY lane — wins; the caller inspects the
    marker and decides between waiting, removing a stale one, or spawning without coordinating
    (#1225 lane semantics)."""
    path = _marker_path()
    marker: Dict[str, Any] = {"token": token, "pid": os.getpid(), "host": "127.0.0.1", "port": port,
                              "startedAt": int(time.time() * 1000)}
    if lane:
        # #1225: declare our lane so OTHER lanes' launchers can tell our bring-up from theirs
        # instead of stalling behind it for the whole TTL.
        marker["lane"] = lane
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(marker))
        return True
    except FileExistsError:
        return False
    except Exception:
        return False


def remove_stale_marker() -> bool:
    """Unlink ONLY when the holder is verified dead/TTL-expired or unreadable. While any marker
    file exists, O_EXCL bars a newer claimant, so this can never clobber a live coordinator."""
    cur = _read_marker()
    if cur is not None and not _marker_is_stale(cur):
        return False
    try:
        _marker_path().unlink()
        return True
    except FileNotFoundError:
        return True
    except Exception:
        return False


def _marker_lane_matches(marker: Dict[str, Any]) -> bool:
    """#1225: an undeclared lane wildcards on both sides — only two DIFFERENT declared lanes are
    mutually invisible to each other's starting markers."""
    lane = marker.get("lane")
    return not isinstance(lane, str) or lane == "" or lane == AGENT_NAME


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


def _yaml_loader() -> Callable[[str], Any]:
    """Return a YAML-text parser: PyYAML when present, else ruamel.yaml — some Hermes runtimes
    ship only one of the two (#2838), so neither branch may be dropped. Raises if neither imports."""
    try:
        import yaml  # type: ignore  # noqa: PLC0415
        return yaml.safe_load
    except Exception:
        pass
    from ruamel.yaml import YAML  # type: ignore  # noqa: PLC0415
    return YAML(typ="safe").load


def mitm_domains_from_config() -> List[str]:
    """https hosts of the hermes providers (best effort) — the CONNECT+MITM whitelist that lets
    bili see (and compress) the model traffic instead of blind-tunneling it."""
    cfg = hermes_home() / "config.yaml"
    try:
        text = cfg.read_text(encoding="utf-8")
    except Exception:
        return []
    try:
        load = _yaml_loader()
    except Exception as exc:
        logger.warning(
            "billion-context: no usable YAML parser (%s); cannot read %s for MITM-domain "
            "discovery — model traffic will blind-tunnel until fixed", type(exc).__name__, cfg,
        )
        return []
    try:
        data = load(text)
    except Exception as exc:
        logger.warning(
            "billion-context: could not parse %s for MITM-domain discovery (%s) — model "
            "traffic will blind-tunnel until fixed", cfg, type(exc).__name__,
        )
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


def _norm_base_url(url: Any) -> str:
    """Lowercase, trailing-slash-stripped form used to compare a configured/hook base URL
    against the URL half of a context-cache key."""
    u = str(url or "").strip().lower()
    return u.rstrip("/")


def _base_url_origin(url: Any) -> str:
    """scheme://host[:port] of a base URL — the cache keeps a path suffix (/v1) that some
    configs omit, so a full-URL miss retries at origin granularity."""
    u = _norm_base_url(url)
    scheme, sep, rest = u.partition("://")
    if not sep:
        return u
    return scheme + "://" + rest.split("/", 1)[0]


def _provider_base_url(provider: Any) -> Optional[str]:
    """The configured base URL of one hermes provider (best effort; same config keys as
    mitm_domains_from_config). None when absent/unreadable."""
    name = str(provider or "").strip()
    if not name:
        return None
    cfg = hermes_home() / "config.yaml"
    try:
        data = _yaml_loader()(cfg.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    def pick(entry: Any) -> Optional[str]:
        if not isinstance(entry, dict):
            return None
        for key in ("base_url", "url", "api"):
            if entry.get(key):
                return str(entry[key]).strip()
        return None

    providers = data.get("providers")
    if isinstance(providers, dict):
        found = pick(providers.get(name))
        if found:
            return found
    legacy = data.get("custom_providers")
    if isinstance(legacy, list):
        for entry in legacy:
            if str((entry or {}).get("name") or "").strip() == name:
                found = pick(entry)
                if found:
                    return found
    return None


def _request_base_url(request: Dict[str, Any], context: Dict[str, Any]) -> Optional[str]:
    """Best-effort base URL of an outgoing request: hook/request-supplied fields first,
    then the provider entry in config.yaml resolved by the hook's provider name."""
    for source in (context, request):
        for key in ("base_url", "url"):
            v = source.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return _provider_base_url(context.get("provider"))


def _host_import(module: str) -> Any:
    """Import one hermes module from the plugin process (the plugin is loaded *inside* the agent,
    so `agent.*` is importable). Cached; None when the module is unavailable (standalone tests,
    a stripped install) — every caller treats that as "ask the host failed, fail open"."""
    try:
        import importlib  # noqa: PLC0415
        return importlib.import_module(module)
    except Exception:
        return None


def _positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    n = int(value)
    return n if n > 0 else None


def _host_provider_slugs(base: str) -> List[str]:
    """Registry provider slugs suggested by a base URL host: `apihub.agnes-ai.com` suggests
    `agnes`. Labels are compared with their `-ai` suffix stripped and must be at least 3 chars,
    so a short vendor key cannot accidentally claim an unrelated host."""
    origin = _base_url_origin(base)
    _, _, rest = origin.partition("://")
    host = rest.split("/", 1)[0].split("@")[-1].split(":")[0]
    labels = [lbl for lbl in host.replace("-", ".").split(".") if len(lbl) >= 3]
    return labels


def _catalog_context(md: Any, name: str, base: str = "") -> Optional[int]:
    """Unscoped models.dev lookup: a custom provider (an OpenAI-compatible reseller) has no
    PROVIDER_TO_MODELS_DEV mapping, so the host's provider-scoped catalog step cannot see it — yet
    models.dev lists the very same model under the vendor's own slug. Read the host's on-disk
    registry (allow_network=False, never the network) for an exact (case-insensitive) model id.
    When the endpoint's host names exactly one catalogued vendor, that vendor's number wins;
    otherwise every match must agree on ONE number, and an ambiguous model id yields nothing
    rather than a guess (aggregators list resold models with their own caps)."""
    registry = None
    with contextlib.suppress(Exception):
        registry = md.fetch_models_dev(allow_network=False)
    if not isinstance(registry, dict):
        return None
    target = name.strip().lower()

    def contexts(entry: Any) -> List[int]:
        models = entry.get("models") if isinstance(entry, dict) else None
        if not isinstance(models, dict):
            return []
        out: List[int] = []
        for mid, model in models.items():
            if str(mid).strip().lower() != target:
                continue
            limit = model.get("limit") if isinstance(model, dict) else None
            ctx = _positive_int(limit.get("context")) if isinstance(limit, dict) else None
            if ctx is not None:
                out.append(ctx)
        return out

    labels = set(_host_provider_slugs(base))
    keyed = [pid for pid, entry in registry.items()
             if isinstance(entry, dict) and str(pid).strip().lower() in labels]
    if len(keyed) == 1:
        got = contexts(registry[keyed[0]])
        if got and len(set(got)) == 1:
            return got[0]
    values: List[int] = []
    for entry in registry.values():
        values.extend(contexts(entry))
    return values[0] if values and len(set(values)) == 1 else None


def _host_resolve(name: str, base: str) -> Optional[int]:
    """Ask the host to resolve the window itself, cache-first, mirroring the order Hermes uses:
    config.yaml override -> persistent cache -> endpoint /models (+ llama.cpp /props) -> local
    server probe -> models.dev catalog. The two network steps are the host's own probes, which it
    TTL-memosizes on disk and caps at 3s; the rest never touches the network. Positive results are
    persisted through the host's writer so the next process hits the file path directly."""
    mm = _host_import("agent.model_metadata")
    if mm is None:
        return None
    found: Any = None
    cfg = _host_import("hermes_cli.config_providers")
    if cfg is not None and base:
        with contextlib.suppress(Exception):
            found = cfg.get_custom_provider_context_length(model=name, base_url=base)
    if found is None and base:
        with contextlib.suppress(Exception):
            found = mm.get_cached_context_length(name, base)
    if found is None and base:
        # Endpoint metadata first: it is disk-memoized. The live local probe is last (3s timeout,
        # 30s in-process memo on the host side) so a cold model costs one bounded probe, not a stall.
        for step in ("_resolve_endpoint_context_length", "_query_local_context_length"):
            fn = getattr(mm, step, None)
            if fn is None:
                continue
            with contextlib.suppress(Exception):
                found = fn(name, base)
            if _positive_int(found):
                break
    if found is None:
        md = _host_import("agent.models_dev")
        if md is not None:
            provider = None
            with contextlib.suppress(Exception):
                provider = mm._infer_provider_from_url(base) if base else None
            with contextlib.suppress(Exception):
                found = md.lookup_models_dev_context(provider or "", name)
            if not _positive_int(found):
                found = _catalog_context(md, name, base)
    ctx = _positive_int(found)
    if ctx is None:
        return None
    # Persist through the host's writer (locked + atomic) so the answer is reused by every process.
    # Sub-minimum windows stay unpersisted, matching the host's own _maybe_cache_local_context_length.
    if base and ctx >= _MIN_PERSIST_CONTEXT:
        with contextlib.suppress(Exception):
            mm.save_context_length(name, base, ctx)
    return ctx


def _host_output_limit(name: str, base: str) -> Optional[int]:
    mm = _host_import("agent.model_metadata")
    fetch = getattr(mm, "fetch_endpoint_model_metadata", None)
    if not callable(fetch) or not base:
        return None
    metadata = fetch(base)
    entry = metadata.get(name) if isinstance(metadata, dict) else None
    return _positive_int(entry.get("max_completion_tokens")) if isinstance(entry, dict) else None


def _host_model_limit(model: Any, base_url: Any, output: bool = False) -> Optional[int]:
    """Resolve context or output limits through one nonblocking TTL memo.

    The context resolver persists windows through the host; output limits are read from exact
    endpoint model entries and remain in memory. A cold lookup starts a background resolve and
    returns None for this request. Positives live an hour, misses 30 seconds.
    """
    name = str(model or "").strip()
    if not name:
        return None
    key = (name, _norm_base_url(base_url), output)
    now = time.monotonic()
    with _host_resolve_lock:
        hit = _host_resolve_cache.get(key)
        if hit is not None and (now - hit[1]) < (_HOST_HIT_TTL_S if hit[0] is not None else _HOST_MISS_TTL_S):
            return hit[0]
        if key in _host_resolve_inflight:
            return None
        if len(_host_resolve_cache) > MAX_TRACKED_SESSIONS:
            _host_resolve_cache.clear()
        _host_resolve_inflight.add(key)

    def resolve() -> None:
        result: Optional[int] = None
        try:
            result = _host_output_limit(name, key[1]) if output else _host_resolve(name, key[1])
        except Exception:
            result = None
        with _host_resolve_lock:
            _host_resolve_inflight.discard(key)
            _host_resolve_cache[key] = (result, time.monotonic())
        if result is not None:
            logger.info("billion-context: resolved %s of %s at %s to %s tokens",
                        "max output" if output else "context window", name,
                        key[1] or "the configured endpoint", f"{result:,}")

    threading.Thread(target=resolve, name="bili-model-limit", daemon=True).start()
    return None


def host_context_length(model: Any, base_url: Any) -> Optional[int]:
    return _host_model_limit(model, base_url)


def context_window_for(model: Any, base_url: Any = None) -> Optional[int]:
    """#3261: the host's own known context window for a model, read from
    HERMES_HOME/context_length_cache.yaml, and on a miss resolved by asking the host (see
    host_context_length). Fail-open to None on any miss/error so the proxy falls back to its normal
    window chain. A stage matching several DIFFERENT windows yields nothing rather than a guess: an
    overestimate risks preflight overflow, an underestimate over-compresses — both worse than the
    default the proxy would otherwise use."""
    name = str(model or "").strip()
    if not name:
        return None
    cache_file = hermes_home() / "context_length_cache.yaml"
    data: Any = None
    try:
        data = _yaml_loader()(cache_file.read_text(encoding="utf-8"))
    except Exception:
        data = None
    if not isinstance(data, dict):
        data = None
    # Hermes persists a NESTED document — {"context_lengths": {"<model>@<base_url>": tokens}} — via
    # agent/model_metadata_cache._write_context_cache. Reading the top level alone matched NOTHING,
    # so the plugin never reported a window and the proxy silently used its own chain. Unwrap the
    # section, keeping the flat shape readable for older/legacy files.
    sections: List[Dict[Any, Any]] = []
    nested = data.get("context_lengths") if isinstance(data, dict) else None
    if isinstance(nested, dict):
        sections.append(nested)
    if isinstance(data, dict) and any(isinstance(v, (int, float)) for v in data.values()):
        sections.append(data)
    pairs: List[Tuple[str, int]] = []
    for section in sections:
        for key, value in section.items():
            k = str(key)
            at = k.find("@")
            if at <= 0 or k[:at].strip() != name:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
                continue
            pairs.append((_norm_base_url(k[at + 1 :]), int(value)))

    def sole(values: List[int]) -> Optional[int]:
        return values[0] if len(set(values)) == 1 else None

    wanted = _norm_base_url(base_url) if base_url else ""
    if wanted:
        for stage in (
            lambda u: u == wanted,
            lambda u: _base_url_origin(u) == _base_url_origin(wanted),
        ):
            got = sole([v for u, v in pairs if stage(u)])
            if got is not None:
                return got
    exact = sole([v for _, v in pairs])
    if exact is not None:
        return exact
    # Nothing authoritative in the file (unregistered model, empty cache, or a multi-value conflict):
    # resolve through the host and persist it, so a model the user just switched to needs no manual
    # providers.* pin. An ambiguous file stays ambiguous only when the host cannot disambiguate.
    return host_context_length(name, base_url)


def _spawn_child(sidecar: Dict[str, str], port: int, token: str) -> Optional[subprocess.Popen]:
    log_path = os.path.join(tempfile.gettempdir(), f"bili-proxy-{port}.log")
    env = {k: v for k, v in os.environ.items() if k not in _PROXY_ENV_KEYS}
    env["BILI_LAUNCH_TOKEN"] = token
    env["BILI_PARENT_PID"] = str(os.getpid())
    env["BILI_LAUNCHER_LANE"] = AGENT_NAME
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


def _stopped() -> bool:
    """True once the host unloaded the plugin: the bootstrap must not touch the proxy or the
    registration surface any more (a late register_* after unload would leak an orphan entry)."""
    event = _state.get("stop_event")
    return bool(event is not None and event.is_set())


def _reap_unready_child() -> None:
    """Terminate a proxy we spawned but never became healthy with: it has no watchdog owner yet
    (the plugin never registered as one), so nothing else would reap it. Once the process env
    routes through an origin, killing it would break traffic — such a child is left to the
    watcher/watchdog protocol (it carries BILI_PARENT_PID and exits with the host)."""
    if _state.get("tools_ready") or _state.get("env_applied"):
        return
    child = _state.get("child")
    _state["child"] = None
    if child is None or child.poll() is not None:
        return
    try:
        child.terminate()
    except Exception:
        pass


def ensure_origin(sidecar: Dict[str, str], deadline: Optional[float] = None) -> Optional[str]:
    """Return a healthy proxy origin. Attach when possible (explicit target, then any recorded
    instance); otherwise spawn our own behind the starting-marker arbiter.

    `deadline` is ONE monotonic instant shared by every wait below (attach poll, marker
    arbitration, spawn poll) — the caller's total budget, never a per-stage one: stages that each
    take a fresh timeout turn one cold start into a three-minute one and make the first-request
    wait impossible to size. Defaults to the historical single SPAWN_WAIT_S slice."""
    if deadline is None:
        deadline = time.monotonic() + SPAWN_WAIT_S
    attach = (os.environ.get(ATTACH_ENV) or "").strip().rstrip("/")
    if attach:
        # An explicit target may be a launcher-owned proxy that is still BOOTING (the launcher
        # starts the proxy and hermes concurrently; a cold store takes far longer than one TCP
        # probe). Poll it for the shared budget instead of declaring it dead and spawning a
        # second proxy that would compete for the same session store.
        attach_wait = min(max(0.0, deadline - time.monotonic()), ATTACH_WAIT_S)
        attach_deadline = time.monotonic() + attach_wait
        while True:
            if _stopped():
                return None
            if probe_proxy(attach):
                return _attach(attach)
            if time.monotonic() >= attach_deadline:
                break
            time.sleep(SPAWN_POLL_S)
        logger.warning("billion-context: %s %s is not healthy after %.0fs — falling back to local bootstrap",
                       ATTACH_ENV, attach, attach_wait)

    found = discover_instance(sidecar["script"], deadline=deadline, stop=_state.get("stop_event"))
    if found:
        return _attach(found)

    port = pick_port()
    if port is None:
        return None
    token = uuid.uuid4().hex
    claimed = claim_starting_marker(token, port, AGENT_NAME)
    if not claimed:
        holder = _read_marker()
        if holder is not None and not _marker_is_stale(holder):
            if _marker_lane_matches(holder):
                # A same-lane starter may produce an instance we can attach to: honor its
                # bring-up instead of double-spawning over the same session store (#707).
                while time.monotonic() < deadline:
                    if _stopped():
                        return None
                    found = discover_instance(sidecar["script"], deadline=deadline,
                                              stop=_state.get("stop_event"))
                    if found:
                        return _attach(found)
                    marker = _read_marker()
                    if marker is None or _marker_is_stale(marker) or not _marker_lane_matches(marker):
                        break
                    time.sleep(SPAWN_POLL_S)
                # Final discovery pass closes the deadline-boundary sliver (#707, mirrors
                # waitForStarterInstance in src/launcher.ts): the starter's own poll window ends
                # ~now and its success path clears the marker — without one last look, an attach
                # landing right at the boundary looks like a failure bail and double-spawns.
                found = discover_instance(sidecar["script"], stop=_state.get("stop_event"))
                if found:
                    return _attach(found)
                claimed = claim_starting_marker(token, port, AGENT_NAME)
            # A live DIFFERENT-lane holder can never produce an instance this lane may attach to
            # (#1225): spawn without coordinating, and leave its marker ALONE — removing it would
            # break THAT starter's coordination with its own same-lane launches.
        elif remove_stale_marker():
            # Stale or unreadable (crash mid-write): safe to remove — retry once to take the slot.
            claimed = claim_starting_marker(token, port, AGENT_NAME)
        # Still unclaimed (unwritable state dir, or lost the retry race): degrade to pre-#707
        # behavior — spawn without coordinating; the token-guarded clear below becomes a no-op.
    try:
        child = _spawn_child(sidecar, port, token)
        if child is None:
            return None
        _state["child"] = child
        while time.monotonic() < deadline:
            if _stopped():
                return None
            inst = read_instance_file()
            if inst and inst.get("launch_token") == token and probe_proxy(inst["origin"]):
                _state.update(origin=inst["origin"], mode="spawn")
                return inst["origin"]
            mine = _find_spawned_in_registry(child.pid)
            if mine and probe_proxy(mine["origin"]):
                _state.update(origin=mine["origin"], mode="spawn",
                              instance_id=mine.get("instance_id") or None)
                return mine["origin"]
            if child.poll() is not None:
                logger.warning("billion-context: proxy child exited before becoming healthy "
                               "(code %s); log: %s", child.returncode,
                               os.path.join(tempfile.gettempdir(), f"bili-proxy-{port}.log"))
                return None
            time.sleep(SPAWN_POLL_S)
        logger.warning("billion-context: proxy did not become healthy within its startup budget")
        try:
            child.terminate()
        except Exception:
            pass
        return None
    finally:
        if claimed:
            clear_starting_marker(token)


# — runtime effects -------------------------------------------------------------

# The exact keys apply_env routes; _unroute_env restores them one-for-one on origin death (#4644).
_ENV_ROUTED_KEYS = (
    "HTTPS_PROXY", "https_proxy",
    "HTTP_PROXY", "http_proxy",
    "NO_PROXY", "no_proxy",
    "HERMES_CA_BUNDLE", "SSL_CERT_FILE",
)

_LOOPBACK_NO_PROXY_HOSTS = ("localhost", "127.0.0.1", "::1")


def _merge_loopback_no_proxy() -> None:
    """#5117: merge the loopback hosts into NO_PROXY/no_proxy so plain-http loopback legs
    (local model servers, MCP endpoints) stay direct while HTTP_PROXY routes everything else
    through bili — the same contract the dsh/kimi/mcode/jcode launcher lanes keep. Whatever the
    user already set in either case variant is preserved; the merged value is written to both."""
    parts: List[str] = []
    seen: set = set()
    for raw in (os.environ.get("NO_PROXY"), os.environ.get("no_proxy")):
        if not isinstance(raw, str):
            continue
        for host in raw.split(","):
            h = host.strip()
            if not h or h.lower() in seen:
                continue
            seen.add(h.lower())
            parts.append(h)
    for host in _LOOPBACK_NO_PROXY_HOSTS:
        if host.lower() not in seen:
            seen.add(host.lower())
            parts.append(host)
    value = ",".join(parts)
    os.environ["NO_PROXY"] = value
    os.environ["no_proxy"] = value


def apply_env(origin: str, sidecar: Optional[Dict[str, str]] = None, ctx: Any = None) -> bool:
    """Route hermes's model traffic through the proxy. Only called once the proxy is healthy —
    the same env `bili hermes` sets for the launched process. Returns False when the host unloaded
    the plugin first: routing a torn-down process's traffic would outlive the unload (checked and
    applied under the lifecycle lock, so an unload cannot slip between the two)."""
    with _lifecycle_lock:
        if _stopped():
            return False
        if not _state.get("env_applied"):
            # Remember what we are about to overwrite so _unroute_env can put it BACK when the
            # origin dies mid-session — restoring (not deleting) keeps a user's pre-existing
            # proxy configuration intact.
            backup = _state.get("env_backup")
            if not isinstance(backup, dict) or not backup:
                _state["env_backup"] = {key: os.environ.get(key) for key in _ENV_ROUTED_KEYS}
        os.environ["HTTPS_PROXY"] = origin
        os.environ["https_proxy"] = origin
        # #5117: hermes' httpx stack resolves proxy envs PER SCHEME — an http:// base_url reads
        # HTTP_PROXY and never HTTPS_PROXY — so a plain-http provider went straight out and bili
        # never saw it. Route it like the dsh/kimi/mcode launcher lanes do: absolute-form
        # forward-proxy requests the server understands.
        os.environ["HTTP_PROXY"] = origin
        os.environ["http_proxy"] = origin
        _merge_loopback_no_proxy()
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
    _ensure_watchdog(sidecar, ctx)
    return True


def _unroute_env() -> None:
    """Undo apply_env after the routed origin died (#4644): restore whatever was there before we
    routed (or drop the key entirely). Caller holds _lifecycle_lock."""
    backup = _state.get("env_backup")
    for key in _ENV_ROUTED_KEYS:
        original = backup.get(key) if isinstance(backup, dict) else None
        if original is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = original
    _state["env_applied"] = False
    _state["env_backup"] = {}


def _ensure_watchdog(sidecar: Optional[Dict[str, str]], ctx: Any) -> None:
    """Start the origin-health watchdog once per generation (#4644). A live thread means nothing
    to do; register()/unload bump watchdog_gen so a previous generation's thread exits on its next
    tick instead of double-driving recovery."""
    if sidecar is None or ctx is None or _stopped():
        return
    thread = _state.get("watchdog_thread")
    if thread is not None and thread.is_alive():
        return
    gen = int(_state.get("watchdog_gen") or 0)
    watcher = threading.Thread(target=_watchdog_loop, args=(sidecar, ctx, gen),
                               name="bili-origin-watchdog", daemon=True)
    _state["watchdog_thread"] = watcher
    watcher.start()


def _watchdog_loop(sidecar: Dict[str, str], ctx: Any, gen: int) -> None:
    """#4644: poll the ROUTED origin; N consecutive probe failures (or our own child exiting)
    mean it is gone — unroute the process env and re-bootstrap inline, watching the new origin.
    Without this, the env written once at bootstrap keeps pointing at a dead port for the whole
    host lifetime (silent direct connection). The death verdict is re-validated against the
    CURRENT origin under the lifecycle lock, so a concurrent re-route/unload wins over a stale
    probe result."""
    fails = 0
    while True:
        if _stopped() or int(_state.get("watchdog_gen") or 0) != gen:
            return
        event = _state.get("stop_event")
        if event is not None and event.wait(ORIGIN_WATCH_INTERVAL_S):
            return
        if _stopped() or int(_state.get("watchdog_gen") or 0) != gen:
            return
        with _lifecycle_lock:
            origin = _state.get("origin")
            env_applied = bool(_state.get("env_applied"))
            child = _state.get("child")
        if not origin or not env_applied:
            fails = 0
            continue
        reason: Optional[str] = None
        if child is not None and child.poll() is not None:
            reason = f"proxy child exited (code {child.returncode})"
        elif probe_proxy(str(origin)):
            fails = 0
            continue
        else:
            fails += 1
            if fails >= ORIGIN_WATCH_FAIL_LIMIT:
                reason = f"unreachable {fails}\u00d7 in a row"
        if reason is None:
            continue
        with _lifecycle_lock:
            if _stopped() or int(_state.get("watchdog_gen") or 0) != gen:
                return
            if (_state.get("origin") != origin or not _state.get("env_applied")
                    or _state.get("recovering")):
                fails = 0
                continue
            had_tools = bool(_state.get("tools_ready"))
            dead_child = _state.get("child")
            _unroute_env()
            # tool_names stays intact on purpose: the host session snapshot permanently carries
            # the registered tools, and their handlers follow _state["origin"] dynamically — so
            # the recovered origin serves this session in plugin mode from a fresh fold state.
            _state.update(tools_ready=False, origin=None, mode=None, instance_id=None,
                          child=None, warned_direct=False, recovering=True)
            ready = _state.get("ready_event")
            if ready is not None:
                ready.clear()
            rec = _bootstrap_record()
            rec.update(state="starting", started_at=time.monotonic(), error=None, attempt=1)
        if dead_child is not None:
            try:
                dead_child.terminate()
            except Exception:
                pass
        logger.warning("billion-context: routed proxy %s is gone (%s) — unrouting and re-bootstrapping; "
                       "model traffic goes direct until a new origin is healthy", origin, reason)
        try:
            _bootstrap(sidecar, ctx, skip_register=had_tools)
        except Exception as exc:
            logger.warning("billion-context: recovery bootstrap failed (%s)", exc)
        finally:
            with _lifecycle_lock:
                _state["recovering"] = False
        fails = 0


def make_tool_handler(tool_name: str) -> Callable[..., str]:
    def handler(args: Dict[str, Any], **kwargs: Any) -> str:
        origin = _state.get("origin")
        # #2072: the kwargs session_id is host machine metadata stamped per call;
        # the args conversation_id fallback is model-transcribed and must keep
        # the #1685 witness precedence (no nativeCaller flag on that channel).
        session_id = kwargs.get("session_id")
        conversation = session_id or (args or {}).get("conversation_id")
        if not origin:
            return json.dumps({"error": "billion-context proxy is not available in this session"})
        if not conversation:
            return json.dumps({"error": "no hermes session id — cannot bind the compression conversation"})
        body: Dict[str, Any] = {"conversationId": str(conversation), "tool": tool_name, "args": args or {}}
        if session_id:
            body["nativeCaller"] = True
        status, payload = http_post_json(
            origin.rstrip("/") + "/__bili/plugin/tool",
            body,
            TOOL_TIMEOUT_S,
        )
        if status == 200 and isinstance(payload, dict) and payload.get("ok"):
            result = payload.get("result")
            return result if isinstance(result, str) else json.dumps(result)
        detail = payload.get("error") if isinstance(payload, dict) else None
        return json.dumps({"error": f"billion-context tool failed (http {status}): {detail or 'unknown error'}"})
    return handler


# — startup bootstrap ------------------------------------------------------------

def _bootstrap_record() -> Dict[str, Any]:
    rec = _state.get("bootstrap")
    if not isinstance(rec, dict):
        rec = {"state": "starting", "started_at": time.monotonic(), "error": None}
        _state["bootstrap"] = rec
    return rec


def _register_tools(ctx: Any, tools: List[Any]) -> List[str]:
    """Register the manifest's tools and commit the readiness flag under the lifecycle lock, so an
    unload lands either entirely before (nothing registered, tools stay unavailable) or entirely
    after (the host disposes them) — never between check and registration."""
    names: List[str] = []
    with _lifecycle_lock:
        if _stopped():
            return names
        for tool in tools:
            if not isinstance(tool, dict) or not tool.get("name"):
                continue
            name = str(tool["name"])
            ctx.register_tool(
                name=name,
                toolset=PLUGIN_ID,
                schema=tool.get("input_schema") or {},
                handler=make_tool_handler(name),
                description=str(tool.get("description") or ""),
            )
            names.append(name)
        _state["tool_names"] = tuple(names)
        _state["tools_ready"] = True
    return names


def _sleep_backoff(attempt: int) -> bool:
    """Sleep before bootstrap retry #(attempt+1); False when the plugin was unloaded meanwhile."""
    delays = BOOTSTRAP_RETRY_BACKOFF_S
    delay = delays[min(attempt, len(delays)) - 1]
    event = _state.get("stop_event")
    if event is not None:
        return not event.wait(delay)
    time.sleep(delay)
    return not _stopped()


def _bootstrap(sidecar: Dict[str, str], ctx: Any, skip_register: bool = False) -> None:
    """The slow half of register(): find/spawn a healthy proxy, route the process env through it,
    and install the native tools. It runs on a daemon thread so the host's load deadline only
    bounds the cheap registrations (REGISTER_WAIT_S). Every side effect re-checks the stop event:
    an unload mid-bootstrap must leave neither a registration nor a child behind.

    #4644: failed stages are retried with backoff (BOOTSTRAP_RETRY_BACKOFF_S), each attempt on a
    FRESH BOOTSTRAP_BUDGET_S, and a stage that already succeeded is not re-run (a healthy origin
    is not re-probed, a registered tool set is not re-fetched). skip_register marks the recovery
    path: the host session snapshot already carries the tools from the previous generation and
    their handlers follow _state["origin"] dynamically, so registration is re-armed, not repeated."""
    rec = _bootstrap_record()
    max_attempts = len(BOOTSTRAP_RETRY_BACKOFF_S) + 1
    origin: Optional[str] = None
    env_ok = False
    try:
        for attempt in range(1, max_attempts + 1):
            rec.update(attempt=attempt)
            if _stopped():
                _reap_unready_child()
                return
            if origin is None:
                deadline = time.monotonic() + BOOTSTRAP_BUDGET_S
                origin = ensure_origin(sidecar, deadline=deadline)
                if _stopped():
                    _reap_unready_child()
                    return
                if not origin:
                    if attempt < max_attempts:
                        if not _sleep_backoff(attempt):
                            return  # unloaded during the backoff — _shutdown owns the record
                        logger.warning("billion-context: could not reach or start a bili proxy "
                                       "(attempt %d/%d) — retrying", attempt, max_attempts)
                        continue
                    rec.update(state="failed", error=f"could not reach or start a bili proxy "
                               f"(after {attempt} attempt{'s' if attempt > 1 else ''})")
                    logger.warning("billion-context: could not reach or start a bili proxy after "
                                   "%d attempt%s — model traffic goes direct (uncompressed) in "
                                   "this process", attempt, "s" if attempt > 1 else "")
                    return
            if not env_ok:
                if not apply_env(origin, sidecar, ctx):
                    _reap_unready_child()
                    return
                env_ok = True
            if skip_register and _state.get("tool_names"):
                names = list(_state["tool_names"])
                with _lifecycle_lock:
                    if _stopped():
                        _reap_unready_child()
                        return
                    _state["tools_ready"] = True
            else:
                manifest = http_get_json(origin.rstrip("/") + "/__bili/plugin/manifest", MANIFEST_TIMEOUT_S)
                tools = manifest.get("tools", {}).get("anthropic") if isinstance(manifest, dict) else None
                # #4855: the proxy names the header that flips compression to its own channel for a
                # request whose tool snapshot lacks the native tools. Absent on older proxies.
                declared = manifest.get("headers") if isinstance(manifest, dict) else None
                compression_header = declared.get("compression") if isinstance(declared, dict) else None
                _state["compression_header"] = (_stampable_header_value(compression_header)
                                                if isinstance(compression_header, str) and compression_header
                                                else None)
                if not isinstance(tools, list) or not tools:
                    if attempt < max_attempts and _sleep_backoff(attempt):
                        logger.warning("billion-context: proxy manifest had no tool definitions "
                                       "(attempt %d/%d) — retrying", attempt, max_attempts)
                        continue
                    rec.update(state="failed", error="proxy manifest had no tool definitions")
                    logger.warning("billion-context: proxy manifest had no tool definitions — "
                                   "compression stays server-side (proxy mode)")
                    return
                names = _register_tools(ctx, tools)
                if not _state.get("tools_ready"):
                    _reap_unready_child()
                    return
            with _lifecycle_lock:
                if _stopped():
                    _reap_unready_child()
                    return
                rec.update(state="ready", error=None)
            logger.info("billion-context: hermes native mode ready (%s, attempt %d, tools: %s)",
                        _state.get("mode"), attempt, ", ".join(names))
            return
    except Exception as exc:
        if not _stopped():
            rec.update(state="failed", error=f"{type(exc).__name__}: {exc}")
        if _state.get("origin") and _state.get("env_applied"):
            logger.warning("billion-context: background bootstrap failed (%s) — traffic is routed "
                           "through %s in proxy mode; native tools are unavailable this session",
                           exc, _state.get("origin"))
        else:
            logger.warning("billion-context: background bootstrap failed (%s) — model traffic goes "
                           "direct (uncompressed) in this process", exc)
    finally:
        event = _state.get("ready_event")
        if event is not None:
            event.set()


def _start_bootstrap(sidecar: Dict[str, str], ctx: Any) -> None:
    rec = _bootstrap_record()
    rec.update(state="starting", started_at=time.monotonic(), error=None)
    thread = threading.Thread(target=_bootstrap, args=(sidecar, ctx),
                              name="bili-bootstrap", daemon=True)
    _state["thread"] = thread
    thread.start()


def _shutdown() -> None:
    """on_unload: stop the bootstrap, release anything waiting on it, and reap a child that never
    became healthy. The stop event and the state flags move under the lifecycle lock, so a
    registration/env commit either finished before this call (the host disposes of it) or is
    refused by it; the join runs outside the lock, since the bootstrap needs it to observe the
    stop."""
    with _lifecycle_lock:
        stop = _state.get("stop_event")
        if stop is not None:
            stop.set()
        ready = _state.get("ready_event")
        if ready is not None:
            ready.set()
        _state["loaded"] = False
        _state["tools_ready"] = False
        _state["tool_names"] = ()
        # Invalidate any watchdog of this generation: it must not drive recovery for an
        # unloaded plugin (the stop event above wakes it from its tick wait anyway).
        _state["watchdog_gen"] = int(_state.get("watchdog_gen") or 0) + 1
        rec = _state.get("bootstrap")
        if isinstance(rec, dict) and rec.get("state") != "ready":
            rec.update(state="stopped", error=None)
    thread = _state.get("thread")
    if thread is not None and thread.is_alive() and thread is not threading.current_thread():
        thread.join(timeout=1.0)
    watcher = _state.get("watchdog_thread")
    if watcher is not None and watcher.is_alive() and watcher is not threading.current_thread():
        watcher.join(timeout=1.0)
    _reap_unready_child()


def _stampable_header_value(value: Any) -> Optional[str]:
    """#2455: HTTP header values are ByteStrings — a char above U+00FF (e.g. a Chinese
    provider/model id) makes the host HTTP stack throw when it BUILDS the request, so
    the whole turn dies before reaching the proxy. Return the value only when stamp-safe:
    printable ASCII within the 1..256 span the proxy reader honors (same gate as the JS
    lanes' asciiHeaderValue); else None so the caller skips the header."""
    v = str(value)
    if 1 <= len(v) <= 256 and all(0x21 <= ord(c) <= 0x7e for c in v):
        return v
    return None


def _request_tool_names(request: Dict[str, Any]) -> set:
    """Tool names carried by the OUTGOING request (OpenAI chat, Anthropic messages and Responses
    shapes all covered)."""
    tools = request.get("tools")
    if not isinstance(tools, list):
        return set()
    names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function")
        name = fn.get("name") if isinstance(fn, dict) else tool.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _plugin_tools_visible(request: Dict[str, Any]) -> bool:
    """Plugin mode is only safe when THIS request carries the ACP tools — the agent can then call
    compress/decompress itself. Hermes snapshots agent.tools once per session, so a tool registered
    after that snapshot is absent here; stamping plugin headers anyway would suppress the proxy's
    own tool+nudge injection while the model has no way to compress (silent context growth)."""
    required = [name for name in CORE_TOOL_NAMES if name in _state.get("tool_names", ())]
    if not required:
        return False
    names = _request_tool_names(request)
    return all(name in names for name in required)


def on_llm_request(request: Optional[Dict[str, Any]] = None, **context: Any) -> Optional[Dict[str, Any]]:
    """llm_request middleware. Two jobs:
    1) readiness gate — a cold bootstrap must not let turn 1 slip out direct (that silent
       uncompressed turn is exactly the defect this design fixes); hold it, bounded.
    2) plugin-mode headers — only when the outgoing request itself proves this session's tool
       snapshot has the native tools."""
    try:
        if request is None or not isinstance(request, dict) or not _state.get("loaded"):
            return None
        session_id = context.get("session_id")
        if not session_id:
            return None
        if not _state.get("tools_ready"):
            event = _state.get("ready_event")
            if event is not None:
                event.wait(FIRST_REQUEST_WAIT_S)
        origin = _state.get("origin")
        if not origin or not _state.get("env_applied"):
            if not _state.get("warned_direct"):
                _state["warned_direct"] = True
                logger.warning("billion-context: proxy not ready — this process's model traffic goes "
                               "direct (uncompressed); see the bootstrap warning above")
            return None
        visible = _plugin_tools_visible(request)
        if not visible:
            compression_header = _state.get("compression_header")
            if not compression_header:
                # Older proxy: it would suppress wire injection on the marker alone, so an invisible
                # tool snapshot must stay unstamped (anonymous proxy mode).
                if not _state.get("snapshot_warned"):
                    _state["snapshot_warned"] = True
                    logger.info("billion-context: native tools are not in this session's tool list — "
                                "compressing in proxy mode until a new session")
                return None
            # #4855: Hermes defers every plugin toolset behind tool_search, so the tools exist but
            # never reach the outgoing request. Keep the plugin identity + budget (that is what
            # /acp and the window header read) and hand compression to the proxy explicitly.
            if not _state.get("snapshot_warned"):
                _state["snapshot_warned"] = True
                logger.info("billion-context: native tools are not in this session's tool list — "
                            "keeping the plugin identity and compressing in proxy mode")
        headers = request.get("extra_headers")
        merged = dict(headers) if isinstance(headers, dict) else {}
        merged["x-bili-plugin"] = AGENT_NAME
        merged["x-bili-plugin-conversation"] = str(session_id)
        if not visible:
            merged[_state["compression_header"]] = "proxy"
        model = context.get("model")
        if model:
            model_header = _stampable_header_value(model)
            if model_header is not None:
                merged["x-bili-plugin-model"] = model_header
        base = _request_base_url(request, context)
        max_output = _state["max_output"].get(str(session_id)) or _host_model_limit(model, base, output=True)
        if isinstance(max_output, (int, float)) and max_output > 0:
            merged["x-bili-plugin-max-output"] = str(int(max_output))
        window = context_window_for(model, base)
        if window is not None:
            merged["x-bili-plugin-context-window"] = str(window)
        updated = dict(request)
        updated["extra_headers"] = merged
        return {"request": updated, "source": PLUGIN_ID, "reason": "plugin-mode headers"}
    except Exception:
        return None


def report_runtime_info(model: str, max_output: Optional[int], context_window: Optional[int] = None) -> None:
    try:
        origin = _state.get("origin")
        if not origin:
            return
        mo = int(max_output) if isinstance(max_output, (int, float)) else None
        cw = int(context_window) if isinstance(context_window, (int, float)) else None
        key: Tuple[Any, Any, Any] = (model, mo, cw)
        sent: set = _state["runtime_info_sent"]
        if key in sent:
            return
        sent.add(key)
        if len(sent) > MAX_TRACKED_SESSIONS:
            sent.clear()
        body: Dict[str, Any] = {"agent": AGENT_NAME, "model": model[:256], "source": "hermes-native"}
        if mo is not None and mo > 0:
            body["maxOutput"] = mo
        if cw is not None and cw > 0:
            body["contextWindow"] = cw

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
        table: "OrderedDict[str, int]" = _state["max_output"]
        if session and isinstance(max_tokens, (int, float)) and max_tokens > 0:
            table[session] = int(max_tokens)
            while len(table) > MAX_TRACKED_SESSIONS:
                table.popitem(last=False)
        if model:
            base = _request_base_url({}, _)
            report_runtime_info(
                str(model)[:256],
                (table.get(session) if session else None) or _host_model_limit(model, base, output=True),
                context_window_for(model, base),
            )
    except Exception:
        pass


# — in-session slash commands (/acp, /acp-cache; #3697) --------------------------

def _command_origin() -> Optional[str]:
    """Proxy origin for command queries: our own attach/spawn target first, then an
    explicit BILLION_CONTEXT_PROXY (a launcher-owned proxy we stood down from routing)."""
    origin = _state.get("origin")
    if isinstance(origin, str) and origin.strip():
        return origin.strip().rstrip("/")
    raw = (os.environ.get("BILLION_CONTEXT_PROXY") or "").strip()
    if raw.startswith(("http://", "https://")):
        return raw.rstrip("/")
    return None


def _fetch_status(origin: str, conversation_id: str) -> Optional[Dict[str, Any]]:
    url = (origin + "/__bili/plugin/status?conversationId="
           + urllib.parse.quote(conversation_id, safe=""))
    data = http_get_json(url, STATUS_TIMEOUT_S)
    if isinstance(data, dict):
        resolved = data.get("conversationId")
        if resolved and resolved != conversation_id:
            raise ValueError("proxy returned status for a different conversation")
        return data
    return None


def _fetch_version(origin: str) -> Optional[str]:
    manifest = http_get_json(origin + "/__bili/plugin/manifest", STATUS_TIMEOUT_S)
    if not isinstance(manifest, dict):
        return None
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        return None
    commit = manifest.get("commit")
    return f"{version} ({commit})" if isinstance(commit, str) and commit else version


def acp_command(raw_args: str = "", *, session_id: str = "") -> Optional[str]:
    """`/acp`: this session's context-compression status panel (the panel header carries
    version + build). Mirrors the dsh/pi /acp lanes — every displayed byte comes from the
    proxy's HTTP endpoints."""
    try:
        origin = _command_origin()
        boot: Dict[str, Any] = _state.get("bootstrap") if isinstance(_state.get("bootstrap"), dict) else {}
        boot_state = boot.get("state")
        # Before the bootstrap settles there is no honest panel to show; report the STARTUP state
        # instead of the installer hint (the plugin IS installed, it is just still cold).
        if not _state.get("tools_ready") and boot_state in ("starting", "failed", "stopped"):
            where = f" at {origin}" if origin else ""
            if boot_state == "stopped":
                return "bili: plugin unloaded — model traffic goes direct (uncompressed) in this process."
            if boot_state == "starting":
                started = boot.get("started_at")
                elapsed = max(0.0, time.monotonic() - float(started)) if isinstance(started, (int, float)) else 0.0
                attempt = boot.get("attempt")
                attempt_note = f", attempt {attempt}" if isinstance(attempt, int) and attempt > 1 else ""
                return (f"bili: proxy is starting in the background{where}{attempt_note} "
                        f"({elapsed:.0f}s elapsed, budget {BOOTSTRAP_BUDGET_S:.0f}s per attempt) — "
                        "model traffic is held until it is ready; run /acp again in a moment.")
            detail = str(boot.get("error") or "unknown error")
            if origin and _state.get("env_applied"):
                return (f"bili: proxy at {origin} is up but the native tool manifest is unavailable "
                        f"({detail}) — traffic is compressed in proxy mode until a new session. "
                        "Check the hermes log for the proxy's own output.")
            return (f"bili: proxy failed to start{where} ({detail}) — model traffic is going direct "
                    "(uncompressed). Check the hermes log for the proxy's own output.")
        if not origin:
            return ("bili: no proxy detected — install the plugin (`bili plugin install hermes`) "
                    "and start a new hermes session so /acp can read context status.")
        conversation = session_id.strip() if isinstance(session_id, str) else ""
        if not conversation:
            return "bili: Hermes did not provide the current session ID; update Hermes and restart this session."
        status = _fetch_status(origin, conversation)
        panel = status.get("panel") if isinstance(status, dict) else None
        if isinstance(panel, str) and panel.strip():
            return panel.strip()
        version = _fetch_version(origin)
        if version:
            return (f"billion-context@{version} — proxy connected via {origin}, compression armed. "
                    "No model request yet; send one, then run /acp again.")
        return f"bili: proxy not reachable at {origin} — is the bili proxy still running?"
    except Exception as exc:
        logger.warning("billion-context: /acp failed (%s)", exc)
        return f"bili: /acp failed ({type(exc).__name__}: {exc})"


def acp_cache_command(raw_args: str = "", *, session_id: str = "") -> Optional[str]:
    """`/acp-cache`: prompt-cache reconciliation report — same report as the acp_cache tool
    (#1146), forwarded through the proxy's plugin tool endpoint for the host's session ID.
    Shows the default (summary-ledger) report."""
    try:
        origin = _command_origin()
        if not origin:
            return ("bili: no proxy detected — install the plugin (`bili plugin install hermes`) "
                    "and start a new hermes session so /acp-cache can read the cache report.")
        conversation = session_id.strip() if isinstance(session_id, str) else ""
        if not conversation:
            return "bili: Hermes did not provide the current session ID; update Hermes and restart this session."
        status = _fetch_status(origin, conversation)
        cid = status.get("conversationId") if isinstance(status, dict) else None
        if not isinstance(cid, str) or not cid:
            version = _fetch_version(origin)
            if version:
                return (f"billion-context@{version} — proxy connected via {origin}, compression armed. "
                        "No model request yet; send one, then run /acp-cache again.")
            return f"bili: proxy not reachable at {origin} — is the bili proxy still running?"
        code, payload = http_post_json(
            origin + "/__bili/plugin/tool",
            {"conversationId": cid, "tool": "acp_cache", "args": {}},
            TOOL_TIMEOUT_S,
        )
        if code == 200 and isinstance(payload, dict) and payload.get("ok"):
            result = payload.get("result")
            return result if isinstance(result, str) else json.dumps(result)
        detail = payload.get("error") if isinstance(payload, dict) else None
        msg = str(detail or f"http {code}")
        if "no model request has arrived" in msg:
            return ("bili: no ACP session yet for this conversation "
                    "(send a model request first, then run /acp-cache)")
        return f"bili: cache report failed: {msg}"
    except Exception as exc:
        logger.warning("billion-context: /acp-cache failed (%s)", exc)
        return f"bili: /acp-cache failed ({type(exc).__name__}: {exc})"


# — entry point -----------------------------------------------------------------

def register(ctx: Any) -> None:
    try:
        if gated_off(os.environ):
            return
        if _state.get("loaded"):
            return
        sidecar = load_sidecar()
        if not sidecar:
            logger.warning("billion-context: no usable bili.json sidecar next to the hermes plugin "
                           "(run `bili plugin install hermes`) — staying inert")
            return
        # 1) Everything cheap and blocking-free goes in FIRST. The host caps import+register() at
        #    its load deadline (10s) and ABANDONS the load on timeout — every registration made
        #    after that is ignored, so a slow proxy bootstrap must never sit in this path.
        ctx.register_middleware("llm_request", on_llm_request)
        ctx.register_hook("pre_api_request", on_pre_api_request)
        # In-session slash commands; hosts without PluginContext.register_command
        # (older builds) skip them — tools keep working, only the command entries are absent.
        if hasattr(ctx, "register_command"):
            ctx.register_command(
                "acp", acp_command,
                description="Show bili context-compression status for this session",
            )
            ctx.register_command(
                "acp-cache", acp_cache_command,
                description="Prompt-cache reconciliation (same report as the acp_cache tool)",
            )
        if hasattr(ctx, "on_unload"):
            ctx.on_unload(_shutdown)
        # 2) The slow half — discover/attach/spawn, manifest, tool registration — on its own thread
        #    (see _bootstrap). Warm/attach finishes inside REGISTER_WAIT_S, so a normal start still
        #    registers the native tools before this session's tool snapshot is built (the host calls
        #    discover_plugins() before model_tools.get_tool_definitions()). A cold start lets
        #    register() return instead of being abandoned; the first model request then waits for
        #    readiness (on_llm_request) and compresses in proxy mode until the next session.
        # "loaded" both guards against a double register() and gates the middleware's readiness
        # wait; the failure path below clears it (and releases the event) so a bootstrap that never
        # started can never park the first turn on an event nothing will set.
        with _lifecycle_lock:
            if _stopped():
                # The host can reuse this module after an unload (re-enable without a re-import):
                # a stale stop event would kill the new bootstrap on its first check, so this
                # generation gets fresh events and a clean record.
                _state["stop_event"] = threading.Event()
            # New generation: a previous generation's watchdog (if any) exits on its next tick
            # instead of racing this bootstrap for recovery.
            _state["watchdog_gen"] = int(_state.get("watchdog_gen") or 0) + 1
            _state["ready_event"] = threading.Event()
            _state["bootstrap"] = None
            _state["loaded"] = True
        _start_bootstrap(sidecar, ctx)
        event = _state.get("ready_event")
        if event is not None:
            event.wait(REGISTER_WAIT_S)
        rec: Dict[str, Any] = _state.get("bootstrap") if isinstance(_state.get("bootstrap"), dict) else {}
        if rec.get("state") == "starting":
            logger.info("billion-context: proxy bootstrap still running after %.0fs — returning from "
                        "register() (host load deadline); the first model request waits up to %.0fs",
                        REGISTER_WAIT_S, FIRST_REQUEST_WAIT_S)
    except Exception as exc:
        _state["loaded"] = False
        event = _state.get("ready_event")
        if event is not None:
            event.set()
        logger.warning("billion-context: plugin registration failed (%s) — staying inert", exc)
