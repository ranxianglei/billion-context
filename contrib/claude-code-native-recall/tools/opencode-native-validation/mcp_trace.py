"""Transparent stdio tee: launches the unmodified delivered MCP executable."""
import datetime, json, os, pathlib, subprocess, sys, threading

target, trace = sys.argv[1:3]
child = subprocess.Popen([sys.executable, target], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={k:v for k,v in os.environ.items() if k != "deponia_key"})
lock = threading.Lock()
def record(direction, raw=None, **extra):
    item = dict(utc=datetime.datetime.now(datetime.timezone.utc).isoformat(), relay_pid=os.getpid(), mcp_pid=child.pid, direction=direction, **extra)
    if raw is not None:
        item['raw'] = raw.decode('utf-8')
    with lock, open(trace, 'a', encoding='utf-8') as f:
        f.write(json.dumps(item, ensure_ascii=False)+'\n')
record('start', target=target)
def forward_input():
    try:
        for raw in sys.stdin.buffer:
            record('request', raw)
            child.stdin.write(raw)
            child.stdin.flush()
    finally:
        child.stdin.close()
threading.Thread(target=forward_input, daemon=True).start()
try:
    for raw in child.stdout:
        record('response', raw)
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
finally:
    child.terminate()
    child.wait(timeout=5)
    record('exit', returncode=child.returncode)
