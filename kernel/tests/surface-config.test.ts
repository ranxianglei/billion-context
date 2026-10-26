import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applySectionOverrides,
  cloneWithDescriptions,
  applyAcpToolOverrides,
} from "../src/surface-config.js";
import {
  buildCompressSystemPrompt,
  buildCompressTextSystemPrompt,
  buildCompressHybridSystemPrompt,
  COMPRESS_TOOL,
  ACP_TOOLS_ANTHROPIC,
  ACP_TOOLS_OPENAI,
  ACP_TOOLS_RESPONSES,
} from "../src/compress-tools.js";
import { resolvePrompts } from "../src/prompts.js";
import { LANGUAGE_PRESERVATION_RULE } from "../src/compression-rules.js";

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["alpha", "ALPHA\n\nalpha body"],
  ["beta", "BETA\n\nbeta body"],
  ["gamma", "GAMMA\n\ngamma body"],
];

test("applySectionOverrides with no overrides returns all defaults in order", () => {
  assert.deepEqual(applySectionOverrides(SECTIONS), [
    "ALPHA\n\nalpha body",
    "BETA\n\nbeta body",
    "GAMMA\n\ngamma body",
  ]);
});

test("applySectionOverrides replaces a section with the given string", () => {
  const out = applySectionOverrides(SECTIONS, { beta: "BETA\n\nCUSTOM" });
  assert.deepEqual(out, [
    "ALPHA\n\nalpha body",
    "BETA\n\nCUSTOM",
    "GAMMA\n\ngamma body",
  ]);
});

test("applySectionOverrides removes a section on null (no empty gap)", () => {
  const out = applySectionOverrides(SECTIONS, { beta: null });
  assert.deepEqual(out, ["ALPHA\n\nalpha body", "GAMMA\n\ngamma body"]);
});

test("applySectionOverrides ignores unknown keys", () => {
  const out = applySectionOverrides(SECTIONS, { nope: "X" });
  assert.deepEqual(
    out,
    SECTIONS.map(([, t]) => t),
  );
});

test("applySectionOverrides ignores malformed (non-string, non-null) values", () => {
  const out = applySectionOverrides(SECTIONS, {
    alpha: 42 as unknown as string,
    beta: undefined,
  });
  assert.deepEqual(out, [
    "ALPHA\n\nalpha body",
    "BETA\n\nbeta body",
    "GAMMA\n\ngamma body",
  ]);
});

test("default builders are byte-stable against checked-in fixtures", () => {
  const fixture = (name: string) =>
    // normalize EOL: Windows checkouts materialize fixtures as CRLF while the
    // generated prompts are LF-canonical
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n",
    );
  assert.equal(
    buildCompressSystemPrompt(),
    fixture("prompt-function-default.txt"),
  );
  assert.equal(
    buildCompressTextSystemPrompt(),
    fixture("prompt-text-default.txt"),
  );
  assert.equal(
    buildCompressHybridSystemPrompt(),
    fixture("prompt-hybrid-default.txt"),
  );
});

test("system prompt builders carry the language rule only when opted in (#493)", () => {
  const prompts = resolvePrompts(undefined, { languagePreservation: true });
  for (const build of [
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
  ]) {
    assert.ok(build(prompts).includes(LANGUAGE_PRESERVATION_RULE));
    assert.ok(!build().includes(LANGUAGE_PRESERVATION_RULE));
  }
});

test("function builder honors section replace and remove", () => {
  const replaced = buildCompressSystemPrompt(undefined, {
    acpTags: "ACP TAGS\n\nCUSTOM TAG TEXT",
  });
  assert.ok(replaced.includes("CUSTOM TAG TEXT"));
  assert.ok(
    !replaced.includes("NEVER echo, repeat, or reference these XML tags"),
  );
  assert.ok(replaced.includes("You have five context-management tools"));

  const removed = buildCompressSystemPrompt(undefined, {
    summariesInContext: null,
  });
  assert.ok(!removed.includes("COMPRESSION SUMMARIES IN CONTEXT"));
  assert.ok(!removed.includes("MODEL-GENERATED summaries"));
  assert.ok(removed.endsWith("Use to find what to compress next."));
  assert.ok(!removed.includes("next.\n\n\n"));

  const crossIgnored = buildCompressSystemPrompt(undefined, {
    textProtocol: "NOPE",
  });
  assert.equal(crossIgnored, buildCompressSystemPrompt());
});

test("text and hybrid builders honor their own section keys", () => {
  const text = buildCompressTextSystemPrompt(undefined, {
    textTools: "ACP TOOLS (TEXT TRIGGERS)\n\nCUSTOM TEXT TOOLS",
  });
  assert.ok(text.includes("CUSTOM TEXT TOOLS"));
  assert.ok(text.includes("COMPRESSION PROTOCOL (TEXT)"));

  const hybrid = buildCompressHybridSystemPrompt(undefined, {
    functionTools: null,
  });
  assert.ok(!hybrid.includes("ACP TOOLS (FUNCTION CALLS)"));
  assert.ok(hybrid.includes("COMPRESSION PROTOCOL (TEXT)"));
});

function nestedSchema(): unknown {
  return {
    type: "object",
    properties: {
      topic: { type: "string", description: "TOPIC-DESC" },
      content: {
        type: "array",
        items: {
          type: "object",
          properties: {
            startId: { type: "string", description: "START-DESC" },
            endId: { type: "string", description: "END-DESC" },
          },
        },
      },
    },
  };
}

test("cloneWithDescriptions returns the input unchanged when there are no overrides", () => {
  const schema = nestedSchema();
  assert.equal(cloneWithDescriptions(schema, {}), schema);
});

test("cloneWithDescriptions replaces top-level and nested parameter descriptions", () => {
  const out = cloneWithDescriptions(nestedSchema(), {
    topic: "NEW-TOPIC",
    startId: "NEW-START",
  }) as ReturnType<typeof nestedSchema>;
  assert.equal(out.properties.topic.description, "NEW-TOPIC");
  assert.equal(
    out.properties.content.items.properties.startId.description,
    "NEW-START",
  );
  assert.equal(
    out.properties.content.items.properties.endId.description,
    "END-DESC",
  );
});

test("cloneWithDescriptions never mutates the input", () => {
  const schema = nestedSchema();
  const before = JSON.stringify(schema);
  cloneWithDescriptions(schema, { topic: "X", startId: "Y" });
  assert.equal(JSON.stringify(schema), before);
});

function protoKeySchema() {
  return {
    type: "object",
    properties: {
      topic: { type: "string", description: "OLD-TOPIC" },
      hasOwnProperty: { type: "string", description: "KEEP-ME" },
    },
  };
}

test("cloneWithDescriptions ignores Object.prototype keys absent from overrides", () => {
  const out = cloneWithDescriptions(protoKeySchema(), {
    topic: "NEW-TOPIC",
  }) as ReturnType<typeof protoKeySchema>;
  assert.equal(out.properties.topic.description, "NEW-TOPIC");
  assert.equal(out.properties.hasOwnProperty.description, "KEEP-ME");
});

test("applyAcpToolOverrides handles the anthropic shape (name + input_schema)", () => {
  const out = applyAcpToolOverrides(ACP_TOOLS_ANTHROPIC, {
    compress: {
      description: "NEW-COMPRESS-DESC",
      paramDescriptions: { startId: "NEW-START" },
    },
  });
  const compress = out.find((t) => t.name === "compress");
  assert.ok(compress);
  assert.equal(compress.description, "NEW-COMPRESS-DESC");
  const schema = compress.input_schema as {
    properties: Record<
      string,
      {
        anyOf: {
          items?: {
            anyOf: { properties?: Record<string, { description?: string }> }[];
          };
        }[];
      }
    >;
  };
  const objectForms = schema.properties.content.anyOf[0].items!.anyOf.filter(
    (v) => v.properties !== undefined,
  );
  assert.equal(objectForms.length, 2);
  for (const objectForm of objectForms)
    assert.equal(objectForm.properties!.startId!.description, "NEW-START");
  const untouched = out.find((t) => t.name === "decompress");
  assert.equal(untouched, ACP_TOOLS_ANTHROPIC[1]);
});

test("applyAcpToolOverrides handles the openai shape (function wrapper)", () => {
  const out = applyAcpToolOverrides(ACP_TOOLS_OPENAI, {
    acp_status: { description: "NEW-STATUS-DESC" },
  });
  const status = out.find((t) => t.function?.name === "acp_status");
  assert.ok(status);
  assert.equal(status.function?.description, "NEW-STATUS-DESC");
  assert.equal(out[0], ACP_TOOLS_OPENAI[0]);
});

test("applyAcpToolOverrides handles the responses shape (flat name + parameters)", () => {
  const out = applyAcpToolOverrides(ACP_TOOLS_RESPONSES, {
    search_context: {
      description: "NEW-SEARCH-DESC",
      paramDescriptions: { query: "NEW-QUERY" },
    },
  });
  const search = out.find((t) => t.name === "search_context");
  assert.ok(search);
  assert.equal(search.description, "NEW-SEARCH-DESC");
  const params = search.parameters as {
    properties: Record<string, { description?: string }>;
  };
  assert.equal(params.properties.query.description, "NEW-QUERY");
});

test("applyAcpToolOverrides without overrides copies the array but keeps tool references", () => {
  const out = applyAcpToolOverrides(ACP_TOOLS_ANTHROPIC);
  assert.notEqual(out, ACP_TOOLS_ANTHROPIC);
  assert.deepEqual(out, ACP_TOOLS_ANTHROPIC);
  for (let i = 0; i < out.length; i++)
    assert.equal(out[i], ACP_TOOLS_ANTHROPIC[i]);
});

test("applyAcpToolOverrides never mutates the shared tool constants", () => {
  const before = JSON.stringify(COMPRESS_TOOL);
  applyAcpToolOverrides(ACP_TOOLS_ANTHROPIC, {
    compress: {
      description: "MUTATE-ME",
      paramDescriptions: { topic: "MUTATE-ME-TOO", startId: "MUTATE-NESTED" },
    },
  });
  assert.equal(JSON.stringify(COMPRESS_TOOL), before);
});
