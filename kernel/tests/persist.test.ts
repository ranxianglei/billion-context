import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore, flatFileNameFor } from "../src/persist/store.js";
import type { StateStoreCodec } from "../src/persist/store.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState } from "../src/types.js";

interface Payload {
  label: string;
  count: number;
}

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "acp-kernel-persist-"));
}

function store(
  dir: string,
  opts: Partial<ConstructorParameters<typeof StateStore<Payload>>[0]> = {},
): StateStore<Payload> {
  return new StateStore<Payload>({ dir, version: 1, ...opts });
}

/**
 * Poll until `cond` holds. Debounce timing is real platform behavior (the
 * timer fires via the event loop), so the tests await the observable signal
 * — the settled disk state — instead of a guessed fixed duration. The sleep
 * step is only the poll cadence, never the assertion.
 */
async function until(
  cond: () => boolean,
  what: string,
  deadlineMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > deadlineMs) {
      assert.fail(`timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("writeNow persists a round-trippable envelope", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    await s.writeNow("sid-1", () => ({ label: "hello", count: 42 }));
    const loaded = s.loadSync("sid-1");
    assert.ok(loaded);
    assert.equal(loaded.id, "sid-1");
    assert.equal(loaded.version, 1);
    assert.equal(typeof loaded.savedAt, "number");
    assert.deepEqual(loaded.payload, { label: "hello", count: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeNow builds the payload at write time, not call time", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    const live = { label: "before", count: 0 };
    const pending = s.writeNow("sid-live", () => live);
    live.label = "after";
    live.count = 7;
    await pending;
    const loaded = s.loadSync("sid-live");
    assert.ok(loaded);
    assert.deepEqual(loaded.payload, { label: "after", count: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSync returns null for unknown ids and when disabled", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    assert.equal(s.loadSync("missing"), null);
    const off = store(dir, { enabled: false });
    await off.writeNow("sid-off", () => ({ label: "x", count: 0 }));
    assert.equal(off.loadSync("sid-off"), null);
    assert.equal((await off.loadAll()).size, 0);
    // disabled flushSync reports success (nothing was at risk)
    assert.equal(
      off.flushSync("sid-off", () => ({ label: "x", count: 0 })),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduleSave coalesces bursts into one freshest write", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { debounceMs: 20 });
    let builds = 0;
    const live = { label: "v1", count: 1 };
    const build = (): Payload => {
      builds += 1;
      return live;
    };
    s.scheduleSave("sid-d", build);
    live.label = "v2";
    live.count = 2;
    s.scheduleSave("sid-d", build);
    assert.equal(s.hasPending("sid-d"), true);
    assert.deepEqual(s.pendingIds(), ["sid-d"]);
    // await the settled disk state: the debounced timer fired, the write
    // landed, and it carries the freshest payload
    await until(
      () => s.loadSync("sid-d")?.payload.label === "v2",
      "debounced write to settle",
    );
    assert.equal(s.hasPending("sid-d"), false);
    // builder ran exactly once — the second scheduleSave only replaced it
    assert.equal(builds, 1);
    assert.deepEqual(s.loadSync("sid-d")?.payload, { label: "v2", count: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduleSave builder failures are contained, not unhandled rejections", async () => {
  const dir = tmpDir();
  try {
    const errors: string[] = [];
    const s = store(dir, {
      debounceMs: 10,
      log: (level, msg) => {
        if (level === "error") errors.push(msg);
      },
    });
    s.scheduleSave("sid-bad", () => {
      throw new Error("boom");
    });
    await until(
      () => !s.hasPending("sid-bad") && errors.length > 0,
      "failed builder to be logged",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /boom/);
    // store still usable afterwards
    await s.writeNow("sid-ok", () => ({ label: "ok", count: 0 }));
    assert.ok(s.loadSync("sid-ok"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync writes immediately and cancels the debounce", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { debounceMs: 30 });
    let builds = 0;
    s.scheduleSave("sid-f", () => {
      builds += 1;
      return { label: "debounced", count: 0 };
    });
    assert.equal(
      s.flushSync("sid-f", () => ({ label: "flushed", count: 3 })),
      true,
    );
    assert.equal(s.hasPending("sid-f"), false);
    const loaded = s.loadSync("sid-f");
    assert.ok(loaded);
    assert.deepEqual(loaded.payload, { label: "flushed", count: 3 });
    // Proving the cancelled timer never fires is a negative over time.
    // Deterministic clock control can't cover it: node:test mock timers
    // don't support the unref() the store's debounce relies on, so this
    // one assertion deliberately outruns the real 30ms window.
    const start = Date.now();
    while (Date.now() - start < 60) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(builds, 0); // timer cancelled before it could fire
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushAll flushes pending builders and drains in-flight writes", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { debounceMs: 5000 });
    s.scheduleSave("sid-a", () => ({ label: "a", count: 0 }));
    s.scheduleSave("sid-b", () => ({ label: "b", count: 0 }));
    assert.equal(s.pendingIds().length, 2);
    await s.flushAll();
    assert.equal(s.pendingIds().length, 0);
    assert.ok(s.loadSync("sid-a"));
    assert.ok(s.loadSync("sid-b"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent writeNow calls on one id serialize and leave a valid file", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    const writes = Array.from({ length: 12 }, (_, i) =>
      s
        .writeNow("sid-race", () => ({ label: `w${i}`, count: i }))
        .then(() => i),
    );
    const settled = await Promise.all(writes);
    assert.deepEqual(settled, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const loaded = s.loadSync("sid-race");
    assert.ok(loaded);
    assert.equal(loaded.payload.count, 11); // last write wins
    // no orphan temp files left behind
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAll skips corrupt files, tmp orphans, and id/filename mismatches", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    await s.writeNow("good-1", () => ({ label: "good", count: 1 }));
    writeFileSync(
      path.join(dir, flatFileNameFor("corrupt-1")),
      "{ not json",
      "utf8",
    );
    writeFileSync(
      path.join(dir, ".tmp-orphan-123"),
      JSON.stringify({ version: 1, savedAt: 0, id: "orph", payload: {} }),
      "utf8",
    );
    // envelope with a valid shape but a filename from a different id
    writeFileSync(
      path.join(dir, flatFileNameFor("other-id")),
      JSON.stringify({
        version: 1,
        savedAt: 0,
        id: "impostor",
        payload: { label: "x", count: 0 },
      }),
      "utf8",
    );
    const all = await s.loadAll();
    assert.deepEqual([...all.keys()], ["good-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAll skips declared foreign co-residents before reading them (#2298)", async () => {
  const dir = tmpDir();
  try {
    const logs: Array<{ level: string; msg: string }> = [];
    const s = store(dir, {
      log: (level, msg) => logs.push({ level, msg }),
      foreignFile: (file) => path.basename(file).endsWith(".content-store.json"),
    });
    await s.writeNow("good-1", () => ({ label: "good", count: 1 }));
    // A co-resident foreign file with a NON-envelope payload (the shape of
    // billion-context's CCR content stores): if the store READ it,
    // readEnvelope would log "skipping invalid record".
    const ns = path.join(dir, "openai");
    mkdirSync(ns, { recursive: true });
    const foreignJson = path.join(ns, "host_abc123.content-store.json");
    writeFileSync(
      foreignJson,
      JSON.stringify({ version: 1, byRef: {}, byHash: {} }),
      "utf8",
    );
    // Undecodable bytes under the same suffix: a read attempt would surface
    // as a "corrupt" warn too — total silence proves the file was never
    // opened at all.
    const foreignBin = path.join(ns, "host_deadbeef.content-store.json");
    writeFileSync(foreignBin, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const all = await s.loadAll();
    assert.deepEqual([...all.keys()], ["good-1"]);
    assert.equal(
      logs.filter((l) => l.msg.includes("content-store")).length,
      0,
      "foreign co-residents produce no log line (not even corrupt-warns)",
    );
    // The skip is read-only: the files stay on disk untouched.
    assert.ok(existsSync(foreignJson));
    assert.ok(existsSync(foreignBin));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without the foreignFile predicate, co-resident foreign files are still probed (default unchanged)", async () => {
  const dir = tmpDir();
  try {
    const logs: string[] = [];
    const s = store(dir, {
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    writeFileSync(
      path.join(dir, "host_abc123.content-store.json"),
      JSON.stringify({ version: 1, byRef: {}, byHash: {} }),
      "utf8",
    );
    const all = await s.loadAll();
    assert.equal(all.size, 0);
    assert.ok(
      logs.some((l) => l.includes("skipping invalid record")),
      "the default probe-and-warn behavior stays intact when no predicate is set",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAll rejects records failing the downstream validate hook", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      validate: (env) =>
        typeof env.payload.count === "number" && env.payload.count > 0,
    });
    await s.writeNow("pos", () => ({ label: "p", count: 5 }));
    await s.writeNow("zero", () => ({ label: "z", count: 0 }));
    const all = await s.loadAll();
    assert.deepEqual([...all.keys()], ["pos"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom relPath namespaces into subdirectories and loadAll discovers them", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      relPath: (id, payload) => path.join(payload.label, `${id}.json`),
    });
    await s.writeNow("ns-1", () => ({ label: "openai", count: 1 }));
    // namespaced layout on disk
    const nested = readdirSync(dir).filter((f) => f === "openai");
    assert.equal(nested.length, 1);
    // same process: the write populated the discovery map
    assert.ok(s.loadSync("ns-1"));
    // a fresh store (next process) cannot know the namespaced path
    // before discovery — loadSync probes only the flat default name
    const next = store(dir, {
      relPath: (id, payload) => path.join(payload.label, `${id}.json`),
    });
    assert.equal(next.loadSync("ns-1"), null);
    // …but loadAll discovers it and subsequent loadSync resolves it
    const all = await next.loadAll();
    assert.deepEqual([...all.keys()], ["ns-1"]);
    assert.ok(next.loadSync("ns-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flat legacy name is tolerated in loadAll alongside namespaced relPath", async () => {
  const dir = tmpDir();
  try {
    // a record written flat by an older version of the downstream
    writeFileSync(
      path.join(dir, flatFileNameFor("legacy-1")),
      JSON.stringify({
        version: 1,
        savedAt: 0,
        id: "legacy-1",
        payload: { label: "old", count: 9 },
      }),
      "utf8",
    );
    const s = store(dir, {
      relPath: (id, payload) => path.join(payload.label, `${id}.json`),
    });
    const all = await s.loadAll();
    assert.deepEqual([...all.keys()], ["legacy-1"]);
    assert.deepEqual(all.get("legacy-1")?.payload, { label: "old", count: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relPath escaping the dir is rejected to the safe flat name", async () => {
  const dir = tmpDir();
  try {
    const warned: string[] = [];
    const s = store(dir, {
      log: (level, msg) => {
        if (level === "warn") warned.push(msg);
      },
      relPath: () => "../../escape.json",
    });
    await s.writeNow("esc-1", () => ({ label: "x", count: 0 }));
    // landed flat inside dir, not outside
    assert.ok(s.loadSync("esc-1"));
    const outsideExists = readdirSync(path.dirname(dir)).includes(
      flatFileNameFor("esc-1"),
    );
    assert.equal(outsideExists, false);
    assert.ok(warned.some((w) => w.includes("escapes dir")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAll walks nested namespaces recursively", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`),
    });
    await s.writeNow("deep-1", () => ({ label: "hostA", count: 1 }));
    await s.writeNow("deep-2", () => ({ label: "hostB", count: 2 }));
    mkdirSync(path.join(dir, "proto", "hostC"), { recursive: true });
    writeFileSync(
      path.join(dir, "proto", "hostC", "deep-3.json"),
      JSON.stringify({
        version: 1,
        savedAt: 0,
        id: "deep-3",
        payload: { label: "hostC", count: 3 },
      }),
      "utf8",
    );
    const all = await s.loadAll();
    assert.deepEqual([...all.keys()].sort(), ["deep-1", "deep-2", "deep-3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelAll drops pending writes without flushing", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { debounceMs: 5000 });
    s.scheduleSave("sid-c", () => ({ label: "gone", count: 0 }));
    s.cancelAll();
    assert.equal(s.hasPending("sid-c"), false);
    // deterministic: the debounce timer was the only write path, and it
    // was cleared before firing — no file exists
    assert.equal(s.loadSync("sid-c"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store on a missing dir loads empty and creates the dir on first write", async () => {
  const dir = path.join(tmpDir(), "not-created-yet");
  try {
    const s = store(dir);
    assert.equal((await s.loadAll()).size, 0);
    await s.writeNow("sid-m", () => ({ label: "m", count: 0 }));
    assert.ok(s.loadSync("sid-m"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeCompressionState fills missing fields from a fresh state", () => {
  const fresh = createInitialState();
  const partial = { blocks: [] } as CompressionState;
  const merged = mergeCompressionState(partial);
  assert.deepEqual(merged.messageRefs, fresh.messageRefs);
  assert.deepEqual(merged.nudge, fresh.nudge);
  assert.deepEqual(merged.stats, fresh.stats);
  assert.equal(merged.nextBlockId, fresh.nextBlockId);
  assert.equal(merged.nextRunId, fresh.nextRunId);
  assert.deepEqual(merged.tokenSnapshot, fresh.tokenSnapshot);
});

test("mergeCompressionState keeps parsed values over defaults", () => {
  const parsed: CompressionState = {
    ...createInitialState(),
    nextBlockId: 41,
    stats: { tokensCompressed: 1234, compressionCount: 7 },
  };
  const merged = mergeCompressionState(parsed);
  assert.equal(merged.nextBlockId, 41);
  assert.deepEqual(merged.stats, {
    tokensCompressed: 1234,
    compressionCount: 7,
    absorbedTokens: 0,
    storedCount: 0,
    retrievalCount: 0,
  });
});

test("legacy hook adopts pre-envelope records on loadAll and loadSync", async () => {
  const dir = tmpDir();
  try {
    // A proxy-style flat record: no `payload` wrapper, id at top level.
    const flat = {
      version: 3,
      savedAt: 12345,
      id: "flat-1",
      label: "adopted",
      count: 9,
    };
    const flatFile = path.join(dir, flatFileNameFor("flat-1"));
    writeFileSync(flatFile, JSON.stringify(flat), "utf8");
    const s = store(dir, {
      legacy: (parsed) => {
        const p = parsed as { id?: unknown; label?: unknown; count?: unknown };
        if (
          typeof p.id !== "string" ||
          typeof p.label !== "string" ||
          typeof p.count !== "number"
        )
          return null;
        return { id: p.id, payload: { label: p.label, count: p.count } };
      },
    });
    const all = await s.loadAll();
    assert.equal(all.size, 1);
    const env = all.get("flat-1");
    assert.ok(env);
    assert.equal(env.id, "flat-1");
    assert.deepEqual(env.payload, { label: "adopted", count: 9 });
    // The source record's own stamps are preserved, not stamped fresh.
    assert.equal(env.version, 3);
    assert.equal(env.savedAt, 12345);
    // loadSync finds it too (discovered by loadAll).
    const direct = s.loadSync("flat-1");
    assert.ok(direct);
    assert.deepEqual(direct.payload, { label: "adopted", count: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy adoption is skipped when the hook returns null", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      path.join(dir, flatFileNameFor("foreign-1")),
      JSON.stringify({ totally: "unrelated", shape: true }),
      "utf8",
    );
    const s = store(dir, { legacy: () => null });
    assert.equal((await s.loadAll()).size, 0);
    assert.equal(s.loadSync("foreign-1"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adopted legacy record re-persists as an envelope on the next write", async () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      path.join(dir, flatFileNameFor("migrate-1")),
      JSON.stringify({
        version: 3,
        savedAt: 1,
        id: "migrate-1",
        label: "old",
        count: 0,
      }),
      "utf8",
    );
    const s = store(dir, {
      version: 4,
      legacy: (parsed) => {
        const p = parsed as { id?: string; label?: string; count?: number };
        if (
          typeof p.id !== "string" ||
          typeof p.label !== "string" ||
          typeof p.count !== "number"
        )
          return null;
        return { id: p.id, payload: { label: p.label, count: p.count } };
      },
    });
    await s.loadAll();
    // Dirty write after adoption: the file on disk becomes an envelope
    // stamped with the store's current version.
    await s.writeNow("migrate-1", () => ({ label: "new", count: 5 }));
    const raw = JSON.parse(
      readFileSync(path.join(dir, flatFileNameFor("migrate-1")), "utf8"),
    ) as {
      version: number;
      payload: { label: string };
    };
    assert.equal(raw.version, 4);
    assert.deepEqual(raw.payload, { label: "new", count: 5 });
    // And a FRESH store (no legacy hook) can read it — migration done.
    const plain = store(dir);
    assert.deepEqual(plain.loadSync("migrate-1")?.payload, {
      label: "new",
      count: 5,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSync hint probes a namespaced path without loadAll", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`),
    });
    await s.writeNow("hint-1", () => ({ label: "hostA", count: 1 }));
    // A second store instance has NOT discovered the namespaced file —
    // without the hint, loadSync misses (flat fallback only).
    const s2 = store(dir, {
      relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`),
    });
    assert.equal(s2.loadSync("hint-1"), null);
    // With the relative-path hint, the namespaced file resolves.
    const hit = s2.loadSync(
      "hint-1",
      path.join("proto", "hostA", "hint-1.json"),
    );
    assert.ok(hit);
    assert.deepEqual(hit.payload, { label: "hostA", count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function spillNameFor(id: string): string {
  return flatFileNameFor(id).replace(/\.json$/, ".fb.json");
}

function eperm(): NodeJS.ErrnoException {
  const e = new Error(
    "EPERM: operation not permitted, rename",
  ) as NodeJS.ErrnoException;
  e.code = "EPERM";
  return e;
}

test("rename failure spills to a side file instead of dropping data", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    let threw = false;
    try {
      await s.writeNow("sid-spill", () => ({ label: "kept", count: 1 }));
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const spillFile = path.join(dir, spillNameFor("sid-spill"));
    assert.ok(existsSync(spillFile), "spill file exists");
    const env = JSON.parse(readFileSync(spillFile, "utf8")) as {
      id: string;
      payload: Payload;
    };
    assert.equal(env.id, "sid-spill");
    assert.deepEqual(env.payload, { label: "kept", count: 1 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAll discovers a spilled record and reconciles against the canonical by savedAt", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    await s.writeNow("sid-r", () => ({ label: "old", count: 1 }));
    await new Promise((r) => setTimeout(r, 5));
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    await s
      .writeNow("sid-r", () => ({ label: "new", count: 2 }))
      .catch(() => {});
    t.mock.restoreAll();
    const next = store(dir);
    const all = await next.loadAll();
    assert.deepEqual(all.get("sid-r")?.payload, { label: "new", count: 2 });
    assert.deepEqual(next.loadSync("sid-r")?.payload, {
      label: "new",
      count: 2,
    });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a canonical newer than the spill wins on load, and the stale spill is cleaned on success", async () => {
  const dir = tmpDir();
  try {
    const spillFile = path.join(dir, spillNameFor("sid-c"));
    writeFileSync(
      spillFile,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        id: "sid-c",
        payload: { label: "stale", count: 0 },
      }),
      "utf8",
    );
    const s = store(dir);
    await s.writeNow("sid-c", () => ({ label: "fresh", count: 5 }));
    assert.equal(
      existsSync(spillFile),
      false,
      "stale spill removed after canonical success",
    );
    assert.deepEqual(s.loadSync("sid-c")?.payload, {
      label: "fresh",
      count: 5,
    });
    const next = store(dir);
    assert.deepEqual((await next.loadAll()).get("sid-c")?.payload, {
      label: "fresh",
      count: 5,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write failures alert on the first and power-of-two counts, not every write", async (t) => {
  const dir = tmpDir();
  try {
    const logs: { level: string; msg: string }[] = [];
    const s = store(dir, {
      retryAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 2,
      log: (level, msg) => logs.push({ level, msg }),
    });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    for (let i = 0; i < 5; i++) {
      await s
        .writeNow("sid-f", () => ({ label: "x", count: i }))
        .catch(() => {});
    }
    t.mock.restoreAll();
    const failLogs = logs.filter((l) =>
      l.msg.includes("write failed for sid-f"),
    );
    assert.equal(failLogs.length, 3);
    assert.equal(failLogs[0].level, "error");
    assert.ok(failLogs[0].msg.includes("total 1x"));
    assert.ok(failLogs[0].msg.includes("data spilled to"));
    assert.equal(failLogs[1].level, "warn");
    assert.ok(failLogs[1].msg.includes("total 2x"));
    assert.equal(failLogs[2].level, "warn");
    assert.ok(failLogs[2].msg.includes("total 4x"));
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync spills to a side file when the rename keeps failing", (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    const ok = s.flushSync("sid-fs", () => ({ label: "sync", count: 9 }));
    assert.equal(ok, true);
    const spillFile = path.join(dir, spillNameFor("sid-fs"));
    assert.ok(existsSync(spillFile), "spill file exists");
    const env = JSON.parse(readFileSync(spillFile, "utf8")) as {
      id: string;
      payload: Payload;
    };
    assert.equal(env.id, "sid-fs");
    assert.deepEqual(env.payload, { label: "sync", count: 9 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful write clears the failure counter so alerting restarts", async (t) => {
  const dir = tmpDir();
  try {
    const logs: { level: string; msg: string }[] = [];
    const s = store(dir, {
      retryAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 2,
      log: (level, msg) => logs.push({ level, msg }),
    });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    await s
      .writeNow("sid-reset", () => ({ label: "a", count: 0 }))
      .catch(() => {});
    t.mock.restoreAll();
    await s.writeNow("sid-reset", () => ({ label: "b", count: 1 }));
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    await s
      .writeNow("sid-reset", () => ({ label: "c", count: 2 }))
      .catch(() => {});
    t.mock.restoreAll();
    const failLogs = logs.filter((l) =>
      l.msg.includes("write failed for sid-reset"),
    );
    assert.equal(failLogs.length, 2);
    assert.ok(failLogs[0].msg.includes("total 1x"));
    assert.ok(failLogs[1].msg.includes("total 1x"));
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync retries use a fresh temp name per attempt (no tombstoned reuse)", (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 });
    const written: string[] = [];
    // The durable write (#3157) opens each target with "w" exactly once, so
    // count those opens (forwarding to the real open) instead of the old
    // writeFileSync call.
    const realOpen = fs.openSync.bind(fs);
    t.mock.method(
      fs,
      "openSync",
      ((p: string, flags?: string | number, mode?: number) => {
        if (flags === "w") written.push(p);
        return realOpen(p, flags, mode);
      }) as typeof fs.openSync,
    );
    t.mock.method(fs, "renameSync", (() => {
      throw eperm();
    }) as typeof fs.renameSync);
    const ok = s.flushSync("sid-tmp", () => ({ label: "x", count: 1 }));
    // The write spilled, so the caller still sees success.
    assert.equal(ok, true);
    const tmps = written.filter((p) => path.basename(p).startsWith(".tmp-"));
    assert.equal(tmps.length, 3, "one temp write per attempt");
    assert.equal(
      new Set(tmps).size,
      3,
      "each attempt used a distinct temp name",
    );
    assert.ok(
      written.some((p) => p.endsWith(".fb.json")),
      "spill file written",
    );
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

function enoent(): NodeJS.ErrnoException {
  const e = new Error(
    "ENOENT: no such file or directory, rename",
  ) as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

test("a temp file vanishing before rename (ENOENT) is healed by whole-cycle retry", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 });
    const realRenameSync = fs.renameSync.bind(fs);
    let calls = 0;
    t.mock.method(fs, "renameSync", ((src: string, dest: string) => {
      calls++;
      if (calls === 1) throw enoent();
      realRenameSync(src, dest);
    }) as typeof fs.renameSync);
    await s.writeNow("sid-sweep", () => ({ label: "healed", count: 3 }));
    const canonical = path.join(dir, flatFileNameFor("sid-sweep"));
    const env = JSON.parse(readFileSync(canonical, "utf8")) as {
      id: string;
      payload: Payload;
    };
    assert.equal(env.id, "sid-sweep");
    assert.deepEqual(env.payload, { label: "healed", count: 3 });
    assert.equal(
      existsSync(path.join(dir, spillNameFor("sid-sweep"))),
      false,
      "no spill — canonical healed",
    );
    assert.ok(calls >= 2, "rename was retried");
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the target directory vanishing (writeFile ENOENT) is recreated on retry", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 });
    const realWriteFile = fsp.writeFile.bind(fsp);
    let calls = 0;
    t.mock.method(fsp, "writeFile", (async (p: string, data: string) => {
      calls++;
      if (calls === 1) throw enoent();
      await realWriteFile(p, data);
    }) as typeof fsp.writeFile);
    await s.writeNow("sid-gone-dir", () => ({ label: "recreated", count: 7 }));
    const canonical = path.join(dir, flatFileNameFor("sid-gone-dir"));
    const env = JSON.parse(readFileSync(canonical, "utf8")) as {
      payload: Payload;
    };
    assert.deepEqual(env.payload, { label: "recreated", count: 7 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent ENOENT still spills so data is never dropped", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 2, retryBaseMs: 1, retryMaxMs: 2 });
    t.mock.method(fs, "renameSync", (() => {
      throw enoent();
    }) as typeof fsp.rename);
    let threw = false;
    try {
      await s.writeNow("sid-enoent", () => ({ label: "kept", count: 1 }));
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const spillFile = path.join(dir, spillNameFor("sid-enoent"));
    const env = JSON.parse(readFileSync(spillFile, "utf8")) as {
      id: string;
      payload: Payload;
    };
    assert.equal(env.id, "sid-enoent");
    assert.deepEqual(env.payload, { label: "kept", count: 1 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync heals an ENOENT sweep the same way", (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, { retryAttempts: 3, retryBaseMs: 1, retryMaxMs: 1 });
    const realRenameSync = fs.renameSync.bind(fs);
    let calls = 0;
    t.mock.method(fs, "renameSync", ((src: string, dest: string) => {
      calls++;
      if (calls === 1) throw enoent();
      return realRenameSync(src, dest);
    }) as typeof fs.renameSync);
    const ok = s.flushSync("sid-fs-sweep", () => ({ label: "sync", count: 4 }));
    assert.equal(ok, true);
    const canonical = path.join(dir, flatFileNameFor("sid-fs-sweep"));
    const env = JSON.parse(readFileSync(canonical, "utf8")) as {
      payload: Payload;
    };
    assert.deepEqual(env.payload, { label: "sync", count: 4 });
    assert.ok(calls >= 2, "renameSync was retried");
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

function xorCodec(): StateStoreCodec {
  const x = (buf: Buffer): Buffer => {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x5a;
    return out;
  };
  return {
    encode: (data) => x(Buffer.from(data, "utf8")),
    decode: (buf) => x(buf).toString("utf8"),
  };
}

const ENC_MAGIC = Buffer.from("ENC1", "utf8");

function magicCodec(): StateStoreCodec {
  const inner = xorCodec();
  return {
    encode: (data) => Buffer.concat([ENC_MAGIC, inner.encode(data)]),
    decode: (buf) =>
      buf.subarray(0, 4).equals(ENC_MAGIC)
        ? inner.decode(buf.subarray(4))
        : buf.toString("utf8"),
  };
}

test("codec round-trips records and keeps files opaque on disk", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { codec: xorCodec() });
    await s.writeNow("sid-enc", () => ({ label: "secret", count: 7 }));
    const raw = readFileSync(path.join(dir, flatFileNameFor("sid-enc")));
    assert.ok(
      !raw.includes(Buffer.from('"label"')),
      "on-disk bytes are not plaintext JSON",
    );
    const hit = s.loadSync("sid-enc");
    assert.ok(hit);
    assert.deepEqual(hit.payload, { label: "secret", count: 7 });
    const all = await s.loadAll();
    assert.deepEqual(all.get("sid-enc")?.payload, {
      label: "secret",
      count: 7,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codec applies to debounced scheduleSave writes", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir, { codec: xorCodec(), debounceMs: 10 });
    s.scheduleSave("sid-deb", () => ({ label: "deb", count: 3 }));
    await s.flushAll();
    const all = await s.loadAll();
    assert.deepEqual(all.get("sid-deb")?.payload, { label: "deb", count: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codec applies to spill writes as well", async (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      codec: xorCodec(),
      retryAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 2,
    });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    let threw = false;
    try {
      await s.writeNow("sid-espill", () => ({ label: "kept", count: 1 }));
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    const raw = readFileSync(path.join(dir, spillNameFor("sid-espill")));
    assert.ok(!raw.includes(Buffer.from('"label"')), "spill is encoded");
    const env = JSON.parse(xorCodec().decode(raw)) as {
      id: string;
      payload: Payload;
    };
    assert.equal(env.id, "sid-espill");
    assert.deepEqual(env.payload, { label: "kept", count: 1 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flushSync spill is encoded too", (t) => {
  const dir = tmpDir();
  try {
    const s = store(dir, {
      codec: xorCodec(),
      retryAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 2,
    });
    t.mock.method(fs, "renameSync", () => {
      throw eperm();
    });
    const ok = s.flushSync("sid-fsenc", () => ({ label: "sync", count: 9 }));
    assert.equal(ok, true);
    const raw = readFileSync(path.join(dir, spillNameFor("sid-fsenc")));
    assert.ok(!raw.includes(Buffer.from('"label"')), "spill is encoded");
    const env = JSON.parse(xorCodec().decode(raw)) as { payload: Payload };
    assert.deepEqual(env.payload, { label: "sync", count: 9 });
  } finally {
    t.mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codec decode failure is treated as a corrupt file, not fatal", async () => {
  const dir = tmpDir();
  try {
    const plain = store(dir);
    await plain.writeNow("sid-corrupt", () => ({ label: "x", count: 1 }));
    const logs: Array<{ level: string; msg: string }> = [];
    const strict = store(dir, {
      codec: {
        encode: (d) => d,
        decode: () => {
          throw new Error("auth failed");
        },
      },
      log: (level, msg) => logs.push({ level, msg }),
    });
    assert.equal(strict.loadSync("sid-corrupt"), null);
    const all = await strict.loadAll();
    assert.equal(all.size, 0);
    assert.ok(
      logs.some((l) => l.level === "warn" && l.msg.includes("corrupt")),
      "logged as corrupt",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mixed tree: unencoded legacy files and encoded files both load", async () => {
  const dir = tmpDir();
  try {
    const plain = store(dir);
    await plain.writeNow("sid-old", () => ({ label: "legacy", count: 1 }));
    const enc = store(dir, { codec: magicCodec() });
    await enc.writeNow("sid-new", () => ({ label: "encoded", count: 2 }));
    const fresh = store(dir, { codec: magicCodec() });
    const all = await fresh.loadAll();
    assert.deepEqual(all.get("sid-old")?.payload, {
      label: "legacy",
      count: 1,
    });
    assert.deepEqual(all.get("sid-new")?.payload, {
      label: "encoded",
      count: 2,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#373: a flushSync landing while an async write is mid-flight cannot be clobbered by the stale rename", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    // Reentrant interleave: while writeInner is between its build() and
    // its commit, a flushSync commits a NEWER payload. Deterministic —
    // the reentrant call runs inside build() itself.
    const inFlight = s.writeNow("sid-fence", () => {
      const snap: Payload = { label: "stale", count: 1 };
      const ok = s.flushSync("sid-fence", () => ({ label: "fresh", count: 2 }));
      assert.equal(ok, true, "reentrant flushSync must succeed");
      return snap;
    });
    await inFlight;
    const loaded = s.loadSync("sid-fence");
    assert.ok(loaded, "record must exist");
    assert.deepEqual(
      loaded.payload,
      { label: "fresh", count: 2 },
      "disk must hold the flushSync payload, not the stale in-flight snapshot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#373: fenced async writes that lose the race settle quietly and never throw into the chain", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    let observed: Payload | null = null;
    const p1 = s.writeNow("sid-chain", () => {
      const snap: Payload = { label: "older", count: 1 };
      s.flushSync("sid-chain", () => ({ label: "newer", count: 5 }));
      return snap;
    });
    await p1;
    // A queued write built AFTER the flushSync commits is NOT fenced —
    // it snapshots later state and must land.
    await s.writeNow("sid-chain", () => {
      observed = { label: "latest", count: 9 };
      return observed;
    });
    const loaded = s.loadSync("sid-chain");
    assert.ok(loaded);
    assert.deepEqual(loaded.payload, { label: "latest", count: 9 });
    // The fenced older write left no tmp orphans behind.
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#373: flushSync after a fully settled async write simply supersedes it", async () => {
  const dir = tmpDir();
  try {
    const s = store(dir);
    await s.writeNow("sid-order", () => ({ label: "async-first", count: 1 }));
    const ok = s.flushSync("sid-order", () => ({
      label: "sync-second",
      count: 2,
    }));
    assert.equal(ok, true);
    const loaded = s.loadSync("sid-order");
    assert.ok(loaded);
    assert.deepEqual(loaded.payload, { label: "sync-second", count: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3157: every commit fsyncs the temp before rename (durable data, not just an atomic name)", async (t) => {
  const dir = tmpDir();
  try {
    let fsyncs = 0;
    t.mock.method(fs, "fsyncSync", () => {
      fsyncs++;
    });
    const s = store(dir);
    // Sync commit path (flushSync).
    const okSync = s.flushSync("sid-sync", () => ({ label: "sync", count: 1 }));
    assert.equal(okSync, true);
    assert.ok(fsyncs >= 1, `flushSync must fsync the temp before rename, saw ${fsyncs}`);
    const afterSync = fsyncs;
    // Async commit path (writeNow -> writeInner).
    await s.writeNow("sid-async", () => ({ label: "async", count: 2 }));
    assert.ok(fsyncs > afterSync, `writeInner must fsync the temp before rename, saw ${fsyncs}`);
    // The durable writes still round-trip their payload.
    assert.deepEqual(s.loadSync("sid-sync")!.payload, { label: "sync", count: 1 });
    assert.deepEqual(s.loadSync("sid-async")!.payload, { label: "async", count: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
