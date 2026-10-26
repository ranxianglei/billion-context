/**
 * Surface text configuration layer.
 *
 * The kernel classifies prompt content as load-bearing (the four {@link Prompts}
 * rules, risk-gated via resolvePrompts) or surface (section chrome, tool
 * descriptions — presentation only, safe to customize freely). This module is
 * the shared mechanism for the surface class, used by the kernel's own prompt
 * builders and by adapters (billion-context-pi, the billion-context proxy) so
 * every host exposes the same config semantics:
 *
 *   string  → replace the default text
 *   null    → remove the section
 *   omitted → keep the default
 *
 * Malformed values (wrong type) are ignored — a bad override never clobbers a
 * good default.
 */

/** Tri-state override for one named section of a system prompt. */
export type SectionOverride = string | null;

/**
 * Section keys of the kernel's compress system-prompt builders. Each builder
 * honors a subset ({@link buildCompressSystemPrompt}: acpTags/tools/
 * summariesInContext; text variant: acpTags/textProtocol/textTools; hybrid:
 * acpTags/textProtocol/functionTools). A section's text is the full section —
 * header line included.
 */
export type CompressPromptSections = {
  acpTags?: SectionOverride;
  tools?: SectionOverride;
  summariesInContext?: SectionOverride;
  textProtocol?: SectionOverride;
  textTools?: SectionOverride;
  functionTools?: SectionOverride;
  /** #2335: the two lead blocks the builders used to hardcode from
   * `prompts.*`. Tri-state like every other section so a pack can trim the
   * verbose default assembly (lean) without touching the load-bearing
   * `Prompts` rules. Default text still resolves from the passed `prompts`
   * (risk-gated via resolvePrompts), keeping no-override output
   * byte-identical. */
  philosophy?: SectionOverride;
  howToCompress?: SectionOverride;
};

/** Per-tool surface overrides. Keyed by tool name (see ACP_TOOL_NAMES). */
export interface ToolPromptOverrides {
  /** Replace the tool's description. */
  description?: string;
  /**
   * Replace parameter descriptions by property name, at any nesting depth
   * (top-level `properties` and array `items` properties).
   */
  paramDescriptions?: Record<string, string>;
}

/** Map of tool name → surface overrides. */
export type ToolPrompts = Record<string, ToolPromptOverrides>;

/**
 * Apply tri-state section overrides to an ordered list of sections. Each
 * section is a `[key, text]` pair. `string` replaces, `null` removes,
 * omitted/undefined keeps the default; unknown override keys are ignored.
 * Returns the surviving texts in original order.
 */
export function applySectionOverrides(
  sections: ReadonlyArray<readonly [string, string]>,
  overrides?: Record<string, SectionOverride>,
): string[] {
  const out: string[] = [];
  for (const [key, text] of sections) {
    const o = overrides?.[key];
    if (o === null) continue;
    out.push(typeof o === "string" ? o : text);
  }
  return out;
}

/**
 * Deep-clone a JSON-like tool parameter schema, replacing the `description` of
 * every property whose name matches an override key, at any nesting depth.
 * Returns the input unchanged when there are no overrides. Never mutates the
 * input.
 */
export function cloneWithDescriptions(
  schema: unknown,
  overrides: Record<string, string>,
): unknown {
  if (Object.keys(overrides).length === 0) return schema;
  return cloneNode(schema, overrides);
}

function cloneNode(node: unknown, overrides: Record<string, string>): unknown {
  if (Array.isArray(node))
    return node.map((item) => cloneNode(item, overrides));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const cloned = cloneNode(value, overrides);
      if (
        Object.hasOwn(overrides, name) &&
        cloned &&
        typeof cloned === "object" &&
        !Array.isArray(cloned)
      ) {
        (cloned as Record<string, unknown>).description = overrides[name];
      }
      out[name] = cloned;
    }
    return out;
  }
  return node;
}

/** Structural superset of the three ACP wire tool shapes. */
export interface AcpToolLike {
  name?: string;
  description?: string;
  input_schema?: unknown;
  parameters?: unknown;
  function?: { name: string; description?: string; parameters?: unknown };
  type?: string;
}

/**
 * Apply per-name surface overrides to ACP tool definitions. Handles the three
 * wire shapes: anthropic `{name, description, input_schema}`, openai
 * `{type, function: {name, description, parameters}}`, responses flat
 * `{type, name, description, parameters}`. Returns a new array; the shared
 * tool constants are never mutated. Tools without an override pass through by
 * reference.
 */
export function applyAcpToolOverrides<T extends AcpToolLike>(
  tools: readonly T[],
  overrides?: ToolPrompts,
): T[] {
  if (!overrides) return [...tools];
  return tools.map((tool) => {
    const name = tool.function?.name ?? tool.name;
    const ov = name ? overrides[name] : undefined;
    if (!ov) return tool;
    if (tool.function) {
      return {
        ...tool,
        function: {
          ...tool.function,
          ...(ov.description !== undefined
            ? { description: ov.description }
            : {}),
          ...(ov.paramDescriptions
            ? {
                parameters: cloneWithDescriptions(
                  tool.function.parameters,
                  ov.paramDescriptions,
                ),
              }
            : {}),
        },
      } as T;
    }
    const hasInputSchema = tool.input_schema !== undefined;
    const schema = hasInputSchema ? tool.input_schema : tool.parameters;
    return {
      ...tool,
      ...(ov.description !== undefined ? { description: ov.description } : {}),
      ...(ov.paramDescriptions
        ? hasInputSchema
          ? {
              input_schema: cloneWithDescriptions(schema, ov.paramDescriptions),
            }
          : { parameters: cloneWithDescriptions(schema, ov.paramDescriptions) }
        : {}),
    } as T;
  });
}
