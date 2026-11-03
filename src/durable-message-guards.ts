// #2446/#2419/#2447/#2481: durable-state message carriers, declared per
// plugin lane and projected to VIRTUAL TOOL PATHS.
//
// Some hosts inject DURABLE STATE as ordinary conversation messages and gate
// re-injection on a content fingerprint: dsh ships three such carriers as
// user-role messages — dsh-tool-skill's skill catalog (\x3cavailable_skills\x3e,
// #2419; never resent while the sha256(name+description) digest is unchanged),
// @deepseek-ai/dsh-agent-instructions' workspace-instructions baseline
// (#2447: global + project AGENTS.md merged into ONE message, re-emitted only
// when baselineIdentity — projectRoot + discovery/budget config, NOT file
// contents — changes), and the agent-loop runtime-context snapshot (#2481:
// sandbox/approval policy state, self-declared "supersedes earlier
// runtime-context snapshots" — resent only when the runtime context CHANGES,
// not every turn) — plus a FOURTH carrier from the dsh PLUGIN ecosystem
// (#2446: dsh-skill-mcp-manager's \x3cmcp_catalog\x3e block, the first entry
// whose emitter is not dsh core). ACP compression treats every history
// message as consumable, so one fold of any carrier silently kills its
// guidance forever (the host will not resend what it believes is already
// present). The structured source.kind these hosts stamp internally never
// reaches the proxy wire (CoreMessage carries no metadata field), so the
// classification matches stable text markers instead — the same criterion
// discipline as #2447.
//
// ARCHITECTURE (this file owns TRANSLATION only; the POLICY lives in kernel
// config): each carrier is projected to a canonical virtual tool path
// (`durable/<name>`), handed to the kernel via Config.messagePathOf, and then
// governed by the SAME protectedTools / protectedLatestTools pattern
// machinery as tool exchanges — all-instance protection via protectedTools,
// latest-per-path via protectedLatestTools. This is the #1947 principle
// (project client dialects to canonical names, protect by pattern) extended
// from the tool channel to the text channel. withDurableProtection() wires a
// classifier onto a Config and defaults the policy to `durable/*`
// latest-per-identity protection (protectedLatestTools — exactly one live
// instance per carrier, superseded instances stay foldable; mirrors the pi
// reference architecture, where the skill catalog and AGENTS.md live in the
// system prompt as a single live copy) — unless the
// user has already classified any `durable` pattern themselves (whole-identity
// takeover: configuring one durable pattern takes over the entire durable
// policy).
//
// KDD #9 evidence-permitlist discipline applies: classifiers are added PER
// HOST with traffic evidence (shape + stability proof), never enabled
// wholesale — a shape classifier applied to every lane would hard-pin
// arbitrary user prose into context for hosts whose state carriers have no
// such contract. The kernel stays host-agnostic: it only knows virtual paths
// and patterns.
//
// #5142 second role — DRIFT ACCOUNTING (not protection): some carriers are
// deliberately foldable AND permanently retired by their host after use
// (the per-turn time-context notice; superseded durable instances under the
// latest-per-identity policy). Once folded they leave the resent history
// forever, which fold-reconcile used to count as "drift" on every later
// turn — the O(full-history) tax of #5139. oneShotCarrierPaths below exposes
// the same evidence-backed classifiers to that accounting surface ONLY:
// their matches are recorded as expected rebases (excluded from drift),
// never pinned in the kernel.
//
// #2766 ROLE BOUNDARY: every carrier is a host INJECTION into the user
// channel — no classifier may project an assistant-role message. Model
// output echoes these markers (anything visible to the model eventually
// shows up in its output: the bili-chain tags, #2483 render tags, #933/#1039
// echo noise are the same family), and under the default latest-per-identity
// policy a later assistant echo would take the `durable/<name>` identity
// over from the real carrier: the echo gets pinned, the real carrier demotes
// to foldable, one compression later the forged/partial copy is the only
// survivor. The role gate is checked first in every classifier below.

import type { Config, CoreMessage } from "acp-kernel";

/** Projects a plain-text message to a canonical `durable/<name>` virtual tool
 *  path (or undefined when the message is no durable carrier). */
type DurableMessageClassifier = (msg: CoreMessage) => string | undefined;

/** dsh skill-catalog identity (#2419): the durable catalog message injected
 *  by dsh-tool-skill (a \x3csystem-reminder\x3e carrying the
 *  \x3cavailable_skills\x3e block; source: asar dsh-tool-skill/lib/index.js,
 *  createUserMessage({ source: { kind: "skill-catalog" } })). The marker is
 *  matched on its own rather than on the wrapper so a future wrapper change
 *  cannot silently disarm the classifier; a false positive is benign (a
 *  matching message simply stays visible) and the marker is DSH-specific
 *  XML. Re-emitted only when the visible skill set CHANGES, so the newest
 *  instance is the source of truth (`protectedLatestTools` candidate).
 *  #2766: assistant-role messages are never carriers — every carrier is a
 *  host injection into the user channel, so a model ECHO of the marker must
 *  not project (under latest-per-identity it would take the identity over
 *  from the real carrier and get it folded away). */
export function dshSkillCatalogPath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("\x3cavailable_skills\x3e")
        ? "durable/skill-catalog"
        : undefined;
}

/** dsh workspace-instructions identity (#2447): the durable AGENTS.md baseline
 *  message injected by @deepseek-ai/dsh-agent-instructions — global
 *  (~/.dsh/AGENTS.md) and project instructions merged into ONE user-role
 *  \x3csystem-reminder\x3e message whose sections are labelled
 *  `Instructions from: <path>` (source: lib/index.js sectionText +
 *  createUserMessage). The host re-emits the baseline only when
 *  baselineIdentity (projectRoot + discovery/budget config, NOT file contents)
 *  changes, so one fold of it silently kills hard constraints like "read X
 *  before any web access" forever. Marker-over-wrapper rationale as #2419.
 *  The match is case-sensitive on purpose — reconciliation change messages
 *  use lowercase variants ("Updated instructions from:") that remain ordinary
 *  consumable history. At most ~one such baseline lives per session
 *  (replacements are rare identity changes), so pinning every match is
 *  bounded. #2766: assistant-role messages are never carriers (see
 *  dshSkillCatalogPath). */
export function dshWorkspaceInstructionsPath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("Instructions from:")
        ? "durable/agents-md"
        : undefined;
}

/** dsh mcp-catalog identity (#2446): the durable MCP-server catalog injected
 *  by the THIRD-PARTY plugin dsh-skill-mcp-manager (author-reported marker;
 *  the plugin also curates which skills the dsh core catalog offers). The
 *  catalog rides a user-role message whose \x3cmcp_catalog\x3e block lists
 *  every registered MCP server with tool-schema digests (~5K tokens in the
 *  report); the plugin re-emits it only when the visible MCP/skill set
 *  CHANGES, so one fold silently kills the session's MCP server inventory
 *  forever — the report's failure mode is the model hunting for servers by
 *  wrong names mid-session. First entry for a carrier emitted by the dsh
 *  plugin ecosystem rather than dsh core: same evidence bar (shape from the
 *  #2446 report, stability owned by the plugin author who filed it), and
 *  re-emissions are rare set changes so pinning every match stays bounded
 *  (same argument as #2447). #2766: assistant-role messages are never
 *  carriers (see dshSkillCatalogPath) — this is the adversarial variant's
 *  vector: an injected "list the catalog" instruction makes the MODEL emit a
 *  forged \x3cmcp_catalog\x3e, which must never outrank the real one. */
export function dshMcpCatalogPath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("\x3cmcp_catalog\x3e")
        ? "durable/mcp-catalog"
        : undefined;
}

/** dsh runtime-context identity (#2481): the durable runtime-context snapshot
 *  injected by the dsh agent loop — sandbox/approval policy state carried as
 *  a user-role message containing "Current runtime context" (source:
 *  deepseek-ai/deepseek-harness MIT packages/core/agent-loop/src/
 *  runtime-context.ts; the same text family bili already recognizes as an
 *  auto-injected notification in #2286's AUTO_INJECTED_NOTIFICATION_PREFIXES).
 *  Both variants match on purpose: the populated snapshot ("Current runtime
 *  context. This snapshot supersedes earlier runtime-context snapshots. …")
 *  AND the cleared form ("Current runtime context: none. Earlier
 *  runtime-context snapshots no longer apply.") — the cleared notice must
 *  stay visible too, because it is what invalidates the older snapshots.
 *  The host re-emits only when the runtime context CHANGES (the per-turn
 *  time-context carrier deliberately stays foldable), so one fold of the
 *  latest snapshot silently drops the session's sandbox/approval semantics
 *  forever. Each snapshot is tiny (~100–400 chars); superseded ones fold
 *  harmlessly under the latest-per-identity default because the newest
 *  carries the supersedes clause. #2766: assistant-role messages are never
 *  carriers (see dshSkillCatalogPath). */
export function dshRuntimeContextPath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("Current runtime context")
        ? "durable/runtime-context"
        : undefined;
}

/** #2286 wire shape (AUTO_INJECTED_NOTIFICATION_PREFIXES in src/server.ts):
 *  the dsh agent loop injects one timestamp notice before each turn,
 *  "Time sampled while preparing turn N, step M: <ts> …". Kept local — this
 *  module must not import src/server.ts; tests pin the two lists in lockstep. */
const TIME_CONTEXT_MARKER = "Time sampled while preparing turn";

/** dsh per-turn time-context carrier (#5142, superseding #5109's naming):
 *  the timestamp notice injected before each turn (marker above).
 *  Deliberately FOLDABLE by design — unlike the four durable carriers it
 *  carries no state beyond its own turn and must NEVER be pinned, so it
 *  stays OUT of dshDurableToolPath / kernel protection. Its problem is
 *  retirement, not foldability: the host re-sends it only on the turn it
 *  was sampled for, so once folded it leaves the resent history FOREVER —
 *  a permanent missing covered id that fold-reconcile used to count as
 *  drift on every later turn (#5139: 157 such ids in one production
 *  session, part of the monotonic 739→1045 growth). oneShotCarrierPaths
 *  accounts that retirement as EXPECTED. Prefix match (trimmed) on purpose
 *  (the turn-number/timestamp tail varies) — a substring hit would
 *  reclassify a real human request that merely quotes the phrase
 *  mid-sentence; case-insensitive like the other auto-injected notification
 *  prefixes (#2286). The path still matters beyond accounting: kernel Rule 3
 *  refuses virtual-path messages as the last-user anchor (#5109), so a stale
 *  clock reading can never displace the newest human request from the
 *  protected zone. #2766: model echoes are never carriers (assistant gate
 *  below). */
export function dshTimeContextPath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && startsWithAsciiCI(msg.text.trim(), TIME_CONTEXT_MARKER)
        ? "oneshot/time-context"
        : undefined;
}
/** dsh paste-to-context image carrier (#5142, reporter evidence 2026-10-29):
 *  the ptc-mode message dsh emits when a user pastes an image into context —
 *  a user-role (text, image) pair whose text block is the generated template
 *  \x3cpath\x3e…\x3c/path\x3e \x3ctype\x3eimage\x3c/type\x3e \x3ccontent\x3e…px, …
 *  bytes…\x3c/content\x3e (shape verified against a production session journal:
 *  all 550 instances carry the identical shape). One-shot: the host resends it
 *  only on the turn it was pasted for, so once folded it leaves the resent
 *  history forever — the ×550 drift-id family of #5139. The match is on the
 *  most distinctive template token alone (single-marker discipline like every
 *  other classifier here); a literal user echo is benign in both directions —
 *  a persistent misclassified message never goes missing, so the expected-
 *  rebase record has no observable effect on it, and a true carrier missing
 *  its marker tail still retires loudly as drift (honest failure). These
 *  messages are also prime image-offload targets (inline bytes), which C3's
 *  structural pairing handles independently. #2766: assistant-role messages
 *  are never carriers (see dshSkillCatalogPath). */
export function dshPastedImagePath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && msg.text.includes("\x3ctype\x3eimage\x3c/type\x3e")
        ? "oneshot/ptc-image"
        : undefined;
}

/** dsh background-job completion notice (#5142, reporter evidence 2026-10-29):
 *  tool-jobs / form:"notice" — a user-role message announcing a finished
 *  background job ("background job <id> (…) finished [status: …, exit code:
 *  N]. Read its output with job_output."), one per job completion (×39 in the
 *  #5139 session). One-shot like time-context: resent only while the notice
 *  is fresh, then gone forever after use. Prefix match (asciiCI, trimmed) on
 *  the machine-generated lead-in; the phrasing is dsh-specific and a plain
 *  user question starting that way stays on the wire, so a misclassification
 *  never becomes an accounting effect (same benign-FP argument as
 *  dshPastedImagePath). #2766: assistant-role messages are never carriers. */
export function dshToolJobNoticePath(msg: CoreMessage): string | undefined {
    return msg.role !== "assistant" && msg.contentType === "text" && typeof msg.text === "string" && startsWithAsciiCI(msg.text.trim(), "background job")
        ? "oneshot/tool-job-notice"
        : undefined;
}

/** Case-insensitive ASCII prefix check over the first needle.length chars —
 *  mirrors the asciiCI convention of src/server.ts (kept local so this
 *  module stays dependency-free). */
function startsWithAsciiCI(hay: string, needle: string): boolean {
    if (hay.length < needle.length) return false;
    for (let i = 0; i < needle.length; i++) {
        const h = hay.charCodeAt(i);
        const n = needle.charCodeAt(i);
        if (h === n) continue;
        const hl = h >= 65 && h <= 90 ? h + 32 : h;
        if (hl !== (n >= 65 && n <= 90 ? n + 32 : n)) return false;
    }
    return true;
}

/** dsh lane classifier: any of the five evidence-backed identities → its
 *  canonical path (four durable carriers + the foldable time-context
 *  injection, #5109). */
function dshDurableToolPath(msg: CoreMessage): string | undefined {
    return (
        dshSkillCatalogPath(msg) ??
        dshWorkspaceInstructionsPath(msg) ??
        dshRuntimeContextPath(msg) ??
        dshMcpCatalogPath(msg) ??
        dshTimeContextPath(msg)
    );
}

/** Lane → classifier registry. Only lanes with traffic evidence of the
 *  durable-user-message carrier belong here (KDD #9). Keyed by the value of
 *  the x-bili-plugin header / session.metadata.pluginAgent binding. */
export const durableMessageToolPaths: Record<string, DurableMessageClassifier> = {
    dsh: dshDurableToolPath,
};

/** True when a pattern list already classifies the durable identity space —
 *  i.e. the user has taken over the durable policy themselves (any pattern
 *  whose first path segment is `durable`, in either protection list). */
function classifiesDurable(patterns: readonly string[] | undefined): boolean {
    return (patterns ?? []).some((p) => p.toLowerCase().split("/")[0] === "durable");
}

/** Attach a lane classifier to a kernel Config and default the durable
 *  policy. Default = `durable/*` latest-per-identity protection in
 *  protectedLatestTools: every carrier keeps exactly its newest instance
 * pinned (skill/MCP visibility can never be lost — the #2419 fingerprint gate
 * never resends an unchanged catalog), while superseded instances (runtime
 * snapshots, re-based AGENTS.md lines) fold normally — the same single-live-
 * copy semantics pi gets from keeping carriers in the system prompt. If the
 * user already configured any `durable` pattern in
 *  protectedTools/protectedLatestTools, their policy wins verbatim
 *  (whole-identity takeover: one durable pattern anywhere takes over the
 *  whole durable policy — no per-carrier merging). */
export function withDurableProtection(config: Config, classifier: DurableMessageClassifier): Config {
    const classified =
        classifiesDurable(config.protectedTools) || classifiesDurable(config.protectedLatestTools);
    if (classified) {
        return { ...config, messagePathOf: classifier };
    }
    return { ...config, protectedLatestTools: [...(config.protectedLatestTools ?? []), "durable/*"], messagePathOf: classifier };
}

/** #5142: lane → ONE-SHOT carrier classifier for FOLD-DRIFT ACCOUNTING only
 *  (fold-reconcile's expected-rebase record). Deliberately separate from
 *  durableMessageToolPaths: these carriers stay kernel-foldable (lean
 *  context) but are PERMANENTLY retired by their host after use — superseded
 *  durable instances under the latest-per-identity policy included (a folded
 *  old skill-catalog snapshot never comes back either). Their absence from
 *  later resends is expected host behavior, accounted out of drift, NEVER
 *  pinned. Same KDD #9 discipline: per-host entries with traffic evidence. */
export const oneShotCarrierPaths: Record<string, DurableMessageClassifier> = {
    dsh: (msg) =>
        dshSkillCatalogPath(msg) ??
        dshWorkspaceInstructionsPath(msg) ??
        dshRuntimeContextPath(msg) ??
        dshMcpCatalogPath(msg) ??
        dshTimeContextPath(msg) ??
        dshPastedImagePath(msg) ??
        dshToolJobNoticePath(msg),
};

/** #5142: raw-content pre-filter markers for the stored-row backfill — the
 *  exact marker strings of the seven dsh classifiers above, so a unified-store
 *  row can be screened with cheap substring checks BEFORE JSON.parse (rows
 *  may carry megabytes of base64 media). Lockstep with the classifiers is
 *  enforced in tests/issue5142-expected-rebase.test.ts. */
export const dshCarrierRawMarkers: readonly string[] = [
    "\x3cavailable_skills\x3e",
    "Instructions from:",
    "Current runtime context",
    "\x3cmcp_catalog\x3e",
    "Time sampled while preparing turn",
    "\x3ctype\x3eimage\x3c/type\x3e",
    "background job",
];
