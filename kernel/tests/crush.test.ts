import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { ABSORB_PROMPT_MARKER, DEFAULT_ABSORB_CONFIG } from "../src/absorb.js";
import { makeIO, runPipeline } from "../src/pipeline.js";
import type { CoreMessage, CrushConfig } from "../src/types.js";
import {
  DEFAULT_CRUSH_CONFIG,
  classifyCrushText,
  crushJson,
  crushText,
  evaluateToolResult,
  resolveCrushConfig,
  registerCrushPlugin,
  unregisterCrushPlugin,
  listCrushPlugins,
  resetCrushPlugins,
  jsonFoldPlugin,
  codeTrimPlugin,
  logSelectPlugin,
} from "../src/crush.js";

const tok = (t: string): number => Math.ceil(t.length / 4);

interface RowEnv {
  __acp_crush: "rows";
  rows: number;
  const: Record<string, unknown>;
  items?: Record<string, unknown>[];
}

type AnyEnv =
  | RowEnv
  | { __acp_crush: "identical-run"; count: number; item: unknown }
  | unknown[]
  | Record<string, unknown>;

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    const outArr: unknown[] = [];
    for (const e of v) {
      if (
        e !== null &&
        typeof e === "object" &&
        (e as Record<string, unknown>).__acp_crush === "identical-run"
      ) {
        const m = e as { count: number; item: unknown };
        for (let i = 0; i < m.count; i++) outArr.push(decodeValue(m.item));
      } else outArr.push(decodeValue(e));
    }
    return outArr;
  }
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.__acp_crush === "identical-run") {
      const m = o as { count: number; item: unknown };
      return Array.from({ length: m.count }, () => decodeValue(m.item));
    }
    if (o.__acp_crush === "rows") {
      const r = o as RowEnv;
      const items = r.items ?? [];
      return Array.from({ length: r.rows }, (_, i) => ({
        ...(r.const as Record<string, unknown>),
        ...(items[i] as Record<string, unknown>),
      }));
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = decodeValue(val);
    return out;
  }
  return v;
}

test("json-fold: constant-field hoist is lossless (rows envelope)", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  const out = jsonFoldPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(out!.length < src.length);
  const env = JSON.parse(out!) as RowEnv;
  assert.equal(env.__acp_crush, "rows");
  assert.equal(env.rows, 8);
  assert.equal(env.const.ts, "2026-09-21T12:00:00Z");
  assert.equal(env.const.level, "INFO");
  assert.equal(
    (env.const as Record<string, unknown>).id,
    undefined,
    "varying field must not be hoisted",
  );
  assert.deepEqual(
    decodeValue(JSON.parse(out!)),
    rows,
    "decode must reconstruct the original array",
  );
});

test("json-fold: identical-run fold is lossless", () => {
  const arr = [
    ...Array(5).fill({ e: "boom", code: 500 }),
    { e: "ok", code: 200 },
    { e: "ok", code: 200 },
    { e: "warn", code: 300 },
    { e: "warn", code: 300 },
  ];
  const src = JSON.stringify(arr);
  const out = jsonFoldPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(out!.length < src.length);
  assert.deepEqual(
    decodeValue(JSON.parse(out!)),
    arr,
    "run expansion must reconstruct the original array",
  );
});

test("json-fold: fully identical array collapses and decodes back", () => {
  const arr = Array.from({ length: 6 }, () => ({
    status: "healthy",
    region: "us-east-1",
  }));
  const src = JSON.stringify(arr);
  const out = jsonFoldPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(out!.length < src.length / 2);
  assert.deepEqual(decodeValue(JSON.parse(out!)), arr);
});

test("json-fold: deterministic (byte-identical across calls)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    host: `h${i}`,
    zone: "z1",
  }));
  const src = JSON.stringify(rows);
  assert.equal(
    jsonFoldPlugin.run(src, {})?.text,
    jsonFoldPlugin.run(src, {})?.text,
  );
});

test("json-fold: nested envelopes recurse and stay lossless", () => {
  const doc = {
    meta: "x",
    logs: Array.from({ length: 6 }, (_, i) => ({
      seq: i,
      src: "api",
      msg: `m${i}`,
    })),
  };
  const src = JSON.stringify(doc);
  const out = jsonFoldPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  const parsed = JSON.parse(out!) as { logs: AnyEnv };
  assert.equal((parsed.logs as RowEnv).__acp_crush, "rows");
  assert.deepEqual(decodeValue(parsed), doc);
});

test("json-fold: no redundancy -> null (never reformats)", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    a: `a${i}`,
    b: `b${i}`,
    c: i % 3,
  }));
  assert.equal(jsonFoldPlugin.run(JSON.stringify(rows), {}), null);
  assert.equal(jsonFoldPlugin.run('{"a":1,"b":[1,2,3]}', {}), null);
});

test("crushText: malformed JSON falls through, prose passes through untouched", () => {
  assert.equal(
    crushText("[1,2,", { countTokens: tok }),
    null,
    "malformed JSON must fail open",
  );
  assert.equal(
    crushText("The quick brown fox jumps over the lazy dog. ".repeat(20), {
      countTokens: tok,
    }),
    null,
    "prose is not a crush target",
  );
  assert.equal(crushText("", { countTokens: tok }), null);
});

test("crushText: minReduction gate rejects marginal savings", () => {
  const arr = Array.from({ length: 4 }, () => "x".repeat(100));
  const src = JSON.stringify(arr);
  assert.ok(
    crushText(src, { minReduction: 0.5, countTokens: tok }),
    "~66% reduction passes a 0.5 gate",
  );
  assert.equal(
    crushText(src, { minReduction: 0.9, countTokens: tok }),
    null,
    "same payload rejected at a 0.9 gate",
  );
});

test("crushText: dispatches json-first, then code", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  assert.equal(
    crushText(JSON.stringify(rows), { countTokens: tok })?.strategy,
    "json-fold",
  );
  const py = [
    "import os",
    "",
    "def f():",
    "    # c1",
    "    # c2",
    "    # c3",
    "    # c4",
    "    return os.getcwd()",
  ].join("\n");
  assert.equal(crushText(py, { countTokens: tok })?.strategy, "code-trim");
});

test("classifyCrushText: json / code / log buckets", () => {
  assert.equal(classifyCrushText(JSON.stringify([{ a: 1 }])), "json");
  assert.equal(
    classifyCrushText(["import os", "", "def f():", "    pass"].join("\n")),
    "code",
  );
  assert.equal(
    classifyCrushText(
      Array.from({ length: 60 }, (_, i) => `INFO tick ${i}`).join("\n"),
    ),
    "log",
  );
  assert.equal(
    classifyCrushText("plain english paragraph without structure"),
    "log",
  );
});

test("config: defaultConfig ships crush disabled with default minReduction", () => {
  const cfg = defaultConfig(200000);
  assert.deepEqual(cfg.crush, { enabled: false, minReduction: 0.1 });
  const merged = defaultConfig(200000, { crush: { enabled: true } });
  assert.deepEqual(merged.crush, { enabled: true, minReduction: 0.1 });
  const full = defaultConfig(200000, {
    crush: {
      enabled: true,
      minReduction: 0.4,
      strategies: { "json-fold": { enabled: false } },
    },
  });
  assert.deepEqual(full.crush, {
    enabled: true,
    minReduction: 0.4,
    strategies: { "json-fold": { enabled: false } },
  });
});

test("validateConfig: crush block validation", () => {
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, { crush: { enabled: true, minReduction: 0.5 } }),
    ),
    [],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, { crush: { enabled: true, minReduction: 0 } }),
    ),
    ["crush.minReduction must be in (0, 1]"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, { crush: { enabled: true, minReduction: 1.5 } }),
    ),
    ["crush.minReduction must be in (0, 1]"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, {
        crush: { enabled: true, minReduction: Number.NaN },
      }),
    ),
    ["crush.minReduction must be in (0, 1]"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, {
        crush: { enabled: true, strategies: { x: "no" } },
      }),
    ),
    ["crush.strategies.x must be an object"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, {
        crush: { enabled: true, strategies: { x: { enabled: "yes" } } },
      }),
    ),
    ["crush.strategies.x.enabled must be a boolean"],
  );
  assert.deepEqual(
    validateConfig(
      defaultConfig(200000, {
        crush: { enabled: true, strategies: { x: { excludeTools: 5 } } },
      }),
    ),
    ["crush.strategies.x.excludeTools must be a string array"],
  );
});

test("resolveCrushConfig: fills defaults over partial blocks", () => {
  assert.deepEqual(
    resolveCrushConfig(defaultConfig(200000)),
    DEFAULT_CRUSH_CONFIG,
  );
  assert.deepEqual(
    resolveCrushConfig(defaultConfig(200000, { crush: { enabled: true } })),
    { enabled: true, minReduction: 0.1 },
  );
  assert.deepEqual(
    resolveCrushConfig(
      defaultConfig(200000, { crush: { enabled: true, minReduction: 0.7 } }),
    ),
    {
      enabled: true,
      minReduction: 0.7,
    },
  );
});

const PY_DOCSTRING = [
  "#!/usr/bin/env python3",
  "# module-level comment",
  "",
  "",
  "def fetch(url):",
  '    """Fetch the url.',
  "",
  "        Multi-line body.",
  '    """',
  "    import urllib.request",
  "    return urllib.request.urlopen(url).read()",
].join("\n");

test("code-trim: python docstrings/comments elided, code lines kept verbatim", () => {
  const out = codeTrimPlugin.run(PY_DOCSTRING, {})?.text;
  assert.ok(out, "must crush");
  const lines = out!.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env python3", "shebang kept");
  assert.ok(lines.includes("def fetch(url):"), "signature kept");
  assert.ok(lines.includes("    import urllib.request"), "body kept");
  assert.ok(
    lines.includes("    return urllib.request.urlopen(url).read()"),
    "body kept",
  );
  assert.ok(!out!.includes("Multi-line body"), "docstring body elided");
  assert.ok(!out!.includes("module-level comment"), "comment elided");
  assert.match(out!, /\[acp-crush: elided \d+ lines?\]/);
});

test("code-trim: assigned triple-quoted string is NOT a docstring and is kept", () => {
  const src = [
    "import os",
    "# comment one",
    "# comment two",
    "# comment three",
    "# comment four",
    "# comment five",
    "",
    "def gen():",
    '    """Docstring body.',
    "        second line.",
    '    """',
    '    x = """kept string"""',
    "    return x",
  ].join("\n");
  const out = codeTrimPlugin.run(src, {})?.text;
  assert.ok(out, "must still crush (comments + docstring elided)");
  assert.ok(
    out!.includes('x = """kept string"""'),
    "non-docstring triple literal must survive verbatim",
  );
  assert.ok(!out!.includes("Docstring body"), "docstring elided");
});

test("code-trim: unterminated triple quote fails open", () => {
  const src = [
    "import os",
    "",
    "def f():",
    '    """unclosed docstring',
    "    return x",
  ].join("\n");
  assert.equal(codeTrimPlugin.run(src, {}), null);
});

const JS_TPL = [
  "// top comment one",
  "// top comment two",
  "// top comment three",
  "// top comment four",
  "function greet(name) {",
  "  // build a safe url",
  '  const url = `https://x/${name.split("//")[0]}/y`;',
  "  /* block",
  "     comment line two",
  "     comment */",
  "  console.log(`hi ${url}`);",
  "  return url;",
  "}",
].join("\n");

test("code-trim: js/ts comments elided, template literals with ${} intact", () => {
  const out = codeTrimPlugin.run(JS_TPL, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(!out!.includes("top comment"));
  assert.ok(!out!.includes("comment */"));
  assert.ok(
    out!.includes('const url = `https://x/${name.split("//")[0]}/y`;'),
    "template literal kept verbatim",
  );
  assert.ok(
    out!.includes("console.log(`hi ${url}`);"),
    "second template kept verbatim",
  );
  assert.match(out!, /\/\/ \[acp-crush: elided \d+ lines?\]/);
});

test("code-trim: prose is not detected as code", () => {
  assert.equal(
    codeTrimPlugin.run("This is a plain English paragraph. ".repeat(30), {}),
    null,
  );
});

function pytestLog(): string {
  const lines: string[] = [];
  lines.push("=== test session starts ===");
  lines.push("platform linux -- Python 3.12.4, pytest-8.3.2");
  for (let i = 0; i < 40; i++)
    lines.push(`tests/test_api.py::test_case_${i} PASSED`);
  for (let i = 0; i < 12; i++) {
    lines.push(`___________ test_case_fail_${i} ___________`);
    lines.push(`E   AssertionError: expected status 200, got ${500 + i}`);
    lines.push(`ERROR tests/test_api.py::test_case_fail_${i}`);
    lines.push("");
  }
  for (let i = 0; i < 500; i++)
    lines.push(
      "WARNING  urllib3.connectionpool:connectionpool.py:869 - Connection pool is full, discarding connection",
    );
  for (let i = 0; i < 100; i++)
    lines.push(`INFO  app.api:api.py:${i} - request handled in ${i}ms`);
  lines.push("");
  lines.push("=== short test summary info ===");
  lines.push(
    "FAILED tests/test_api.py::test_case_fail_0 - AssertionError: expected status 200, got 500",
  );
  lines.push("======== 12 failed, 40 passed in 3.42s ========");
  return lines.join("\n");
}

test("log-select: every distinct error line survives, warnings deduped, noise dropped", () => {
  const src = pytestLog();
  const out = logSelectPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(out!.length < src.length / 2, "big reduction expected");
  const errorLines = out!
    .split("\n")
    .filter((l) => l.startsWith("ERROR tests/test_api.py::"));
  assert.equal(
    errorLines.length,
    12,
    "kernel invariant: all distinct ERROR lines survive (budget 20 >= 12)",
  );
  assert.ok(
    out!.includes("ERROR tests/test_api.py::test_case_fail_0"),
    "first error kept",
  );
  assert.ok(
    out!.includes("ERROR tests/test_api.py::test_case_fail_11"),
    "last error kept",
  );
  const warnCount = out!
    .split("\n")
    .filter((l) => l.includes("Connection pool is full")).length;
  assert.ok(
    warnCount >= 1 && warnCount <= 15,
    `identical warnings deduped (${warnCount} of 500)`,
  );
  const infoCount = out!
    .split("\n")
    .filter((l) => l.includes("request handled in")).length;
  assert.ok(infoCount <= 15, `INFO noise dropped (${infoCount} of 100)`);
  assert.match(out!, /\[\d+ lines omitted:/, "honest omission footer present");
  assert.ok(
    out!.includes("=== short test summary info ==="),
    "summary line kept",
  );
});

test("log-select: deterministic (byte-identical across calls)", () => {
  const src = pytestLog();
  assert.equal(
    logSelectPlugin.run(src, {})?.text,
    logSelectPlugin.run(src, {})?.text,
  );
});

test("log-select: short logs pass through untouched", () => {
  const short = [
    "INFO start",
    "ERROR boom",
    "ERROR bang",
    ...Array(30).fill("INFO tick"),
  ].join("\n");
  assert.equal(short.split("\n").length, 33);
  assert.equal(logSelectPlugin.run(short, {}), null, "<50 lines never crushed");
});

test("log-select: unstructured prose never reaches the selector", () => {
  const prose = Array.from(
    { length: 60 },
    (_, i) =>
      `Sentence number ${i} talks about ordinary topics without any structure.`,
  ).join("\n");
  assert.equal(logSelectPlugin.run(prose, {}), null);
  assert.equal(
    crushText(prose, { countTokens: tok }),
    null,
    "and crushText fails open on prose",
  );
});

function jsTraceLog(): string {
  const lines: string[] = ["ERROR unhandled exception in worker pool"];
  for (let i = 0; i < 25; i++)
    lines.push(
      `    at Worker.task (/app/node_modules/pkg/dist/worker.js:${10 + i}:${i})`,
    );
  lines.push(
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  );
  for (let i = 0; i < 40; i++) lines.push("info  heartbeat ok");
  return lines.join("\n");
}

test("log-select: long runtime stack traces collapse to head frames + marker", () => {
  const src = jsTraceLog();
  const out = logSelectPlugin.run(src, {})?.text;
  assert.ok(out, "must crush");
  assert.ok(
    out!.includes("at Worker.task (/app/node_modules/pkg/dist/worker.js:10:0)"),
    "head frame kept",
  );
  assert.match(
    out!,
    /\[\.\.\. \d+ frames collapsed\]/,
    "collapse marker present",
  );
  assert.ok(!out!.includes("worker.js:20:10"), "middle runtime frames dropped");
  assert.ok(!out!.includes("worker.js:34:24"), "tail runtime frames dropped");
});

test("crushText: log-shaped payloads dispatch to the log strategy", () => {
  assert.equal(
    crushText(pytestLog(), { countTokens: tok })?.strategy,
    "log-select",
  );
});

test("crushText: error-line invariant rejects lossy log output that drops errors", () => {
  // Errors are spaced > 2*LOG_ERROR_CONTEXT apart so the ±context fill around
  // selected lines cannot bridge over the dropped ones.
  const lines: string[] = [];
  for (let i = 0; i < 25; i++) {
    lines.push(
      `ERROR db_${String.fromCharCode(97 + (i % 26))}: connection lost shard ${i}`,
    );
    for (let j = 0; j < 8; j++)
      lines.push(`INFO heartbeat ok shard-${i} tick-${j}`);
  }
  const src = lines.join("\n");
  assert.ok(
    logSelectPlugin.run(src, {}) !== null,
    "the plugin itself produces output",
  );
  assert.equal(
    crushText(src, { countTokens: tok }),
    null,
    ">20 distinct errors cannot all survive -> rejected -> fail open",
  );
});

test("registry: list/register/unregister/reset built-ins", () => {
  resetCrushPlugins();
  assert.deepEqual(listCrushPlugins(), [
    { id: "json-fold", kinds: ["json"] },
    { id: "code-trim", kinds: ["code"] },
    { id: "log-select", kinds: ["log"] },
  ]);
  const spy = { id: "spy", kinds: ["json"], run: (_t: string) => null };
  registerCrushPlugin(spy);
  assert.equal(
    listCrushPlugins().find((p) => p.id === "spy")?.kinds[0],
    "json",
  );
  unregisterCrushPlugin("spy");
  assert.equal(
    listCrushPlugins().some((p) => p.id === "spy"),
    false,
  );
  registerCrushPlugin(spy);
  resetCrushPlugins();
  assert.equal(
    listCrushPlugins().some((p) => p.id === "spy"),
    false,
    "reset restores exactly the built-ins",
  );
});

test("crushText: dispatch guard — plugins only see their own kind", () => {
  const seen: string[] = [];
  const spy = {
    id: "spy-code-only",
    kinds: ["code"],
    run: (t: string) => {
      seen.push(t);
      return null;
    },
  };
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  const json = JSON.stringify(rows);
  assert.equal(
    crushText(json, { countTokens: tok, plugins: [spy] }),
    null,
    "json payload never reaches a code-only plugin",
  );
  assert.equal(seen.length, 0, "plugin body never invoked for a foreign kind");
});

test("crushText: throwing plugin fails open to the next candidate", () => {
  const boom = {
    id: "boom",
    kinds: ["json"],
    run: () => {
      throw new Error("boom");
    },
  };
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  const out = crushText(JSON.stringify(rows), {
    countTokens: tok,
    plugins: [boom, jsonFoldPlugin],
  });
  assert.equal(
    out?.strategy,
    "json-fold",
    "built-in still crushes after the thrower failed open",
  );
});

test("crushText: plugin returning input-identical text is a no-op", () => {
  const identity = {
    id: "identity",
    kinds: ["json"],
    run: (t: string) => ({ text: t, lossy: false }),
  };
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  assert.equal(
    crushText(JSON.stringify(rows), { countTokens: tok, plugins: [identity] }),
    null,
  );
});

const absorbOn = (
  overrides: Partial<typeof DEFAULT_ABSORB_CONFIG> = {},
): typeof DEFAULT_ABSORB_CONFIG => ({
  ...DEFAULT_ABSORB_CONFIG,
  enabled: true,
  ...overrides,
});

const crushOn = (overrides: Partial<CrushConfig> = {}): CrushConfig => ({
  ...DEFAULT_CRUSH_CONFIG,
  enabled: true,
  ...overrides,
});

test("evaluateToolResult: skip when below minToolTokens or under context pressure", () => {
  const small = JSON.stringify([{ id: 1 }]);
  const ev1 = evaluateToolResult({
    text: small,
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
    tokenCount: 0,
    modelContextLimit: 200000,
    countTokens: tok,
  });
  assert.deepEqual(ev1, {
    kind: "skip",
    text: small,
    rawTokens: ev1.rawTokens,
  });
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const ev2 = evaluateToolResult({
    text: JSON.stringify(rows),
    absorb: absorbOn({ contextThresholdPct: 0.8 }),
    crush: crushOn(),
    tokenCount: 1000,
    modelContextLimit: 100000,
    countTokens: tok,
  });
  assert.equal(
    ev2.kind,
    "skip",
    "context below threshold % -> whole feature idle",
  );
});

test("evaluateToolResult: crushed when deterministic compression lands under minToolTokens", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  const ev = evaluateToolResult({
    text: src,
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
    tokenCount: 0,
    modelContextLimit: 200000,
    countTokens: tok,
  });
  assert.equal(ev.kind, "crushed");
  assert.ok(ev.newTokens !== undefined && ev.newTokens < 100);
  assert.ok(ev.reduction !== undefined && ev.reduction > 0);
  assert.equal(ev.strategy, "json-fold");
  assert.equal(ev.lossy, false);
  assert.ok(ev.text.includes("__acp_crush"));
});

test("evaluateToolResult: distill carries the crushed payload when still over threshold", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    level: "INFO",
    msg: `request handled with status code and correlation value ${i}`,
  }));
  const src = JSON.stringify(rows);
  const ev = evaluateToolResult({
    text: src,
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
    tokenCount: 0,
    modelContextLimit: 200000,
    countTokens: tok,
  });
  assert.equal(ev.kind, "distill");
  assert.ok(
    ev.text.includes("__acp_crush"),
    "crushed payload forwarded to the absorb prompt path",
  );
  assert.notEqual(ev.text, src);
});

test("evaluateToolResult: uncrushable payload distills with the ORIGINAL text", () => {
  const prose = "Sentence about ordinary topics. ".repeat(200);
  const ev = evaluateToolResult({
    text: prose,
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
    tokenCount: 0,
    modelContextLimit: 200000,
    countTokens: tok,
  });
  assert.equal(ev.kind, "distill");
  assert.equal(
    ev.text,
    prose,
    "no strategy applied -> original bytes preserved",
  );
});

test("evaluateToolResult: per-strategy disable and excludeTools honored", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  const off = evaluateToolResult({
    text: src,
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn({ strategies: { "json-fold": { enabled: false } } }),
    tokenCount: 0,
    modelContextLimit: 200000,
    countTokens: tok,
  });
  assert.equal(off.kind, "distill");
  assert.equal(off.text, src, "disabled strategy -> original text");
  const code =
    [
      "import os",
      "",
      "def f():",
      "    # c1",
      "    # c2",
      "    # c3",
      "    # c4",
      "    # c5",
      "    # c6",
      "    return os.getcwd()",
    ].join("\n") + "\n";
  const excl = evaluateToolResult({
    text: code.repeat(30),
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn({ strategies: { "code-trim": { excludeTools: ["bash"] } } }),
    tokenCount: 0,
    modelContextLimit: 200000,
    meta: { toolName: "bash" },
    countTokens: tok,
  });
  assert.equal(excl.kind, "distill");
  assert.equal(excl.text, code.repeat(30), "excluded tool -> original text");
  const notExcl = evaluateToolResult({
    text: code.repeat(30),
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn({ strategies: { "code-trim": { excludeTools: ["bash"] } } }),
    tokenCount: 0,
    modelContextLimit: 200000,
    meta: { toolName: "python" },
    countTokens: tok,
  });
  assert.notEqual(
    notExcl.text,
    code.repeat(30),
    "non-excluded tool still crushed",
  );
});

function turnMessages(resultText: string): CoreMessage[] {
  return [
    { id: "u1", role: "user", contentType: "text", text: "run the job" },
    {
      id: "a-tc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "call_1",
      text: JSON.stringify({ command: "job" }),
    },
    {
      id: "t-res",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "call_1",
      text: resultText,
    },
  ];
}

test("processTurn: feature off (either switch) leaves messages byte-identical", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
  }));
  const src = JSON.stringify(rows);
  const core = createCore({ countTokens: tok });
  const absorbHigh = absorbOn({ minToolTokens: 100000 });
  const cases = [
    defaultConfig(200000, { absorb: absorbHigh }),
    defaultConfig(200000, { absorb: absorbHigh, crush: { enabled: false } }),
    defaultConfig(200000, {
      absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: false },
      crush: crushOn(),
    }),
  ];
  for (const config of cases) {
    const turn = core.processTurn({
      messages: turnMessages(src),
      state: createInitialState(),
      config,
      tokenCount: 0,
      renderTags: "none",
    });
    assert.deepEqual(
      turn.messages.map((m) => m.text),
      ["run the job", JSON.stringify({ command: "job" }), src],
      "byte-identical result text",
    );
  }
});

test("processTurn: sub-threshold results are never touched", () => {
  const small = JSON.stringify([{ id: 1, zone: "z1" }]);
  const core = createCore({ countTokens: tok });
  const config = defaultConfig(200000, {
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
  });
  const turn = core.processTurn({
    messages: turnMessages(small),
    state: createInitialState(),
    config,
    tokenCount: 0,
    renderTags: "none",
  });
  assert.deepEqual(
    turn.messages.map((m) => m.text),
    ["run the job", JSON.stringify({ command: "job" }), small],
  );
});

test("processTurn: crushed-below-threshold result skips the model absorb round-trip", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  assert.ok(tok(src) >= 100, "fixture must start above the absorb threshold");
  const core = createCore({ countTokens: tok });
  const config = defaultConfig(200000, {
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
  });
  const turn = core.processTurn({
    messages: turnMessages(src),
    state: createInitialState(),
    config,
    tokenCount: 0,
    renderTags: "none",
  });
  const res = turn.messages.find((m) => m.id === "t-res")!;
  const env = JSON.parse(res.text!) as RowEnv;
  assert.equal(env.__acp_crush, "rows", "wire carries the crushed envelope");
  assert.ok(
    !turn.messages.some((m) => (m.text ?? "").includes(ABSORB_PROMPT_MARKER)),
    "below threshold: no model absorb round-trip",
  );
  assert.deepEqual(
    turn.messages.filter((m) => m.id !== "t-res").map((m) => m.text),
    ["run the job", JSON.stringify({ command: "job" })],
    "non-result messages untouched",
  );
});

test("processTurn: still-over-threshold result is forwarded crushed WITH the absorb prompt", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    level: "INFO",
    msg: `request handled with status code and correlation value ${i}`,
  }));
  const src = JSON.stringify(rows);
  const core = createCore({ countTokens: tok });
  const config = defaultConfig(200000, {
    absorb: absorbOn({ minToolTokens: 100 }),
    crush: crushOn(),
  });
  const turn = core.processTurn({
    messages: turnMessages(src),
    state: createInitialState(),
    config,
    tokenCount: 0,
    renderTags: "none",
  });
  const res = turn.messages.find((m) => m.id === "t-res")!;
  const markerAt = res.text!.indexOf(ABSORB_PROMPT_MARKER);
  assert.ok(markerAt > 0, "absorb prompt re-attached on the crushed result");
  const env = JSON.parse(res.text!.slice(0, markerAt)) as RowEnv;
  assert.equal(env.__acp_crush, "rows", "crushed before the prompt decision");
  assert.ok(
    tok(res.text!.slice(0, markerAt)) >= 100,
    "still above threshold after crushing",
  );
});

test("processTurn: log result crushed below threshold skips the absorb round-trip", () => {
  const log = [
    "INFO boot ok",
    ...Array(55).fill("warn retry x"),
    "ERROR db connection lost",
    "ERROR transaction aborted",
    "Summary: 2 errors, 55 warnings",
  ].join("\n");
  assert.ok(tok(log) >= 150, "fixture must start above the absorb threshold");
  const core = createCore({ countTokens: tok });
  const config = defaultConfig(200000, {
    absorb: absorbOn({ minToolTokens: 150 }),
    crush: crushOn(),
  });
  const turn = core.processTurn({
    messages: turnMessages(log),
    state: createInitialState(),
    config,
    tokenCount: 0,
    renderTags: "none",
  });
  const res = turn.messages.find((m) => m.id === "t-res")!;
  assert.ok(
    res.text && tok(res.text) < 150,
    `crushed below threshold (${tok(res.text!)} tok)`,
  );
  assert.ok(
    res.text!.includes("ERROR db connection lost"),
    "errors survive the crush",
  );
  assert.ok(
    res.text!.includes("ERROR transaction aborted"),
    "errors survive the crush",
  );
  assert.ok(
    !turn.messages.some((m) => (m.text ?? "").includes(ABSORB_PROMPT_MARKER)),
    "below threshold: no model absorb round-trip",
  );
});

test("processTurn: stale absorb marker is stripped and re-decided on the crushed payload", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  const core = createCore({ countTokens: tok });
  let state = createInitialState();
  let messages = turnMessages(src);
  const off = core.processTurn({
    messages,
    state,
    config: defaultConfig(200000, { absorb: absorbOn({ minToolTokens: 100 }) }),
    tokenCount: 0,
    renderTags: "none",
  });
  state = off.state;
  messages = off.messages;
  const baked = messages.find((m) => m.id === "t-res")!.text!;
  assert.ok(
    baked.includes(ABSORB_PROMPT_MARKER),
    "precondition: marker baked on turn 1",
  );
  const on = core.processTurn({
    messages,
    state,
    config: defaultConfig(200000, {
      absorb: absorbOn({ minToolTokens: 100 }),
      crush: crushOn(),
    }),
    tokenCount: 0,
    renderTags: "none",
  });
  const res = on.messages.find((m) => m.id === "t-res")!.text!;
  assert.ok(res.includes("__acp_crush"), "payload crushed on turn 2");
  assert.ok(
    !res.includes(ABSORB_PROMPT_MARKER),
    "stale marker stripped, re-decided below threshold -> no fresh prompt",
  );
});

test("crush node: reports effects and respects gating", () => {
  const core = createCore({ countTokens: tok });
  const node = core.defaultNodes().find((n) => n.name === "crush")!;
  assert.ok(node, "crush node present in the pipeline");
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: i * 7,
    ts: "2026-09-21T12:00:00Z",
    level: "INFO",
    name: `svc-${i}`,
  }));
  const src = JSON.stringify(rows);
  const msgs = turnMessages(src);
  const ctx = {
    config: defaultConfig(200000, {
      absorb: absorbOn({ minToolTokens: 100 }),
      crush: crushOn(),
    }),
    tokenCount: 0,
    countTokens: tok,
  };
  const io = runPipeline([node], makeIO(msgs, createInitialState()), ctx);
  assert.equal(io.effects.crushCount, 1);
  assert.equal(io.effects.crushDistilledCount, 0);
  assert.ok(
    io.messages.find((m) => m.id === "t-res")!.text!.includes("__acp_crush"),
  );
  const offCtx = {
    config: defaultConfig(200000, {
      absorb: absorbOn({ minToolTokens: 100 }),
      crush: { enabled: false },
    }),
    tokenCount: 0,
    countTokens: tok,
  };
  const io2 = runPipeline([node], makeIO(msgs, createInitialState()), offCtx);
  assert.equal(
    io2.messages.find((m) => m.id === "t-res")!.text,
    src,
    "gated off -> untouched",
  );
  assert.equal(io2.effects.crushCount, undefined);
});

test("json-fold: sparse null key absent in row 0 survives rows-hoist decode", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    zone: "z1",
    id: `id-${String(i).padStart(3, "0")}`,
    name: `item-${i}`.padEnd(90, "."),
    ...(i === 0 ? {} : { a: null }),
  }));
  const out = crushJson(JSON.stringify(rows));
  assert.ok(out, "should crush via rows hoist");
  const env = JSON.parse(out) as RowEnv;
  assert.equal(env.__acp_crush, "rows");
  assert.equal(env.const.zone, "z1", "genuine constant still hoists");
  const decoded = decodeValue(env) as Record<string, unknown>[];
  for (let i = 0; i < rows.length; i++)
    assert.deepEqual(decoded[i], rows[i], `row ${i} decodes value-lossless`);
});

test("code-trim: regex literal containing /* does not open a fake comment", () => {
  const js = [
    "function f() {",
    "  var re = /[/*]/;",
    "  var a = 1;",
    "  var b = 2;",
    "  var c = 3;",
    "  var d = 4;",
    '  var s = "has */ inside";',
    "  var e = 5;",
    "  var g = 6;",
    "  return a + b + c + d + e + g;",
    "}",
  ].join("\n");
  const out = crushText(js);
  if (out !== null) {
    for (const line of [
      "var re = /[/*]/;",
      "var a = 1;",
      "var b = 2;",
      "var c = 3;",
      "var d = 4;",
      "var e = 5;",
      "var g = 6;",
    ])
      assert.ok(out.text.includes(line), `code line preserved: ${line}`);
  }
});

test("code-trim: division is not a regex; full-line comments still elide", () => {
  const js = [
    "function ratio(total, parts) {",
    "  var a = total / parts[0];",
    "  var b = (total + 1) / (parts[1] || 1);",
    "  var c = -total / parts[2];",
    "  /* first full-line comment */",
    "  /* second full-line comment */",
    "  var d = total / 2 * parts[3];",
    "  return a + b + c + d;",
    "}",
  ].join("\n");
  const out = crushText(js);
  assert.ok(out !== null, "elided comments should pass the reduction floor");
  assert.ok(out.text.includes("var a = total / parts[0];"));
  assert.ok(out.text.includes("var b = (total + 1) / (parts[1] || 1);"));
  assert.ok(out.text.includes("var d = total / 2 * parts[3];"));
  assert.ok(!out.text.includes("first full-line comment"), "comment elided");
});

test("crushText: plugin with malformed kinds fails open instead of throwing", () => {
  const bad = {
    id: "bad",
    kinds: undefined,
    run: () => null,
  } as unknown as Parameters<typeof registerCrushPlugin>[0];
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  const out = crushText(JSON.stringify(rows), {
    countTokens: tok,
    plugins: [bad, jsonFoldPlugin],
  });
  assert.equal(
    out?.strategy,
    "json-fold",
    "malformed plugin skipped, built-in still applies",
  );
});

test("crushText: plugin returning non-string text fails open", () => {
  const liar = {
    id: "liar",
    kinds: ["json"],
    run: () => ({ text: 123, lossy: false }),
  } as unknown as Parameters<typeof registerCrushPlugin>[0];
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i * 3, zone: "z1" }));
  const out = crushText(JSON.stringify(rows), {
    countTokens: tok,
    plugins: [liar, jsonFoldPlugin],
  });
  assert.equal(
    out?.strategy,
    "json-fold",
    "non-string result skipped, built-in still applies",
  );
});
