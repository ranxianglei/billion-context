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
    DECOMPRESS_TOOL,
    DECOMPRESS_TOOL_GOOGLE,
    DECOMPRESS_TOOL_NAME,
    DECOMPRESS_TOOL_OPENAI,
    DECOMPRESS_TOOL_RESPONSES,
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
    buildCompressSystemPrompt as kBuildCompressSystemPrompt,
    buildCompressHybridSystemPrompt as kBuildCompressHybridSystemPrompt,
    COMPRESS_TOOL_DRYRUN,
    COMPRESS_TOOL_OPENAI_DRYRUN,
    COMPRESS_TOOL_RESPONSES_DRYRUN,
    COMPRESS_TOOL_GOOGLE_DRYRUN,
    COMPRESS_DRYRUN_PROMPT_SENTENCE,
    defaultPrompts,
    ACP_TOOL_NAMES,
    COMPRESS_TOOL_NAME,
} from "acp-kernel";
import type { CompressPromptSections, Prompts, SectionOverride, ToolPrompts } from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { maxShrinkPerCompress } from "./fetch-util.js";
import { EXTERNAL_SUMMARY_NOTE } from "./external-summary-surface.js";
import { dryRunPreviewEnabled } from "./knobs.js";

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
    COMPRESS_TOOL_DRYRUN,
    COMPRESS_TOOL_OPENAI_DRYRUN,
    COMPRESS_TOOL_RESPONSES_DRYRUN,
    COMPRESS_TOOL_GOOGLE_DRYRUN,
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
    buildCompressTextSystemPrompt,
    RULE_TOOL_NAME,
} from "acp-kernel";
export type { ParsedRange } from "acp-kernel";
export { ACP_TOOL_NAMES as PROXY_TOOL_NAMES, ACP_MUTATING_TOOLS as MUTATING_PROXY_TOOLS, ACP_READONLY_TOOLS as READONLY_PROXY_TOOLS } from "acp-kernel";

// #3185: the dryRun preview is opt-in (compress.dryRunPreview / BILI_COMPRESS_DRYRUN,
// default off). Off, the served schema and prompt are byte-identical to master; on,
// the compress tool gains the dryRun schema and the strategy sentence. The knob can
// come from file config loaded after module init, so every serving point resolves it
// per request instead of baking it into a module-level const.
const DRYRUN_PROMPT_ANCHOR = "Never split a batch into one call per range.";
function withDryRunStrategy(prompt: string): string {
    return dryRunPreviewEnabled() && prompt.includes(DRYRUN_PROMPT_ANCHOR)
        ? prompt.replace(DRYRUN_PROMPT_ANCHOR, DRYRUN_PROMPT_ANCHOR + COMPRESS_DRYRUN_PROMPT_SENTENCE)
        : prompt;
}
export function buildCompressSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string {
    return withDryRunStrategy(kBuildCompressSystemPrompt(prompts, sections));
}
export function buildCompressHybridSystemPrompt(prompts?: Prompts, sections?: CompressPromptSections): string {
    return withDryRunStrategy(kBuildCompressHybridSystemPrompt(prompts, sections));
}
function compressNameOf(tool: unknown): string | undefined {
    const t = tool as { name?: string; function?: { name?: string } };
    return t?.function?.name ?? t?.name;
}
export function withDryRunCompress<T>(tools: readonly T[], dryRunTool: T): T[] {
    if (!dryRunPreviewEnabled()) return [...tools];
    return tools.map((t) => (compressNameOf(t) === COMPRESS_TOOL_NAME ? dryRunTool : t));
}

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
        ? kBuildCompressHybridSystemPrompt(p, overrides)
        : kBuildCompressSystemPrompt(p, overrides);
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

export const BILI_ACP_TOOLS_ANTHROPIC = ACP_TOOLS_ANTHROPIC.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL : t));
export const BILI_ACP_TOOLS_OPENAI = ACP_TOOLS_OPENAI.map((t) => (t.function.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_OPENAI : t.function.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_OPENAI : t));
export const BILI_ACP_TOOLS_RESPONSES = ACP_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t));
export const BILI_ACP_TOOLS_GOOGLE = ACP_TOOLS_GOOGLE.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_GOOGLE : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_GOOGLE : t));

// #1712: no-range variants — identical except decompress lacks startId/endId.
// Served where range restore cannot be armed so the advertised schema never
// offers what execution will refuse (see the #1179 note above). Image recovery
// still applies here (it does not require CCR), so these keep imageRef.
const BILI_DECOMPRESS_IMG_ANTHROPIC = { name: DECOMPRESS_TOOL.name, description: DECOMPRESS_TOOL.description + DECOMPRESS_IMAGE_NOTE, input_schema: withImageRestoreParam(DECOMPRESS_TOOL.input_schema) };
const BILI_DECOMPRESS_IMG_OPENAI = { type: "function" as const, function: { name: DECOMPRESS_TOOL_OPENAI.function.name, description: DECOMPRESS_TOOL_OPENAI.function.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_OPENAI.function.parameters) } };
const BILI_DECOMPRESS_IMG_RESPONSES = { type: "function" as const, name: DECOMPRESS_TOOL_RESPONSES.name, description: DECOMPRESS_TOOL_RESPONSES.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_RESPONSES.parameters) };
const BILI_DECOMPRESS_IMG_GOOGLE = { name: DECOMPRESS_TOOL_GOOGLE.name, description: DECOMPRESS_TOOL_GOOGLE.description + DECOMPRESS_IMAGE_NOTE, parameters: withImageRestoreParam(DECOMPRESS_TOOL_GOOGLE.parameters) };
export const BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE = ACP_TOOLS_ANTHROPIC.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_ANTHROPIC : t));
export const BILI_ACP_TOOLS_OPENAI_NO_RANGE = ACP_TOOLS_OPENAI.map((t) => (t.function.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_OPENAI : t.function.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_OPENAI : t));
export const BILI_ACP_TOOLS_RESPONSES_NO_RANGE = ACP_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_RESPONSES : t));
export const BILI_ACP_TOOLS_GOOGLE_NO_RANGE = ACP_TOOLS_GOOGLE.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_GOOGLE : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_GOOGLE : t));
export const BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE = ACP_READONLY_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_IMG_RESPONSES : t));
export const BILI_ACP_READONLY_TOOLS_RESPONSES = ACP_READONLY_TOOLS_RESPONSES.map((t) => (t.name === SEARCH_CONTEXT_TOOL_NAME ? BILI_SEARCH_CONTEXT_TOOL_RESPONSES : t.name === DECOMPRESS_TOOL_NAME ? BILI_DECOMPRESS_TOOL_RESPONSES : t));

// #3252 (code-mode/PTC harnesses): a code-mode harness (dsh "PTC" preset,
// Cloudflare-style code mode) collapses every registered tool behind ONE
// directly callable `run_code` tool — the model writes a program and calls
// everything else through generated SDK bindings. That hurts the ACP surface
// differently per lane, so both serving sites append a note to the ACP tool
// descriptions:
//  - plugin lane (handlePluginManifest): hosts register the manifest
//    verbatim, and a code-mode harness renders these descriptions as the SDK
//    docs. The binding note teaches BOTH conventions so the model neither
//    slips a direct call the harness will reject (the #3252 report) nor
//    dodges the direct call native hosts expect.
//  - proxy lane (src/server/inject.ts): when the client's own tools array
//    carries run_code, bili's injected tools have NO run_code binding — a
//    call from inside a program can only fail — but a DIRECT call never
//    reaches the harness at all (the proxy tool loop executes it
//    server-side), so the exempt note tells the model to ignore the harness's
//    only-run_code rule for exactly these tools.
const RUN_CODE_TOOL_NAME = "run_code";

/** Calling-convention note mode for one request (internal to this module —
 *  inject.ts/plugin.ts pick the mode via ptcNoteMode()/the literal "binding"). */
type AcpNoteMode = "binding" | "exempt" | "none";

export const PTC_BINDING_NOTE = " Calling convention: if this environment only allows `run_code` to be called directly (code-mode/PTC harness), call this tool from inside a run_code program via the harness's generated SDK; otherwise call it directly as a tool.";

export const PTC_EXEMPT_NOTE = " If a harness rule says only `run_code` may be called directly, this tool is the exception: it has no run_code SDK binding, so call it DIRECTLY as a normal tool call — the proxy executes it server-side.";

// The model cannot tell from the tool name alone what provides these tools;
// name the project (owner request in #3252) so billion-context problems land
// in its issue tracker instead of the host's.
export const PROJECT_URL_NOTE = " Context management is provided by billion-context — report billion-context problems at github.com/ranxianglei/billion-context/issues.";

function acpNoteFor(name: string | undefined, mode: AcpNoteMode): string | undefined {
    if (name === undefined || !ACP_TOOL_NAMES.has(name)) return undefined;
    let note = mode === "binding" ? PTC_BINDING_NOTE : mode === "exempt" ? PTC_EXEMPT_NOTE : "";
    if (name === COMPRESS_TOOL_NAME) note += PROJECT_URL_NOTE;
    return note.length > 0 ? note : undefined;
}

/** Append the #3252 notes to ACP tool entries with a flat `description`
 *  (Anthropic and Responses shapes). Non-ACP entries pass through
 *  untouched. `skip` names tools whose wording a pack owns wholesale —
 *  their description override must still land verbatim (pck-verbatim
 *  contract), notes included in the pack text only if its author wants
 *  them. */
export function withAcpNotes<T extends { name?: string; description?: string }>(tools: readonly T[], mode: AcpNoteMode, skip?: ReadonlySet<string>): T[] {
    return tools.map((t) => {
        const note = skip?.has(String(t?.name)) ? undefined : acpNoteFor(t?.name, mode);
        return note && typeof t.description === "string" ? { ...t, description: t.description + note } : t;
    });
}

/** Same as withAcpNotes for OpenAI/Google-style entries where the name and
 *  description live one level down under `function`. */
export function withAcpNotesOpenAI<T extends { function: { name?: string; description?: string } }>(tools: readonly T[], mode: AcpNoteMode, skip?: ReadonlySet<string>): T[] {
    return tools.map((t) => {
        const note = skip?.has(String(t?.function?.name)) ? undefined : acpNoteFor(t?.function?.name, mode);
        return note && typeof t.function.description === "string" ? { ...t, function: { ...t.function, description: t.function.description + note } } : t;
    });
}

/** Tool names whose description a pack toolPrompt replaces — the #3252 notes
 *  are skipped for exactly these (see withAcpNotes). */
export function packOwnsDescription(toolPrompts: ToolPrompts | undefined): Set<string> {
    const owned = new Set<string>();
    if (!toolPrompts) return owned;
    for (const [name, tp] of Object.entries(toolPrompts)) if (tp?.description !== undefined) owned.add(name);
    return owned;
}

/** #3252 (owner request): the injected compress system prompt names the
 *  project, so the model knows what provides its context management and
 *  where problems belong. BOTH lanes inject this block — plugin mode skips
 *  only TOOL injection (the host registers the manifest tools natively);
 *  the system prompt still rides the proxied request (pinned by
 *  tests/plugin-nudge-injection.test.ts #451). Static string: the system
 *  block stays byte-stable across turns, so the prefix-cache anchor survives
 *  (one-time invalidation on upgrade only). */
export const PROJECT_ATTRIBUTION_LINE = "Context management for this conversation is provided by billion-context (github.com/ranxianglei/billion-context). Report billion-context problems to that project's issue tracker.";

/** Append PROJECT_ATTRIBUTION_LINE to a built compress prompt — used by all
 *  four wire prepare paths (anthropic/openai/google/responses). */
export function withProjectAttribution(prompt: string): string {
    return prompt + "\n\n" + PROJECT_ATTRIBUTION_LINE;
}

/** Note mode for one request: the harness is code-mode-shaped when the
 *  client's own tools array carries a tool literally named run_code. */
export function ptcNoteMode(names: Iterable<string | undefined>): AcpNoteMode {
    for (const n of names) if (n === RUN_CODE_TOOL_NAME) return "exempt";
    return "none";
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
    const parsed = parseCompressArgs(normalizeCompressInput(input), { callId, allowDryRun: dryRunPreviewEnabled() });
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
    // #3185: dryRun previews are routed to the kernel's previewCompression —
    // the flag must survive this boundary or the call silently commits. When the
    // preview is disabled allowDryRun already forces parsed.dryRun false; the
    // second guard keeps "off never previews" true even if that ever regresses.
    return { ranges: parsed.ranges, diagnostics: parsed.diagnostics, dryRun: parsed.dryRun === true && dryRunPreviewEnabled() };
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
// The two constants now live in src/marker/anchors.ts (leaf, zero imports)
// so the inbound nudge-echo matcher (src/marker/engine.ts) shares the exact
// emitter bytes instead of a copy — same single-source discipline as the
// chain carriers and panel wrappers. Kept exported here for compatibility
// with existing importers.
export { MARKER_INTEGRITY_NOTE, MARKER_SILENCE_CLAUSE } from "./marker/anchors.js";
import { MARKER_INTEGRITY_NOTE, MARKER_SILENCE_CLAUSE } from "./marker/anchors.js";

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
