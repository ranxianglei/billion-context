/**
 * ACP tool surface — thin re-export from acp-kernel (Phase K1).
 *
 * The schemas, prompt builders, text tags and parseCompressInput moved to
 * acp-kernel `src/compress-tools.ts` verbatim; this module keeps the proxy's
 * historical import paths and names stable:
 *  - PROXY_TOOL_NAMES / MUTATING_PROXY_TOOLS / READONLY_PROXY_TOOLS alias the
 *    kernel's ACP_* names ("proxy" is a misnomer once shared);
 *  - parseCompressInput wires the kernel's onWarn hook into the proxy logger.
 *    (The #603 single-quote salvage lives in the kernel ladder since 0.0.59;
 *    this wrapper only surfaces its diagnostics.)
 */
import {
    parseCompressArgs,
    ABSORB_TOOL,
    ABSORB_TOOL_GOOGLE,
    ABSORB_TOOL_OPENAI,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_GOOGLE,
    DECOMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    IMAGE_FULL_TOOL,
    IMAGE_FULL_TOOL_NAME,
    IMAGE_FULL_TOOL_OPENAI,
    IMAGE_FULL_TOOL_RESPONSES,
    RETRIEVE_TOOL_NAME,
    RULE_TOOL_NAME,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_GOOGLE,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL_NAME,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_GOOGLE,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_RESPONSES,
    ACP_READONLY_TOOLS_RESPONSES,
    ACP_TEXT_OPEN,
    ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN,
    ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN,
    ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN,
    ACP_DECOMPRESS_CLOSE,
    buildCompressSystemPrompt,
    buildCompressHybridSystemPrompt,
    COMPRESS_TOOL,
    COMPRESS_TOOL_GOOGLE,
    COMPRESS_TOOL_NAME,
    COMPRESS_TOOL_OPENAI,
    COMPRESS_TOOL_RESPONSES,
    defaultPrompts,
} from "acp-kernel";
import type { CompressPromptSections, Prompts, SectionOverride } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { maxShrinkPerCompress } from "./fetch-util.js";
import { EXTERNAL_SUMMARY_NOTE } from "./external-summary-surface.js";

export {
    COMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_NAME,
    SEARCH_CONTEXT_TOOL_NAME,
    ACP_STATUS_TOOL_NAME,
    ACP_TEXT_OPEN,
    ACP_TEXT_CLOSE,
    ACP_STATUS_OPEN,
    ACP_STATUS_CLOSE,
    ACP_SEARCH_OPEN,
    ACP_SEARCH_CLOSE,
    ACP_DECOMPRESS_OPEN,
    ACP_DECOMPRESS_CLOSE,
    COMPRESS_TOOL,
    COMPRESS_TOOL_OPENAI,
    COMPRESS_TOOL_RESPONSES,
    COMPRESS_TOOL_GOOGLE,
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
    DECOMPRESS_TOOL_GOOGLE,
    SEARCH_CONTEXT_TOOL,
    SEARCH_CONTEXT_TOOL_OPENAI,
    SEARCH_CONTEXT_TOOL_RESPONSES,
    SEARCH_CONTEXT_TOOL_GOOGLE,
    ACP_STATUS_TOOL,
    ACP_STATUS_TOOL_OPENAI,
    ACP_STATUS_TOOL_RESPONSES,
    ACP_STATUS_TOOL_GOOGLE,
    ACP_TOOLS_OPENAI,
    ACP_TOOLS_ANTHROPIC,
    ACP_TOOLS_RESPONSES,
    ACP_TOOLS_GOOGLE,
    ACP_READONLY_TOOLS_RESPONSES,
    buildCompressSystemPrompt,
    buildCompressTextSystemPrompt,
    buildCompressHybridSystemPrompt,
    ABSORB_TOOL_NAME,
    ABSORB_TOOL,
    ABSORB_TOOL_OPENAI,
    ABSORB_TOOL_GOOGLE,
    buildAbsorbSystemPrompt,
    RULE_TOOL_NAME,
} from "acp-kernel";
export type { ParsedRange, AbsorbConfig } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

// #1881: the ACP-TAGS NEVER-echo prohibition must not disappear with injectTool.
// renderTags runs independent of injectTool — tags keep being rendered into history,
// so removing the whole compress prompt when the tool is off removes the only
// constraint keeping the model from echoing tags ("the more you switch off, the more
// it leaks"). This extracts just the kernel-owned acpTags section: philosophy/rules/
// tools describe compression mechanics that do not exist without the tool.
const NON_ACP_TAGS_SECTIONS = {
    function: ["tools", "summariesInContext"],
    hybrid: ["textProtocol", "functionTools"],
} as const;

/** #2335: resolve one lead block exactly like the kernel's applySectionOverrides
 * does — null drops it, a string replaces it, undefined keeps the default. */
function effectiveLeadSection(override: SectionOverride | undefined, fallback: string): string | null {
    return override === null ? null : override ?? fallback;
}

export function buildAcpTagsOnlyPrompt(
    family: keyof typeof NON_ACP_TAGS_SECTIONS,
    prompts?: Prompts,
    sections?: CompressPromptSections,
): string {
    const p = prompts ?? defaultPrompts;
    const overrides: CompressPromptSections = { ...(sections ?? {}) };
    for (const key of NON_ACP_TAGS_SECTIONS[family]) overrides[key] = null;
    // The builder joins [philosophy?, rules?, ...sections] with "\n\n" and a null
    // override omits its element entirely, so everything after the lead prefix is
    // exactly the acpTags section (kernel default or user override). Since #2335
    // the two lead blocks are pack-overridable — lean nulls philosophy and swaps
    // rules — so the prefix must be computed from the EFFECTIVE sections; the old
    // hardcoded prompts.* prefix made the guard fail for any trimming pack and
    // silently dropped the whole ACP-TAGS prompt (injectTool=false + lean). The
    // startsWith guard still fails safe to "" (no injection) if the kernel ever
    // changes the builder's structure instead of slicing garbage into every prompt.
    const lead: string[] = [];
    for (const eff of [
        effectiveLeadSection(overrides.philosophy, p.compressPhilosophy),
        effectiveLeadSection(overrides.howToCompress, p.howToCompressRules),
    ]) if (eff !== null) lead.push(eff);
    const prefix = lead.length > 0 ? `${lead.join("\n\n")}\n\n` : "";
    const full = family === "hybrid"
        ? buildCompressHybridSystemPrompt(p, overrides)
        : buildCompressSystemPrompt(p, overrides);
    if (!full.startsWith(prefix)) return "";
    return full.slice(prefix.length);
}

// #1685 zero-injection identity: search_context's host-side
// conversation_id extension (#841/#760) is REMOVED — the model never sees a
// conversation id anymore, so it cannot cite one. Cross-session search keeps
// working for hosts that pass a target id out-of-band; the schema the model
// sees is the kernel constant, verbatim. The BILI_ copies stay as the
// served-shape anchor the wire-contract golden test pins.
type JsonSchemaObject = { type: string; properties?: Record<string, unknown>; required?: string[] };

export const BILI_SEARCH_CONTEXT_TOOL = {
    name: SEARCH_CONTEXT_TOOL.name,
    description: SEARCH_CONTEXT_TOOL.description,
    input_schema: SEARCH_CONTEXT_TOOL.input_schema as JsonSchemaObject,
};

export const BILI_SEARCH_CONTEXT_TOOL_OPENAI = {
    type: "function" as const,
    function: {
        name: SEARCH_CONTEXT_TOOL_OPENAI.function.name,
        description: SEARCH_CONTEXT_TOOL_OPENAI.function.description,
        parameters: SEARCH_CONTEXT_TOOL_OPENAI.function.parameters as JsonSchemaObject,
    },
};

export const BILI_SEARCH_CONTEXT_TOOL_RESPONSES = {
    type: "function" as const,
    name: SEARCH_CONTEXT_TOOL_RESPONSES.name,
    description: SEARCH_CONTEXT_TOOL_RESPONSES.description,
    parameters: SEARCH_CONTEXT_TOOL_RESPONSES.parameters as JsonSchemaObject,
};

export const BILI_SEARCH_CONTEXT_TOOL_GOOGLE = {
    name: SEARCH_CONTEXT_TOOL_GOOGLE.name,
    description: SEARCH_CONTEXT_TOOL_GOOGLE.description,
    parameters: SEARCH_CONTEXT_TOOL_GOOGLE.parameters as JsonSchemaObject,
};

// #1179 CCR v2: host-side range-restore extension of decompress. Optional
// startId/endId (mNNNNN refs) restore only the block's messages inside that
// span instead of the whole block. Execution is gated on CCR being armed for
// the session (resolveDecompressRange fails explicitly when it is not), so
// the params are advertised ONLY where they can work (#1712): proxy-lane wire
// injection serves the *_NO_RANGE variant while the session is unarmed, and
// the plugin manifest serves them only when the base config enables CCR
// (plugin policy is the base block verbatim, #1345) — same conservative rule
// as acp_retrieve/absorb/rule in handlePluginManifest (#1192/#1271). Blank or
// whitespace values are treated as omitted at execution (whole-block restore).
const DECOMPRESS_RANGE_PARAM_START = {
    type: "string",
    description: "Optional mNNNNN message ref, inclusive lower bound of a sub-range of this block. With endId, restores only that span instead of the whole block (requires CCR: compress.ccr.enabled). Omit both to restore the whole block; empty values count as omitted.",
};
const DECOMPRESS_RANGE_PARAM_END = {
    type: "string",
    description: "Optional mNNNNN message ref, inclusive upper bound. Used together with startId; omit both to restore the whole block.",
};

function withRangeParams(schema: JsonSchemaObject): JsonSchemaObject {
    return { ...schema, properties: { ...schema.properties, startId: DECOMPRESS_RANGE_PARAM_START, endId: DECOMPRESS_RANGE_PARAM_END } };
}

// #1995: image-recovery extension of decompress. An optional imageRef (an mNNNNN
// ref, or "list") restores a stripped/folded image's original pixels to a
// host-readable file. It is independent of blockId/range AND of CCR, so — unlike
// startId/endId (#1712, which are advertised only where CCR can arm them) — it is
// offered in EVERY decompress variant, range and no-range alike.
const DECOMPRESS_IMAGE_PARAM = {
    type: "string",
    description: "Optional mNNNNN message ref whose IMAGE payload you want restored (an image that was stripped or folded away). Pass \"list\" to enumerate every image currently restorable. Restored images are written to host-readable files and their paths returned — open them with the read tool. Independent of blockId/range and of CCR.",
};
const DECOMPRESS_IMAGE_NOTE = " Pass imageRef (an mNNNNN ref) to restore a stripped/folded image's original pixels to a file you open with the read tool; imageRef:\"list\" shows what is restorable.";
function withImageRestoreParam(schema: JsonSchemaObject): JsonSchemaObject {
    return { ...schema, properties: { ...schema.properties, imageRef: DECOMPRESS_IMAGE_PARAM } };
}

export const BILI_DECOMPRESS_TOOL = { name: DECOMPRESS_TOOL.name, description: DECOMPRESS_TOOL.description + DECOMPRESS_IMAGE_NOTE, input_schema: withImageRestoreParam(withRangeParams(DECOMPRESS_TOOL.input_schema)) };
export const BILI_DECOMPRESS_TOOL_OPENAI = { type: "function" as const, function: { name: DECOMPRESS_TOOL_OPENAI.function.name, description: DECOMPRESS_TOOL_OPENAI.function.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(withRangeParams(DECOMPRESS_TOOL_OPENAI.function.parameters)) } };
export const BILI_DECOMPRESS_TOOL_RESPONSES = { type: "function" as const, name: DECOMPRESS_TOOL_RESPONSES.name, description: DECOMPRESS_TOOL_RESPONSES.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(withRangeParams(DECOMPRESS_TOOL_RESPONSES.parameters)) };
export const BILI_DECOMPRESS_TOOL_GOOGLE = { name: DECOMPRESS_TOOL_GOOGLE.name, description: DECOMPRESS_TOOL_GOOGLE.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(withRangeParams(DECOMPRESS_TOOL_GOOGLE.parameters)) };

// #2579: the kernel-default compress surface wording framed the string form as
// "plain text … no JSON structure, no escaping" with UNQUOTED ref-header
// examples ('m00150–m00220 optional topic'). DeepSeek-class models then
// streamed content values that are not valid JSON — ~4% of compress calls on
// DSH desktop: bare unquoted values with real newlines, or unescaped quotes /
// newlines inside quoted strings — and strict clients reject the tool input at
// message_stop, failing the WHOLE turn before any host-side salvage can run.
// The served surface now states the serialization contract explicitly: strict-
// JSON parsing, object-array PREFERRED, every string quoted with internal \"
// and \n escaped. The schema is untouched (anyOf array|string stays); only the
// description text changes. The kernel defaults keep their own text until the
// in-repo kernel lands the same change (tracked separately per Kernel
// Boundary); these wrappers override exactly like the decompress extensions
// above and feed BOTH lanes (wire injection via injectOpenaiTool & co, and the
// plugin manifest → MCP tools/list).
const COMPRESS_TOOL_DESCRIPTION_FIXED = `Replace consumed conversation ranges with self-contained summaries you write, identified by their refs. Your arguments are parsed as STRICT JSON before anything runs — an unquoted value, or an unescaped quote/newline inside any string, fails the whole call. PREFERRED form: content = an array of objects, one entry per range: {"content":[{"startId":"m00122","endId":"m00127","summary":"...","topic":"..."}]}. Also accepted: content = ONE string holding ALL ranges — each block starts with its m00150–m00220 optional-topic header line followed by that block's summary markdown — but that value is STILL a quoted JSON string (header lines and markdown inside the quotes, internal double quotes written \\", newlines written \\n); and a flat single-range call {startId,endId,summary,topic?} without content. Batch multiple ranges into ONE call — do not split into one call per range. Use when content is genuinely consumed. REQUIRED — compress without content or flat range fields is invalid.`;
const COMPRESS_CONTENT_PARAM_FIXED = `One or more ranges to compress into separate summary blocks. A valid JSON value: EITHER an array (PREFERRED) of {startId,endId,summary,topic?} entries — one per range — OR ONE string holding ALL ranges (each block: its mNNNNN–mNNNNN optional-topic header line, then its summary markdown). The strict JSON rule applies to both forms: every string is wrapped in double quotes, and inside any string a double quote is written \\" and a newline is written \\n — in the ONE-string form the header lines and markdown sit INSIDE that single quoted value. Batch multiple ranges into ONE call. REQUIRED unless the flat single-range form is used.`;
const COMPRESS_LINE_FORM_ITEM_FIXED = `Line form (a string entry inside the content array): first line 'm00150–m00220 optional topic', remaining lines the summary markdown — the entry is still a quoted JSON string value: internal double quotes written \\", newlines written \\n. A single string may carry MULTIPLE ranges — each block starts with its own refs header line`;
const COMPRESS_CONTENT_PARAM_GOOGLE_FIXED = `One or more ranges to compress into separate summary blocks — an array of {startId,endId,summary,topic?}, one entry per range. Your arguments are parsed as strict JSON: every string is wrapped in double quotes, and inside any string a double quote is written \\" and a newline is written \\n. A JSON-encoded string of that array is also accepted (the same escaping rules apply inside it). REQUIRED — compress without content is invalid.`;

type SchemaNode = { type?: string; description?: string; properties?: Record<string, SchemaNode>; items?: SchemaNode; anyOf?: SchemaNode[]; required?: string[] };

function patchCompressParams(source: unknown): JsonSchemaObject {
    const s = JSON.parse(JSON.stringify(source)) as SchemaNode;
    const content = s.properties?.["content"];
    if (content) {
        content.description = COMPRESS_CONTENT_PARAM_FIXED;
        for (const branch of content.anyOf ?? []) {
            for (const alt of branch.items?.anyOf ?? []) {
                if (alt.type === "string" && alt.description?.startsWith("Line form")) alt.description = COMPRESS_LINE_FORM_ITEM_FIXED;
            }
        }
    }
    return s as JsonSchemaObject;
}

function patchGoogleCompressParams(source: unknown): JsonSchemaObject {
    const s = JSON.parse(JSON.stringify(source)) as SchemaNode;
    if (s.properties?.["content"]) s.properties["content"].description = COMPRESS_CONTENT_PARAM_GOOGLE_FIXED;
    return s as JsonSchemaObject;
}

const BILI_COMPRESS_TOOL = { name: COMPRESS_TOOL.name, description: COMPRESS_TOOL_DESCRIPTION_FIXED, input_schema: patchCompressParams(COMPRESS_TOOL.input_schema) };
export const BILI_COMPRESS_TOOL_OPENAI = { type: "function" as const, function: { name: COMPRESS_TOOL_OPENAI.function.name, description: COMPRESS_TOOL_DESCRIPTION_FIXED, parameters: patchCompressParams(COMPRESS_TOOL_OPENAI.function.parameters) } };
const BILI_COMPRESS_TOOL_RESPONSES = { type: "function" as const, name: COMPRESS_TOOL_RESPONSES.name, description: COMPRESS_TOOL_DESCRIPTION_FIXED, parameters: patchCompressParams(COMPRESS_TOOL_RESPONSES.parameters) };
const BILI_COMPRESS_TOOL_GOOGLE = { name: COMPRESS_TOOL_GOOGLE.name, description: COMPRESS_TOOL_DESCRIPTION_FIXED, parameters: patchGoogleCompressParams(COMPRESS_TOOL_GOOGLE.parameters) };

// #2579 companion note, appended to every rendered nudge (and the post-compress
// tail that lists remaining ranges) — the moment the model acts on a nudge is
// when the malformed-JSON calls happened, and the kernel-rendered nudge text
// still carries the "plain string … header line" framing until the kernel
// defaults change. Byte-stable constant (no dynamic values).
export const COMPRESS_JSON_NOTE = `

[JSON validity: your compress arguments are parsed as strict JSON before anything runs — an unquoted content value, or an unescaped quote/newline inside ANY string, fails the whole turn. Prefer content as an OBJECT ARRAY ({"content":[{"startId":"m00122","endId":"m00127","summary":"..."}]}) — short strings, fixed structure — or as ONE quoted string in which the mNNNNN–mNNNNN header lines and markdown sit INSIDE the quotes, internal double quotes written \\", newlines written \\n.]`;

/** Append the #2579 JSON-validity reminder to rendered nudge text. */
export function withCompressJsonNote(text: string): string {
    return text + COMPRESS_JSON_NOTE;
}

export const BILI_ACP_TOOLS_ANTHROPIC = ACP_TOOLS_ANTHROPIC.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL : t));
export const BILI_ACP_TOOLS_OPENAI = ACP_TOOLS_OPENAI.map((t) => (t.function.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_OPENAI : t.function.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_OPENAI : t.function.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_OPENAI : t));
export const BILI_ACP_TOOLS_RESPONSES = ACP_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_RESPONSES : t));
export const BILI_ACP_TOOLS_GOOGLE = ACP_TOOLS_GOOGLE.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_GOOGLE : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_GOOGLE : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_GOOGLE : t));

// #1712: no-range variants — identical except decompress lacks startId/endId.
// Served where range restore cannot be armed so the advertised schema never
// offers what execution will refuse (see the #1179 note above). Image recovery
// still applies here (it does not require CCR), so these keep imageRef.
const BILI_DECOMPRESS_IMG_ANTHROPIC = { name: DECOMPRESS_TOOL.name, description: DECOMPRESS_TOOL.description + DECOMPRESS_IMAGE_NOTE, input_schema: withImageRestoreParam(DECOMPRESS_TOOL.input_schema) };
const BILI_DECOMPRESS_IMG_OPENAI = { type: "function" as const, function: { name: DECOMPRESS_TOOL_OPENAI.function.name, description: DECOMPRESS_TOOL_OPENAI.function.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_OPENAI.function.parameters) } };
const BILI_DECOMPRESS_IMG_RESPONSES = { type: "function" as const, name: DECOMPRESS_TOOL_RESPONSES.name, description: DECOMPRESS_TOOL_RESPONSES.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_RESPONSES.parameters) };
const BILI_DECOMPRESS_IMG_GOOGLE = { name: DECOMPRESS_TOOL_GOOGLE.name, description: DECOMPRESS_TOOL_GOOGLE.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_GOOGLE.parameters) };
export const BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE = ACP_TOOLS_ANTHROPIC.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_ANTHROPIC : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL : t));
export const BILI_ACP_TOOLS_OPENAI_NO_RANGE = ACP_TOOLS_OPENAI.map((t) => (t.function.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_OPENAI : t.function.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_OPENAI : t.function.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_OPENAI : t));
export const BILI_ACP_TOOLS_RESPONSES_NO_RANGE = ACP_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_RESPONSES : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_RESPONSES : t));
export const BILI_ACP_TOOLS_GOOGLE_NO_RANGE = ACP_TOOLS_GOOGLE.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_GOOGLE : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_GOOGLE : t.name === COMPRESS_TOOL_NAME ? BILI_COMPRESS_TOOL_GOOGLE : t));
export const BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE = ACP_READONLY_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_RESPONSES : t));
export const BILI_ACP_READONLY_TOOLS_RESPONSES = ACP_READONLY_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t));

// The kernel ships no Responses-format absorb const (the four ACP tools have
// *_RESPONSES variants; absorb is host-registered opt-in). Synthesize it in
// the same flat shape as SEARCH_CONTEXT_TOOL_RESPONSES.
export const ABSORB_TOOL_RESPONSES = {
    type: "function",
    name: ABSORB_TOOL_OPENAI.function.name,
    description: ABSORB_TOOL_OPENAI.function.description,
    parameters: ABSORB_TOOL_OPENAI.function.parameters,
};

// #1359: absorb wire shapes parameterized by name so registration (manifest +
// per-request injection) follows the resolved `absorb.toolName` in BOTH lanes —
// a renamed tool must be advertised, injected, and adjudicated under one name.
// At the default name this is byte-identical to the static consts above.
export function absorbToolsFor(name: string) {
    return {
        anthropic: { name, description: ABSORB_TOOL.description, input_schema: ABSORB_TOOL.input_schema },
        openai: { type: "function" as const, function: { name, description: ABSORB_TOOL_OPENAI.function.description, parameters: ABSORB_TOOL_OPENAI.function.parameters } },
        responses: { type: "function" as const, name, description: ABSORB_TOOL_OPENAI.function.description, parameters: ABSORB_TOOL_OPENAI.function.parameters },
        google: { name, description: ABSORB_TOOL_GOOGLE.description, parameters: ABSORB_TOOL_GOOGLE.parameters },
    };
}

// The reconciled kernel (acp-kernel#332) ships RULE_TOOL_NAME + the rule state
// helpers but no wire tool objects. Synthesize all four wire shapes here so
// every injection point (wire helpers, plugin manifest) serves one definition.
const RULE_TOOL_DESCRIPTION = "Record a short, principle-level reminder so it survives context compression — the call and its result are protected and stay in context. Record when: the user calls out or repeatedly emphasizes a lesson; the user asks you to remember or follow a behavior; you personally hit a major pitfall worth remembering long-term. Keep each rule to one short line. Omit the rule argument to list recorded rules. To remove a recorded rule pass delete with its id (e.g. \"rule3\"); to remove every recorded rule pass clear: true. delete and clear are mutually exclusive with each other and with rule — use one operation per call.";
const RULE_PARAM_SCHEMA = {
    type: "object",
    properties: {
        rule: { type: "string", description: "Short principle-level reminder to record. Omit to list recorded rules." },
        delete: { type: "string", description: "Id of a recorded rule to remove (e.g. \"rule3\"). Mutually exclusive with rule and clear." },
        clear: { type: "boolean", description: "Remove every recorded rule at once. Mutually exclusive with rule and delete." },
    },
};
export const RULE_TOOL = { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, input_schema: RULE_PARAM_SCHEMA };
export const RULE_TOOL_OPENAI = { type: "function" as const, function: { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA } };
export const RULE_TOOL_RESPONSES = { type: "function" as const, name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA };
export const RULE_TOOL_GOOGLE = { name: RULE_TOOL_NAME, description: RULE_TOOL_DESCRIPTION, parameters: RULE_PARAM_SCHEMA };

// #1097: acp_retrieve — resolve a stored ID-referenced message back to its full
// original. Kernel-owned tool (RETRIEVE_TOOL_NAME); synthesized in all four
// wire shapes here so every injection point (wire helpers, plugin manifest)
// serves one definition. Takes a single `ref` (the mNNNNN id printed in the
// [acp-stored] placeholder). Read-only with respect to context: the fetched content
// rides the ephemeral tool-result channel and consumes no message ref.
const RETRIEVE_TOOL_DESCRIPTION = "Retrieve the full original text of a stored message by its id. Large tool results are replaced on the wire with a placeholder shaped like \"📦 [acp-stored #m00423 · shell output · 4,213 tok] `npm run build`\n   → acp_retrieve(\"m00423\") returns the full text\". Call this with that ref to read the complete original back into context. Leaving the placeholder costs nothing; retrieving costs one call — fetch only when the detail matters to the current step.";
const RETRIEVE_PARAM_SCHEMA = {
    type: "object" as const,
    properties: {
        ref: { type: "string", description: "The stored message id to retrieve (an mNNNNN ref from an [acp-stored] placeholder)." },
    },
    required: ["ref"],
};
export { RETRIEVE_TOOL_NAME };
/** Wire tool shapes for the retrieve tool; name follows the session's resolved
 *  `ccr.toolName` (default acp_retrieve) so registration, dispatch, and the
 *  kernel placeholder hint all agree. */
export function retrieveToolsFor(name: string) {
    return {
        anthropic: { name, description: RETRIEVE_TOOL_DESCRIPTION, input_schema: RETRIEVE_PARAM_SCHEMA },
        openai: { type: "function" as const, function: { name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA } },
        responses: { type: "function" as const, name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA },
        google: { name, description: RETRIEVE_TOOL_DESCRIPTION, parameters: RETRIEVE_PARAM_SCHEMA },
    };
}

// #1095: image_full (restore original-resolution images for a previously
// downscaled message). Kernel-owned tool; the kernel ships anthropic/openai/
// responses shapes — synthesize the missing Google variant in its flat shape
// so every injection point serves one definition.
export { IMAGE_FULL_TOOL, IMAGE_FULL_TOOL_OPENAI, IMAGE_FULL_TOOL_RESPONSES };
export const IMAGE_FULL_TOOL_GOOGLE = {
    name: IMAGE_FULL_TOOL_OPENAI.function.name,
    description: IMAGE_FULL_TOOL_OPENAI.function.description,
    parameters: IMAGE_FULL_TOOL_OPENAI.function.parameters,
};

// #1494: models drift off the advertised {content: [...]} schema when they
// retry a single range: `content` becomes the single entry OBJECT instead of a
// one-element array (kernel hard-rejects it: kind=content-not-array,
// dropped=0), the whole argument becomes a bare entry array (kind=not-object),
// or the same shapes arrive string-encoded through a chat wire. The kernel's
// salvage ladder already tolerates this drift at the TOP level (a bare
// {startId,…} without content is accepted as one range) but hard-rejects it
// INSIDE content — an asymmetric wall that turns one shape slip into a full
// call failure plus a wasted retry round. Normalize those shapes back to
// canonical {content:[…]} before the kernel sees them; everything else passes
// through untouched.
function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeRangeEntry(o: Record<string, unknown>): boolean {
    const hasStart = typeof o["startId"] === "string" || typeof o["startRef"] === "string" || typeof o["messageId"] === "string";
    const hasEnd = typeof o["endId"] === "string" || typeof o["endRef"] === "string" || typeof o["messageId"] === "string";
    return hasStart && hasEnd && typeof o["summary"] === "string";
}

function decodeCompressObject(raw: string): Record<string, unknown> | undefined {
    let s = raw.trim();
    if (s.startsWith("```")) {
        const nl = s.indexOf("\n");
        if (nl === -1) return undefined;
        const body = s.slice(nl + 1);
        const end = body.lastIndexOf("```");
        s = (end > 0 ? body.slice(0, end) : body).trim();
    }
    let v: unknown;
    try { v = JSON.parse(s); } catch { return undefined; }
    if (typeof v === "string") {
        try { v = JSON.parse(v); } catch { return undefined; }
    }
    return isPlainObject(v) ? v : undefined;
}

export function normalizeCompressInput(input: unknown): unknown {
    if (Array.isArray(input)) return { content: input };
    if (isPlainObject(input)) {
        const c = input["content"];
        if (isPlainObject(c)) return { ...input, content: [c] };
        return input;
    }
    if (typeof input === "string") {
        const obj = decodeCompressObject(input);
        if (!obj) return input;
        const c = obj["content"];
        if (isPlainObject(c)) return { ...obj, content: [c] };
        if (looksLikeRangeEntry(obj)) return { content: [obj] };
        return input;
    }
    return input;
}

export function parseCompressInput(input: unknown, callId?: string) {
    const parsed = parseCompressArgs(normalizeCompressInput(input), { callId });
    if (parsed.diagnostics.quoteSalvage === true) {
        loggerLog("warn", `[acp-compress-input] quote-salvage: recovered ${parsed.ranges.length} range(s) after single->double quote normalization (kind=${parsed.diagnostics.kind})`);
    }
    if (!parsed.diagnostics.ok && parsed.diagnostics.kind !== "ok") {
        loggerLog("warn", `[acp-compress-input] rejected: kind=${parsed.diagnostics.kind} invalidItems=${parsed.diagnostics.invalidItems}${parsed.diagnostics.keys ? ` keys=[${parsed.diagnostics.keys.join(",")}]` : ""}${parsed.diagnostics.length !== undefined ? ` len=${parsed.diagnostics.length}` : ""}${parsed.diagnostics.invalidReasons && parsed.diagnostics.invalidReasons.length > 0 ? ` reasons=[${parsed.diagnostics.invalidReasons.join(" | ")}]` : ""}`);
    } else if (parsed.diagnostics.invalidItems > 0 || parsed.diagnostics.kind === "truncated") {
        // #1494: partial drop — at least one range survived, so the old
        // condition above never fired and the rejection was invisible on both
        // the server log and the model-facing receipt. #1495: kind="truncated"
        // (gateway-stringified + cut content array) salvages the complete
        // leading entries and reports the same way — often with invalidItems=0,
        // so it needs the explicit kind arm.
        loggerLog("warn", `[acp-compress-input] partial: ${parsed.ranges.length} range(s) applied, ${parsed.diagnostics.invalidItems} rejected (kind=${parsed.diagnostics.kind}) reasons=[${(parsed.diagnostics.invalidReasons ?? []).join(" | ")}]`);
    }
    return { ranges: parsed.ranges, diagnostics: parsed.diagnostics };
}

// #1439: shared by the streaming Responses adapter AND the non-streaming JSON
// loop so both recognize the same triggers — a private copy in one path drifted.
interface ResponsesTextTriggerCall {
    name: string;
    callId: string;
    arguments: string;
}
export function extractResponsesTextTriggers(
    text: string,
): { clean: string; calls: ResponsesTextTriggerCall[] } {
    const calls: ResponsesTextTriggerCall[] = [];
    let clean = text;
    let hadTrigger = false;
    const triggers = [
        { name: "compress", open: ACP_TEXT_OPEN, close: ACP_TEXT_CLOSE, requirePayload: true },
        { name: "acp_status", open: ACP_STATUS_OPEN, close: ACP_STATUS_CLOSE, requirePayload: false },
        { name: "search_context", open: ACP_SEARCH_OPEN, close: ACP_SEARCH_CLOSE, requirePayload: true },
        { name: "decompress", open: ACP_DECOMPRESS_OPEN, close: ACP_DECOMPRESS_CLOSE, requirePayload: true },
    ];
    for (const t of triggers) {
        let start = clean.indexOf(t.open);
        while (start >= 0) {
            const end = clean.indexOf(t.close, start + t.open.length);
            if (end < 0) break;
            hadTrigger = true;
            const payload = clean.slice(start + t.open.length, end).trim();
            if (payload.length > 0 || !t.requirePayload) {
                const stamp = `${Date.now()}-${calls.length}`;
                calls.push({ name: t.name, callId: `call_text_${stamp}`, arguments: payload.length > 0 ? payload : "{}" });
            }
            clean = clean.slice(0, start) + clean.slice(end + t.close.length);
            start = clean.indexOf(t.open);
        }
    }
    return { clean: hadTrigger ? clean : text, calls };
}

// #189 staged-compression / prefix-survival guidance, appended to the nudge
// text ONLY when BILI_MAX_SHRINK_PER_COMPRESS is set (the "smooth transition"
// switch). It steers the model — at the moment it is choosing the range —
// toward smaller, tail-biased folds so the stable prefix (m00001..foldPoint)
// survives for prefix caching and each round's request-shape change stays
// gentle (the sharp change is what trips provider risk-control, GLM 3007).
const STAGED_COMPRESS_GUIDANCE =
    "\n\n[Smooth-transition guidance: when you compress, prefer a SMALLER, TAIL-biased range — compress the most recent large content and keep the stable prefix (the earliest messages) intact. A large single rewrite changes the request shape sharply and can trip provider risk-control; smaller tail-biased folds keep the prefix cache alive and the transition gentle.]";

/** Append the staged-compress guidance to a rendered nudge text. Returns the
 *  input unchanged when the smooth-transition switch is off (default). */
export function withStagedCompressGuidance(text: string): string {
    if (maxShrinkPerCompress() === undefined) return text;
    return text + STAGED_COMPRESS_GUIDANCE;
}

// #2326 first-sight mass digestion. When a host hands bili a pre-inflated
// history (dsh plugin mode after its own digestion, CLI hand-off, resumed
// rollout), the first requests see a large ready mass with zero growth
// baseline: the kernel marks those nudges " [first-sight mass]" and re-arms
// after every SUCCESSFUL fold, so the backlog gets folded one small call per
// request. Each front-positioned fold rewrites the request prefix, so every
// piecemeal landing re-pays the ENTIRE remaining tail to the prefix cache —
// measured 2.29x/tok re-pay for a 5-fold cascade vs 0.032x/tok for one big
// fold (issue log: eb985b31 vs 5c5c26d1, ~70x). This note tells the model,
// at the moment of the nudge, that the ranges are a pre-existing backlog to
// drain in ONE batched call — split oversized spans into multiple ranges at
// logical boundaries (each under its per-summary cap, per the budget note
// above) but submit them ALL together in the same call — instead of piecemeal
// front folds. It deliberately REPLACES withStagedCompressGuidance during
// digestion: the smooth-transition note (smaller, tail-biased, keep the
// prefix intact) is exactly wrong for a backlog that must be drained. The
// closing precedence sentence keeps it correct on #2228 decide-directive
// injections, whose stock text pins ONE span. Byte-stable constants (like
// the notes above) so the prefix-cache anchor stays intact.
const FIRST_SIGHT_DRAIN_NOTE =
    "\n\n[First-sight digestion: the compressible ranges above are a pre-existing backlog this session arrived with, not growth from your current task. Drain the backlog in ONE batched compress call — cover EVERY ready range, splitting oversized spans into multiple smaller ranges at logical boundaries (each summary within its cap), and submit them all together in the same call (content: [{startId,endId,summary}, {…}]). Do NOT fold piecemeal across turns: every small front fold re-bills the whole remaining tail to the prefix cache, while one batched call lands once. Keep draining while the nudge repeats — it stops when the backlog is gone. Where this conflicts with a single-span directive above, this takes precedence: the cited span is the starting point of the batch, not its limit.]";
const FIRST_SIGHT_DRAIN_NOTE_EXTERNAL =
    "\n\n[First-sight digestion: the compressible ranges above are a pre-existing backlog this session arrived with, not growth from your current task. The independent summary service writes the summaries — you only select the ranges (plus optional topic hints), so your own response-length budget is not a limit here. Drain the backlog in ONE batched compress call — cover EVERY ready range, splitting oversized spans into multiple smaller ranges at logical boundaries, and submit them all together in the same call (content: [{startId,endId,summary}, {…}]). Do NOT fold piecemeal across turns: every small front fold re-bills the whole remaining tail to the prefix cache, while one batched call lands once. Keep draining while the nudge repeats — it stops when the backlog is gone. Where this conflicts with a single-span directive above, this takes precedence: the cited span is the starting point of the batch, not its limit.]";

/** True when the kernel flagged the nudge reason with the first-sight mass
 *  marker (kernel/src/compress.ts appends " [first-sight mass]" while a
 *  pre-inflated backlog is still being digested — the marker re-rides every
 *  re-armed nudge until the mass drops below the growth floor). */
export function firstSightDrainActive(reason: string | undefined): boolean {
    return reason !== undefined && reason.includes("[first-sight mass]");
}

/** Nudge range guidance, first-sight aware (#2326): during first-sight mass
 *  digestion append the batched-drain note (and drop the smooth-transition
 *  note, which would steer the opposite direction); otherwise behave exactly
 *  like withStagedCompressGuidance. */
export function withFirstSightDrain(text: string, reason: string | undefined, external: boolean): string {
    if (!firstSightDrainActive(reason)) return withStagedCompressGuidance(text);
    return text + (external ? FIRST_SIGHT_DRAIN_NOTE_EXTERNAL : FIRST_SIGHT_DRAIN_NOTE);
}

// #717 anti-forgery rule for ACP confirmation markers. Under sustained
// context pressure a model was observed writing the proxy's own marker format
// ("📦 [ACP] Compressed …") as plain assistant text — 17 fake compressions,
// none reaching the proxy, usage climbing to 89% while the model believed
// compression was working. The rule states the marker contract explicitly and
// is appended to every nudge (the moment of highest temptation) and to the
// injected philosophy prompt (persistent; byte-stable constant, so
// prefix-cache safe). #862 added the silence clause: in that deployment the
// model also NARRATED around genuine proxy executions — its own marker-style
// confirmation lines plus preambles/summaries (incl. non-English commentary)
// before and after each real compression.
const MARKER_INTEGRITY_NOTE =
    "\n\n[ACP marker integrity: lines shaped like '📦 [ACP] Compressed …' or '❌ [ACP] … FAILED' are CONFIRMATION MARKERS emitted by the bili proxy itself, right after it executes a compress/decompress/search_context/acp_status call. They are not something you write. NEVER emit such a line as your own text — writing one fakes a state change that did not happen, and the proxy strips it. To compress, call the compress tool. To verify a compression landed, call acp_status and confirm the block count increased — a confirmation line you wrote yourself proves nothing.";
const MARKER_SILENCE_CLAUSE =
    " Execute these calls silently: no announcement or preamble before the call, and no completion summary, status line, or marker-style line after it — when the tool returns, continue the task directly as if the call had not happened.]";

/** Append the marker-integrity rule to a nudge or system-prompt text.
 *  The anti-forgery segment is unconditional (unlike withStagedCompressGuidance):
 *  the rule must hold in every configuration where a marker can be seen in
 *  history. The #862 silence clause rides along only while markers are
 *  visible (#913): with compress.visibilityMarkers=false the client never
 *  sees a marker, so there is nothing to imitate or narrate around, and the
 *  clause is dropped. */
export function withMarkerIntegrityNote(text: string, visibilityMarkers = true): string {
    return text + MARKER_INTEGRITY_NOTE + (visibilityMarkers ? MARKER_SILENCE_CLAUSE : "");
}

// #888 per-summary length budget. acp-kernel rejects a compress call atomically
// when ANY single range's summary exceeds compress.maxSummaryLength (default
// 20000 chars) — "Summary too long (…)". Under dense workloads (many subagent
// results, long tool outputs) a model is tempted to fold a large range into ONE
// monolithic summary that blows the cap, failing the whole call. This rule
// steers the model — at the moment it picks the range and in the persistent
// philosophy prompt — to split large/dense ranges into several smaller ranges,
// each with its own concise summary, batched in one call. Byte-stable constant
// (no dynamic values) so the prefix-cache anchor stays intact; phrased without
// a hard number so it stays correct regardless of the configured cap (the exact
// limit is already reported verbatim in the kernel's failure message).
const SUMMARY_BUDGET_NOTE =
    "\n\n[Per-summary length budget: every compress summary has a hard character cap, and a single oversized summary fails the WHOLE compress call — nothing gets folded. Dense content (many subagent results, long tool outputs) tempts you into writing one giant summary for a big range; don't. When a range is large or dense, SPLIT it into several smaller ranges at logical boundaries and give EACH its own concise, scannable summary, then batch all the ranges in one compress call (content: [{startId,endId,summary}, {…}]). Prefer several tight blocks over one bloated block: each stays under the cap, and smaller blocks are cheaper to re-send and independently searchable/decompressible.]";

/** Append the per-summary length-budget rule to a nudge or system-prompt text.
 *  The budget note is unconditional (like withMarkerIntegrityNote): the cap
 *  always exists, so the guidance must be present whenever compression is
 *  possible. The external-summary disclosure is per-request, decided by the
 *  caller from the request's resolved Config. */
export function withSummaryBudgetNote(text: string, external: boolean): string {
    return text + SUMMARY_BUDGET_NOTE + (external ? EXTERNAL_SUMMARY_NOTE : "");
}
