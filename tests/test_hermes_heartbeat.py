import importlib.util
import os
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch


def _load_hermes_plugin():
    plugin_path = Path(__file__).resolve().parent.parent / "hermes-plugin" / "__init__.py"
    spec = importlib.util.spec_from_file_location("hermes_plugin_under_test", plugin_path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hermes_plugin_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_register_watcher_sends_hb_true():
    mod = _load_hermes_plugin()
    calls = []

    def fake_post(url, payload, timeout):
        calls.append((url, payload, timeout))
        return 200, {}

    with patch.object(mod, "http_post_json", side_effect=fake_post):
        mod.register_watcher("http://127.0.0.1:19999")

    assert len(calls) == 1
    url, payload, _timeout = calls[0]
    assert url == "http://127.0.0.1:19999/__bili/watcher"
    assert payload == {"pid": os.getpid(), "hb": True}


def test_attach_starts_heartbeat_and_shutdown_stops_it():
    mod = _load_hermes_plugin()
    mod._state["stop_event"] = threading.Event()
    mod._state["watchdog_gen"] = 0
    mod._state["heartbeat_thread"] = None

    calls = []
    beat_event = threading.Event()

    def fake_post(url, payload, timeout):
        calls.append((url, payload))
        if len(calls) >= 2:
            beat_event.set()
        return 200, {}

    try:
        with patch.object(mod, "http_post_json", side_effect=fake_post), \
             patch.object(mod, "OWNER_HEARTBEAT_INTERVAL_S", 0.02):
            mod._attach("http://127.0.0.1:19998")
            hb = mod._state.get("heartbeat_thread")
            assert hb is not None and hb.is_alive()
            assert beat_event.wait(timeout=1.0), "heartbeat loop did not fire"
            mod._shutdown()
            assert not hb.is_alive()
    finally:
        mod._shutdown()

    assert all(url == "http://127.0.0.1:19998/__bili/watcher" for url, _ in calls)
    assert all(payload == {"pid": os.getpid(), "hb": True} for _, payload in calls)


def test_ensure_heartbeat_noop_when_stopped():
    mod = _load_hermes_plugin()
    stop = threading.Event()
    stop.set()
    mod._state["stop_event"] = stop
    mod._state["origin"] = "http://127.0.0.1:19997"
    mod._state["heartbeat_thread"] = None

    mod._ensure_heartbeat()
    assert mod._state.get("heartbeat_thread") is None
