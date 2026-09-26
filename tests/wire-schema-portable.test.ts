import assert from "node:assert/strict";
import test from "node:test";

import {
    BILI_ACP_TOOLS_ANTHROPIC,
    BILI_ACP_TOOLS_OPENAI,
    BILI_ACP_TOOLS_RESPONSES,
    BILI_ACP_TOOLS_GOOGLE,
} from "../src/compress-tool.js";

/**
 * Provider portability contract (#1414 / kernel #447): Copilot Gemini rejects
 * a request with `400 invalid_request_body` when any tool schema it carries
 * uses (a) a union `type` array (e.g. `type: ["array", "string"]`) or (b) an
 * `anyOf` alternative without an explicit scalar `type`. The kernel fix
 * (acp-kernel #448, released 0.0.95) replaced both with explicit typed
 * alternatives; this test walks Bili's full outgoing ACP tool surface across
 * all four wire shapes so a schema regression fails here instead of in
 * production traffic to Copilot Gemini.
 */

type SchemaNode = {
    type?: string | string[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
    anyOf?: SchemaNode[];
    [k: string]: unknown;
};

function* walk(node: SchemaNode, path: string): Generator<readonly [string, SchemaNode]> {
    yield [path, node];
    if (node.properties) {
        for (const [k, sub] of Object.entries(node.properties))
            yield* walk(sub, `${path}.properties.${k}`);
    }
    if (node.items) yield* walk(node.items, `${path}.items`);
    if (node.anyOf) {
        for (let i = 0; i < node.anyOf.length; i++)
            yield* walk(node.anyOf[i]!, `${path}.anyOf[${i}]`);
    }
}

function schemaOf(tool: {
    input_schema?: unknown;
    parameters?: unknown;
    function?: { parameters?: unknown };
}): unknown {
    return tool.input_schema ?? tool.parameters ?? tool.function?.parameters;
}

const surfaces: ReadonlyArray<readonly [string, ReadonlyArray<{ name?: string; function?: { name?: string } } | unknown>]> = [
    ["anthropic", BILI_ACP_TOOLS_ANTHROPIC as unknown as ReadonlyArray<unknown>],
    ["openai", BILI_ACP_TOOLS_OPENAI as unknown as ReadonlyArray<unknown>],
    ["responses", BILI_ACP_TOOLS_RESPONSES as unknown as ReadonlyArray<unknown>],
    ["google", BILI_ACP_TOOLS_GOOGLE as unknown as ReadonlyArray<unknown>],
];

for (const [wire, tools] of surfaces) {
    test(`#1414: every ACP tool schema on the ${wire} wire is Copilot-Gemini portable`, () => {
        assert.ok(tools.length > 0, `${wire} surface must not be empty`);
        for (const tool of tools) {
            const name =
                (tool as { name?: string }).name ??
                (tool as { function?: { name?: string } }).function?.name ??
                "?";
            const schema = schemaOf(tool as { input_schema?: unknown; parameters?: unknown }) as
                | SchemaNode
                | undefined;
            assert.ok(schema, `${wire}/${name}: expected a schema (input_schema or parameters)`);
            // Top level stays a plain object (Anthropic requirement).
            assert.equal(
                Array.isArray(schema.type) ? schema.type.join("|") : schema.type,
                "object",
                `${wire}/${name}: top-level schema must be a plain object type`,
            );
            for (const [path, node] of walk(schema, `${wire}/${name}`)) {
                if (node.type !== undefined) {
                    assert.equal(
                        typeof node.type,
                        "string",
                        `${path}: union type arrays are not portable (${JSON.stringify(node.type)})`,
                    );
                }
                if (node.anyOf) {
                    for (let i = 0; i < node.anyOf.length; i++) {
                        const alt = node.anyOf[i]!;
                        assert.ok(
                            typeof alt.type === "string" && alt.type.length > 0,
                            `${path}.anyOf[${i}]: every alternative must declare an explicit scalar type`,
                        );
                    }
                }
            }
        }
    });
}
