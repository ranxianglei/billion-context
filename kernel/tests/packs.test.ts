import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  isValidPackName,
  sanitizePackSurface,
  defaultPack,
  leanPack,
  LEAN_HOW_TO_COMPRESS,
  leanHowToCompress,
  HOW_TO_COMPRESS_RULES,
  TIER2_DISTILL_RULES,
  TIER3_CONDENSE_RULES,
  builtinSource,
  createDirPackSource,
  createPackResolver,
  defaultPackSources,
  applyAcpToolOverrides,
  buildCompressSystemPrompt,
  buildCompressTextSystemPrompt,
  buildCompressHybridSystemPrompt,
  defaultPrompts,
  ACP_TOOLS_OPENAI,
  type Pack,
  type PackSource,
} from "../src/index.js";

test("isValidPackName accepts simple names, rejects traversal", () => {
  assert.equal(isValidPackName("lean"), true);
  assert.equal(isValidPackName("team-pack.v2"), true);
  assert.equal(isValidPackName("../etc"), false);
  assert.equal(isValidPackName(""), false);
  assert.equal(isValidPackName("-x"), false);
});

test("sanitizePackSurface keeps known keys, drops malformed", () => {
  const s = sanitizePackSurface({
    prompts: { compressPhilosophy: "p", howToCompressRules: 42 },
    promptSections: { acpTags: "tags", tools: null, summariesInContext: 7 },
    nudgeSections: { efficiencyNote: "e", t2Guidance: null, bogus: "x" },
    toolPrompts: {
      compress: {
        description: "d",
        paramDescriptions: { content: "c", startId: 3 },
      },
      search_context: { description: null },
    },
    adapters: { pi: { any: "thing" } },
  });
  assert.deepEqual(s.prompts, { compressPhilosophy: "p" });
  assert.deepEqual(s.promptSections, { acpTags: "tags", tools: null });
  assert.deepEqual(s.nudgeSections, { efficiencyNote: "e", t2Guidance: null });
  assert.deepEqual(s.toolPrompts, {
    compress: { description: "d", paramDescriptions: { content: "c" } },
  });
  assert.deepEqual(s.adapters, { pi: { any: "thing" } });
});

test("sanitizePackSurface on null/garbage returns empty surface", () => {
  assert.deepEqual(sanitizePackSurface(null), {});
  assert.deepEqual(sanitizePackSurface({ prompts: "nope", adapters: [1] }), {
    prompts: {},
    promptSections: {},
    nudgeSections: {},
    toolPrompts: {},
  });
});

test("builtin registry resolves default and lean; unknown misses", () => {
  assert.equal(builtinSource.resolve("default"), defaultPack);
  assert.equal(builtinSource.resolve("lean"), leanPack);
  assert.equal(builtinSource.resolve("nope"), null);
  const names = builtinSource
    .list()
    .map((p) => p.name)
    .sort();
  assert.deepEqual(names, ["default", "lean"]);
});

test("default pack has empty surface", () => {
  assert.deepEqual(defaultPack.surface, {});
});

test("lean pack keeps rules default, one-line tool descriptions, adapters namespace", () => {
  assert.deepEqual(leanPack.surface.prompts ?? {}, {});
  assert.equal(
    leanPack.surface.toolPrompts?.compress?.description,
    "Replace consumed conversation ranges with self-contained summaries using mNNNNN or bN refs; batch multiple ranges into ONE call (a single string may hold every range).",
  );
  assert.ok(
    leanPack.surface.adapters && typeof leanPack.surface.adapters === "object",
  );
  assert.equal(Object.keys(leanPack.surface.adapters).length, 1);
});

test("lean carries a condensed how-to-compress style contract in the pi slot", () => {
  const pi = leanPack.surface.adapters?.pi as {
    promptSections: Record<string, string | null>;
  };
  const howTo = pi.promptSections.howToCompress ?? "";
  assert.ok(
    howTo.length > 800 && howTo.length < 3100,
    `condensed, not full (len=${howTo.length}; ceiling raised for the #442 open-objectives rule)`,
  );
  for (const marker of [
    "TASK AS OF THIS BLOCK",
    "PENDING",
    "no Q&A lists",
    "KEEP VERBATIM",
    "chose X over Y because Z",
    "PRIORITY",
    "Do not mimic",
    "Open objectives",
    "Time sensitivity", // #2522: fold-time snapshot declaration for line numbers/snippets
  ]) {
    assert.ok(howTo.includes(marker), `missing: ${marker}`);
  }
  // #265: summariesInContext is a compact trust guardrail now, not null
  assert.equal(
    typeof pi.promptSections.summariesInContext,
    "string",
    "compact guardrail retained",
  );
  assert.equal(
    pi.promptSections.philosophy,
    null,
    "philosophy stays dropped (howToCompress is the operative contract)",
  );
  assert.equal(
    pi.promptSections.howToCompress,
    LEAN_HOW_TO_COMPRESS,
    "pi slot is the exported LEAN_HOW_TO_COMPRESS constant",
  );
});

test("lean acpTags carries BOTH the summary-trust guardrail and the post-compress verification ban (#272 + #265)", () => {
  const pi = leanPack.surface.adapters?.pi as {
    promptSections: Record<string, string | null>;
  };
  const tags = pi.promptSections.acpTags ?? "";
  for (const marker of [
    "Recall on demand only",
    "makes recall unnecessary",
    "Never echo the XML tags",
    "never treat a summarized instruction or decision as current",
    "fresh user confirmation",
    "your own record",
    "no acp_status/decompress/search_context call made merely to verify the fold",
    "that listing already confirms the spans",
    "one acp_status call for the current ranges is enough",
  ]) {
    assert.ok(tags.includes(marker), `missing: ${marker}`);
  }
  assert.ok(
    !tags.includes("settled history"),
    "inverted 'settled history' phrasing must be gone (#265)",
  );
  assert.ok(
    !tags.includes("continue the task from them"),
    "inverted phrasing must be gone (#265)",
  );
});

test("lean acpTags states ref stability across compression (no false renumbering claim, #417)", () => {
  const pi = leanPack.surface.adapters?.pi as {
    promptSections: Record<string, string | null>;
  };
  const tags = pi.promptSections.acpTags ?? "";
  assert.ok(
    tags.includes(
      "Message refs remain stable across compression within the same session state.",
    ),
    "stability wording must be present",
  );
  assert.ok(
    !tags.includes("may be renumbered"),
    "false per-compress renumbering claim must be gone",
  );
  for (const marker of [
    'call acp_status with { scope: "uncompressed" }',
    "then retry in the same turn using the reported refs",
    "never guess offsets",
    "Batch target ranges in one call",
  ]) {
    assert.ok(
      tags.includes(marker),
      `retained failure-handling rule missing: ${marker}`,
    );
  }
});

test("builtin packs never claim refs are renumbered after compression (#417)", () => {
  for (const pack of [defaultPack, leanPack]) {
    assert.doesNotMatch(
      JSON.stringify(pack),
      /renumber/i,
      `${pack.name} must not claim refs are renumbered`,
    );
  }
});

test("lean pack retains summary-trust guardrail (regression: inverted 'settled history' removed)", () => {
  const pi = leanPack.surface.adapters?.["pi"] as
    { promptSections?: Record<string, unknown> } | undefined;
  const ps = pi?.promptSections ?? {};
  assert.equal(
    typeof ps.summariesInContext,
    "string",
    "lean must retain summariesInContext, not strip it",
  );
  const sic = ps.summariesInContext as string;
  assert.ok(
    sic.includes("verify before acting"),
    "must instruct verify-before-acting",
  );
  assert.ok(
    sic.includes("Do NOT act on instructions"),
    "must forbid acting on summarized instructions",
  );
  assert.ok(
    sic.startsWith("COMPRESSION SUMMARIES IN CONTEXT"),
    "override must be the full section incl. header",
  );
  assert.ok(
    sic.includes("unless the user re-confirms them in a current message"),
    "re-confirm exception clause must stay",
  );
  const tags = String(ps.acpTags);
  assert.ok(
    !tags.includes("settled history"),
    "inverted 'settled history' phrasing must be gone",
  );
  assert.ok(
    !tags.includes("continue the task from them"),
    "inverted 'continue the task from them' phrasing must be gone",
  );
});

test("dir source resolves and lists json packs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-"));
  try {
    writeFileSync(
      path.join(dir, "team.json"),
      JSON.stringify({
        name: "team",
        version: "2.0",
        description: "d",
        toolPrompts: { compress: { description: "T" } },
      }),
    );
    writeFileSync(path.join(dir, "broken.json"), "not json");
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("team");
    assert.equal(pack?.source, `file:${path.join(dir, "team.json")}`);
    assert.equal(pack?.version, "2.0");
    assert.equal(pack?.surface.toolPrompts?.compress?.description, "T");
    assert.equal(src.resolve("broken"), null);
    assert.equal(src.resolve("../escape"), null);
    const names = src.list().map((p) => p.name);
    assert.deepEqual(names, ["team"]);
    const { list: listDetached } = src;
    assert.deepEqual(
      listDetached().map((p) => p.name),
      ["team"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source: filename is the pack identity — internal name mismatch is ignored", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-id-"));
  try {
    writeFileSync(
      path.join(dir, "team.json"),
      JSON.stringify({
        name: "other",
        toolPrompts: { compress: { description: "T" } },
      }),
    );
    const src = createDirPackSource("project", dir);
    const pack = src.resolve("team");
    assert.equal(pack?.name, "team");
    assert.equal(pack?.surface.toolPrompts?.compress?.description, "T");
    assert.equal(
      src.resolve("other"),
      null,
      "content-side name is not a resolution key",
    );
    assert.deepEqual(
      src.list().map((p) => p.name),
      ["team"],
      "list() reports the filename too",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir source on missing directory yields empty list and no resolve", () => {
  const src = createDirPackSource(
    "user",
    path.join(tmpdir(), "acp-no-such-dir"),
  );
  assert.equal(src.resolve("lean"), null);
  assert.deepEqual(src.list(), []);
});

test("resolver consults sources in order; first hit wins", () => {
  const a: PackSource = {
    id: "a",
    resolve: (name) =>
      name === "x" ? { name: "x", surface: {}, source: "a" } : null,
  };
  const b: PackSource = {
    id: "b",
    resolve: (name) =>
      name === "x" || name === "y" ? { name, surface: {}, source: "b" } : null,
    list: () => [
      { name: "x", surface: {}, source: "b" },
      { name: "z", surface: {}, source: "b" },
    ],
  };
  const r = createPackResolver([a, b, builtinSource]);
  assert.equal(r.resolve("x")?.source, "a");
  assert.equal(r.resolve("y")?.source, "b");
  assert.equal(r.resolve("lean")?.name, "lean");
  assert.equal(r.resolve("../bad"), null);
  assert.deepEqual(
    r.listPacks().map((p) => `${p.name}:${p.source}`),
    ["x:b", "z:b", "default:builtin:default", "lean:builtin:lean"],
  );
});

test("custom source can shadow builtin lean", () => {
  const custom: PackSource = {
    id: "managed",
    resolve: (name) =>
      name === "lean"
        ? {
            name: "lean",
            surface: { toolPrompts: { acp_status: { description: "custom" } } },
            source: "managed:lean",
          }
        : null,
  };
  const r = createPackResolver([custom, builtinSource]);
  assert.equal(
    r.resolve("lean")?.surface.toolPrompts?.acp_status?.description,
    "custom",
  );
});

test("defaultPackSources orders project, user, builtin", () => {
  const sources = defaultPackSources({
    projectDir: "/p",
    userDirs: ["/u1", "/u2"],
  });
  assert.deepEqual(
    sources.map((s) => s.id),
    ["project", "user", "user", "builtin"],
  );
});

test("lean surface applies to wire tools via applyAcpToolOverrides", () => {
  const tools = applyAcpToolOverrides(
    ACP_TOOLS_OPENAI,
    leanPack.surface.toolPrompts,
  );
  const compress = tools.find((t) => t.function.name === "compress");
  assert.ok(compress);
  assert.equal(
    compress.function.description,
    leanPack.surface.toolPrompts?.compress?.description,
  );
  const params = compress.function.parameters as {
    properties: {
      content: {
        anyOf: {
          items?: {
            anyOf: {
              type: string;
              properties?: Record<string, { description?: string }>;
            }[];
          };
        }[];
      };
    };
  };
  const objectForm = params.properties.content.anyOf[0].items!.anyOf.find(
    (v) => v.type === "object",
  );
  assert.ok(objectForm?.properties?.startId);
  assert.equal(
    objectForm!.properties!.startId!.description,
    "Inclusive first mNNNNN or bN ref.",
  );
  const lineForm = params.properties.content.anyOf[0].items!.anyOf.find(
    (v) => v.type === "string",
  );
  assert.ok(lineForm, "line-form string variant is taught in the schema");
});

test("pack promptSections flow into buildCompressSystemPrompt", () => {
  const pack: Pack = {
    name: "quiet",
    surface: {
      promptSections: { summariesInContext: null, tools: "TOOLS-OVERRIDE" },
    },
    source: "test",
  };
  const text = buildCompressSystemPrompt(
    undefined,
    pack.surface.promptSections,
  );
  assert.ok(text.includes("TOOLS-OVERRIDE"));
  assert.ok(!text.includes("COMPRESSION SUMMARIES IN CONTEXT"));
});

test("#2335: lean pack's TOP-LEVEL promptSections drive the proxy builders — condensed contract + recall discipline reach every host", () => {
  const sections = leanPack.surface.promptSections;
  assert.ok(sections, "lean surface has top-level promptSections");
  for (const built of [
    buildCompressSystemPrompt(undefined, sections),
    buildCompressTextSystemPrompt(undefined, sections),
    buildCompressHybridSystemPrompt(undefined, sections),
  ]) {
    assert.ok(built.includes("Your summary is the ONLY record"), "lean condensed contract (LEAN_HOW_TO_COMPRESS) present");
    assert.ok(built.includes("Recall on demand only"), "recall discipline present");
    assert.ok(built.includes("read that file"), "file-pointer discipline present");
    assert.ok(!built.includes("Compression Philosophy:"), "default philosophy removed (lean nulls it)");
    assert.ok(!/ACP TAGS\n\nEach message in the conversation is annotated/.test(built), "default acpTags replaced by the lean rules");
  }
  // toolPrompts stay lean one-liners independent of this change
  const tools = applyAcpToolOverrides(ACP_TOOLS_OPENAI, leanPack.surface.toolPrompts);
  assert.ok(JSON.stringify(tools).includes("batch multiple ranges into ONE call"));
});

test("#2335: no-override builder output stays byte-identical (philosophy/howToCompress as tri-state sections must not drift)", () => {
  // The old builders hardcoded [prompts.compressPhilosophy, prompts.howToCompressRules, ...sections];
  // the section-list form must reproduce exactly that for every builder.
  const prompts = defaultPrompts;
  const expectFunction = [prompts.compressPhilosophy, prompts.howToCompressRules].join("\n\n");
  const builtFunction = buildCompressSystemPrompt(prompts);
  assert.ok(builtFunction.startsWith(expectFunction));
  const builtText = buildCompressTextSystemPrompt(prompts);
  assert.ok(builtText.startsWith(expectFunction));
  const builtHybrid = buildCompressHybridSystemPrompt(prompts);
  assert.ok(builtHybrid.startsWith(expectFunction));
});

test("#2335: file packs may trim philosophy/howToCompress (sanitize whitelist widened)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-lead-"));
  try {
    writeFileSync(
      path.join(dir, "lead.json"),
      JSON.stringify({
        promptSections: { philosophy: null, howToCompress: "CONDENSED-CONTRACT" },
      }),
    );
    const resolver = createPackResolver(defaultPackSources({ projectDir: dir }));
    const pack = resolver.resolve("lead");
    assert.ok(pack);
    const built = buildCompressSystemPrompt(undefined, pack!.surface.promptSections);
    assert.ok(built.includes("CONDENSED-CONTRACT"));
    assert.ok(!built.includes("Compression Philosophy:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file pack round-trips through dir source into resolver", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acp-packs-rt-"));
  const sub = path.join(dir, "nested");
  mkdirSync(sub, { recursive: true });
  try {
    writeFileSync(
      path.join(sub, "rt.json"),
      JSON.stringify({
        promptSections: { acpTags: "RT" },
        adapters: { pi: { delegatePrompt: "D" } },
      }),
    );
    const r = createPackResolver(defaultPackSources({ projectDir: sub }));
    const pack = r.resolve("rt");
    assert.equal(pack?.surface.promptSections?.acpTags, "RT");
    assert.deepEqual(pack?.surface.adapters, { pi: { delegatePrompt: "D" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every builtin pack's compression guidance carries the open-objectives rule (#442)", () => {
  const slots = [
    "howToCompressRules",
    "tier2DistillRules",
    "tier3CondenseRules",
  ] as const;
  const kernelDefaults = [
    HOW_TO_COMPRESS_RULES,
    TIER2_DISTILL_RULES,
    TIER3_CONDENSE_RULES,
  ];
  for (const pack of builtinSource.list()) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const override = pack.surface.prompts?.[slot];
      const text = typeof override === "string" ? override : kernelDefaults[i]!;
      assert.ok(
        text.includes("Open objectives"),
        `${pack.name}: ${slot} missing open-objectives rule`,
      );
      if (slot === "howToCompressRules") {
        assert.ok(
          text.toLowerCase().includes("open-objective status is current"),
          `${pack.name}: ${slot} missing softened status-is-current clause`,
        );
      }
    }
    const piSections = (
      pack.surface.adapters?.pi as
        { promptSections?: Record<string, string | null> } | undefined
    )?.promptSections;
    if (typeof piSections?.howToCompress === "string") {
      assert.ok(
        piSections.howToCompress.includes("Open objectives"),
        `${pack.name}: lean how-to-compress missing open-objectives rule`,
      );
      assert.ok(
        piSections.howToCompress
          .toLowerCase()
          .includes("open-objective status is current"),
        `${pack.name}: lean how-to-compress missing softened status-is-current clause`,
      );
    }
  }
});

test("summaries-in-context guardrails carve out Open objectives as live tasking (#442)", () => {
  const defaultPrompt = buildCompressSystemPrompt();
  assert.ok(
    defaultPrompt.includes('Exception: a summary\'s "Open objectives:" line'),
    "default summariesInContext guardrail keeps the live-tasking exception",
  );
  const piSections =
    (
      leanPack.surface.adapters?.pi as
        { promptSections?: Record<string, string | null> } | undefined
    )?.promptSections ?? {};
  assert.ok(
    (piSections.summariesInContext ?? "").includes(
      'Exception: a summary\'s "Open objectives:" line',
    ),
    "lean summariesInContext guardrail keeps the live-tasking exception",
  );
  assert.ok(
    (piSections.acpTags ?? "").includes(
      'A summary\'s "Open objectives:" line names still-open user requests',
    ),
    "lean acpTags guardrail keeps the live-tasking exception",
  );
});

test("lean how-to-compress keeps the language rule opt-in (#493)", () => {
  // Default: byte-identical base text, rule absent from the builtin surface.
  assert.equal(leanHowToCompress(), LEAN_HOW_TO_COMPRESS);
  assert.ok(
    !LEAN_HOW_TO_COMPRESS.includes(
      "Preserve the source conversation's primary language",
    ),
  );
  const pi = leanPack.surface.adapters?.pi as {
    promptSections: Record<string, string | null>;
  };
  assert.equal(pi.promptSections.howToCompress, LEAN_HOW_TO_COMPRESS);
  // Opt-in: append-only, both rule needles present.
  const withRule = leanHowToCompress(true);
  assert.ok(withRule.startsWith(LEAN_HOW_TO_COMPRESS));
  assert.ok(
    withRule.includes("Preserve the source conversation's primary language"),
  );
  assert.ok(
    withRule.includes(
      "Do not translate a monolingual conversation without a user request",
    ),
  );
});
