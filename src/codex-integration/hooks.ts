// Ticket 08: Codex SessionStart hook (the face the user noticed was missing).
//
// Codex >= 0.160 supports hooks through `config.toml` tables plus the
// `[features] hooks = true` switch, with the SAME event names Claude Code uses
// (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
// `SessionEnd`). The hook program receives one JSON payload on stdin and is
// expected to exit quickly; bili's hook is attach-only and fails open.
//
// Ownership mirrors the rest of the Codex lane: bili writes ONE entry it can
// recognize by content (a command naming our own hook script) and never
// rewrites a foreign entry, a foreign `hooks` switch value, or an unexpected
// table shape. `bili plugin remove codex` deletes exactly that entry.

import { tableRegions } from "./toml-field.js";

/** The TOML table Codex reads hook entries from. */
const CODEX_HOOKS_TABLE = "hooks.SessionStart";

/** `[features] hooks = true` — the master switch for the hook system. */
const FEATURES_TABLE = "features";
const FEATURES_KEY = "hooks";

/** True for a hook command naming bili's own Codex hook script. Path may differ
 *  across installs/upgrades (checkout vs. global npm), so match the script
 *  name, not the absolute path — same rule as the Claude lane. */
export function isBiliCodexHookCommand(command: string): boolean {
    return /(?:^|[\\/])codex[\\/]bootstrap-hook\.(?:js|mjs|ts)["']?\s*(?:$|\s)/.test(
        command.trim(),
    );
}

/** Parse the hook entries out of a `hooks.SessionStart` region. Only `command`
 *  is load-bearing for us. Deliberately regex-based: an unrecognizable region
 *  yields an empty list, so the caller treats it as foreign structure instead
 *  of overwriting it. Handles both `command = "..."` on its own line (the
 *  array-of-tables form bili writes) and inline tables. */
export function readCodexHookCommands(region: string): string[] {
    const out: string[] = [];
    for (const match of region.matchAll(
        /command\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^']*)')/g,
    )) {
        const raw = match[1];
        if (raw === undefined) continue;
        if (raw.startsWith("'")) {
            out.push(raw.slice(1, -1));
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === "string") out.push(parsed);
        } catch {
            // A malformed escape is not ours to repair; skip the entry.
        }
    }
    return out;
}

/** Does the config already carry bili's hook entry? */
export function findBiliCodexHook(text: string): string | undefined {
    for (const region of tableRegions(text, CODEX_HOOKS_TABLE)) {
        const command = readCodexHookCommands(region).find(isBiliCodexHookCommand);
        if (command !== undefined) return command;
    }
    return undefined;
}

/** The `[features] hooks` switch, when the user has set one. Scanned by hand
 *  rather than via `findTableScalar`: the value is a TOML BOOLEAN
 *  (`hooks = true`), which the string-only scalar finder deliberately does not
 *  match.
 *
 *  The `\r?` before `$` is load-bearing. Codex keeps CRLF line endings on
 *  Windows, and neither `[ \t]*` nor the optional comment group consumes a
 *  trailing `\r`, so an anchored `$` never matched: the installer reported
 *  "hook execution is not enabled" on a config that plainly said
 *  `hooks = true`, and would have nagged every Windows user. */
export function codexHooksFeature(
    text: string,
): { value: boolean; raw: string } | undefined {
    for (const region of tableRegions(text, FEATURES_TABLE)) {
        for (const line of region.split("\n").slice(1)) {
            const match =
                /^[ \t]*hooks[ \t]*=[ \t]*([^#\s]+)[ \t]*(?:#.*)?\r?$/.exec(line);
            if (match === null) continue;
            const raw = match[1];
            if (raw === undefined) continue;
            return { value: raw.trim().toLowerCase() === "true", raw };
        }
    }
    return undefined;
}

type CodexHookPlan =
    | { action: "install" | "refresh"; text: string; note: string }
    | { action: "keep"; text: string; note: string };

/** Render the hook entry bili owns.
 *
 *  THE NESTED `hooks = [...]` ARRAY IS LOAD-BEARING. Codex deserializes each
 *  `[[hooks.SessionStart]]` element as a `MatcherGroup`:
 *  `{ matcher?, hooks = [ { type = "command", command, timeout } ] }`. An
 *  earlier revision wrote `type`/`command`/`timeout` DIRECTLY on the element;
 *  those are unknown keys to `MatcherGroup`, so serde drops them silently — the
 *  config still loads, `codex mcp list` still succeeds, and the hook simply
 *  never registers. The host showed it as a hook missing from its
 *  pending-confirmation list, with no error anywhere.
 *
 *  A load probe CANNOT catch this class of bug (both shapes load fine). The
 *  only red-capable loop is Codex's own app-server `hooks/list` RPC — see
 *  `probe-hooks.mjs` during development, and the regression test that pins this
 *  shape in tests/codex-hooks-skill.test.ts. */
export function codexHookTable(command: string, timeoutSec = 15): string {
    return `[[${CODEX_HOOKS_TABLE}]]\nhooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = ${timeoutSec} }]\n`;
}

/** Is this region the nested `MatcherGroup` shape Codex actually registers?
 *  `false` means the region still carries handler fields directly on the entry
 *  (bili's older, silently-invisible output), which must be replaced whole
 *  rather than command-rewritten. */
function isNestedHookRegion(region: string): boolean {
    return /^\s*hooks\s*=\s*\[/m.test(region);
}

/** The line ending a config already uses. Follows the repo convention
 *  (src/kimi/toml-edit.ts:21, src/launcher.ts:2466): never convert a user's
 *  file, and never mix endings into it — Codex keeps CRLF on Windows. */
function detectEol(text: string): string {
    return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Replace bili's own entry inside an existing region, leaving every other
 *  entry (and any foreign formatting we cannot parse) untouched: only the
 *  matched `command = "..."` span is rewritten. */
function rewriteBiliHookCommand(region: string, command: string): string {
    let replaced = false;
    return region.replace(
        /command\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^']*)')/g,
        (match, raw: string) => {
            if (replaced) return match;
            let decoded: string | undefined;
            if (raw.startsWith("'")) {
                decoded = raw.slice(1, -1);
            } else {
                try {
                    const parsed: unknown = JSON.parse(raw);
                    decoded = typeof parsed === "string" ? parsed : undefined;
                } catch {
                    decoded = undefined;
                }
            }
            if (decoded === undefined || !isBiliCodexHookCommand(decoded))
                return match;
            replaced = true;
            return `command = ${JSON.stringify(command)}`;
        },
    );
}

/** Pure planner for the hook face. `command` is the full hook command line
 *  (node + our hook script).
 *
 *  ADDITIVE, never destructive: `[[hooks.SessionStart]]` is an array of tables,
 *  so a foreign entry (lean-ctx and friends live there) is a SIBLING, not a
 *  competitor. bili appends its own entry and refreshes/removes only the entry
 *  whose command names our own script. An earlier revision treated any
 *  unrecognized region as a conflict and gave up — which, on the real machine
 *  (a foreign SessionStart entry already present), meant bili's hook silently
 *  never installed. */
export function planCodexHook(text: string, command: string): CodexHookPlan {
    const regions = tableRegions(text, CODEX_HOOKS_TABLE);
    const owned = regions.find(
        (region) =>
            readCodexHookCommands(region).find(isBiliCodexHookCommand) !== undefined,
    );
    if (owned === undefined) {
        const eol = detectEol(text);
        const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}${eol}`;
        // A foreign entry in the same array is preserved verbatim: we only append.
        const suffix =
            regions.length > 0 ? " (kept existing SessionStart entries)" : "";
        const entry = codexHookTable(command).replace(/\n$/, "").split("\n").join(eol);
        return {
            action: "install",
            text: `${prefix}${eol}${entry}${eol}`,
            note: `SessionStart hook added -> ${CODEX_HOOKS_TABLE}${suffix}`,
        };
    }
    const existing = readCodexHookCommands(owned).find(isBiliCodexHookCommand);
    // Self-heal: an entry bili wrote before the MatcherGroup fix carries
    // `type`/`command`/`timeout` directly on the element, which Codex silently
    // ignores. Rewriting only the command string would leave it invisible
    // forever, so the whole region is replaced with the nested shape.
    if (!isNestedHookRegion(owned)) {
        const replacement = codexHookTable(command)
            .replace(/\n$/, "")
            .split("\n")
            .join(detectEol(text));
        return {
            action: "refresh",
            text: text.replace(owned, replacement),
            note: "SessionStart hook upgraded to the shape Codex registers",
        };
    }
    if (existing === command)
        return {
            action: "keep",
            text,
            note: "SessionStart hook already installed",
        };
    const next = rewriteBiliHookCommand(owned, command);
    if (next === owned)
        return { action: "keep", text, note: "SessionStart hook left as-is" };
    return {
        action: "refresh",
        text: text.replace(owned, next),
        note: "SessionStart hook refreshed to the current command",
    };
}

/** Delete bili's hook entry, keeping foreign entries. Returns the text plus
 *  what was removed, so the uninstall message can report it.
 *
 *  Removal happens at ENTRY boundaries — under `[[hooks.SessionStart]]` one
 *  region IS one entry, so the whole region goes. An earlier version rewrote
 *  the inline table in place and then pattern-matched a rendered
 *  `{ type = "command", command = "", timeout = N }`; once bili switched to the
 *  array-of-tables shape that pattern never matched, and uninstall silently
 *  left a `command = ""` stub hook behind. */
export function stripCodexHook(text: string): {
    text: string;
    removed: boolean;
} {
    let removed = false;
    let next = text;
    for (const region of tableRegions(text, CODEX_HOOKS_TABLE)) {
        const ours = readCodexHookCommands(region).find(isBiliCodexHookCommand);
        if (ours === undefined) continue;
        removed = true;
        next = next
            .replace(region, "")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/^\n+/, "");
        if (next.length > 0 && !next.endsWith("\n")) next = `${next}\n`;
    }
    return { text: next, removed };
}

/** `[features] hooks` must be true for Codex to run the hook. Reports what the
 *  caller has to add, without editing an existing switch the user set. */
export function codexHooksEnabledNote(text: string): string {
    const feature = codexHooksFeature(text);
    if (feature === undefined)
        return `enable hook execution with [${FEATURES_TABLE}] ${FEATURES_KEY} = true`;
    if (!feature.value)
        return `[${FEATURES_TABLE}] ${FEATURES_KEY} = ${feature.raw} disables hooks — set it to true to activate`;
    return "";
}

/** Last line of defence before a hook face is written to a user's real config.
 *
 *  Two DIFFERENT failure modes have bitten this face, and the guard covers both:
 *
 *  1. LOUD — a config that will not load. The very first revision wrote
 *     `[hooks.SessionStart]` + `hooks = [{...}]`, which makes `hooks` a MAP;
 *     Codex reads it as a SEQUENCE and refused to load the file at all
 *     (`invalid type: map, expected a sequence in 'hooks'`). The host surfaced
 *     only an unrelated-looking `AbsolutePathBuf deserialized without a base
 *     path in model_catalog json` and would not start. A config that cannot
 *     load is worse than a missing feature, so the installer REJECTS its own
 *     output structurally rather than trusting the renderer.
 *
 *  2. SILENT — a config that loads and registers nothing. Handler fields
 *     (`type`/`command`/`timeout`) written DIRECTLY on a `[[hooks.SessionStart]]`
 *     element are unknown keys on the `MatcherGroup` serde deserializes, so they
 *     are dropped without a word: the file loads, `codex mcp list` succeeds, and
 *     the hook never appears in the host's list. Hence the nested `hooks = [...]`
 *     array is REQUIRED here, not merely allowed.
 *
 *  Returns a human-readable reason when the text would not load or would load
 *  without registering, else `undefined`. Structural only — it cannot prove
 *  Codex accepts the entry (that needs the app-server `hooks/list` RPC), but it
 *  rules out every shape we have seen it reject or silently ignore. */
export function assertCodexConfigLoads(text: string): string | undefined {
    for (const line of text.split("\n")) {
        const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
        if (header === null) continue;
        const raw = header[1];
        if (raw === undefined) continue;
        const inner = raw.replace(/^\[\[?/, "").replace(/\]\]?$/, "").trim();
        // `hooks` spans more than the stage tables bili writes: Codex keeps its
        // OWN trust ledger at `[hooks.state.'<config>:<stage>:<i>:<j>']`, written
        // as a single-bracket table (it holds key/value pairs, so a table is the
        // correct shape and must never be flagged). Matching a bare `hooks`
        // prefix treated Codex's own output as a malformed stage table and
        // rejected the whole config, which silently skipped the hook face
        // whenever a hook had ever been trusted. Only what bili writes is
        // inspected: the stage table, plus the flat `[[hooks]]` misuse.
        if (inner !== CODEX_HOOKS_TABLE && inner !== "hooks") continue;
        // `[[hooks]]` with `event = "..."` is the flat-sequence shape Codex
        // rejects with `expected struct HooksToml`: a bare `hooks` array cannot
        // hold stage tables keyed by name.
        if (inner === "hooks")
            return "`[[hooks]]` is not a hook stage — use `[[hooks.SessionStart]]` (Codex expects a struct HooksToml keyed by stage name)";
        if (raw.startsWith("[[")) continue;
        return `${raw.trim()} must be [[${inner}]] (Codex reads 'hooks' as a sequence, not a table)`;
    }
    // A top-level `hooks = ...` assignment would also collapse the sequence.
    for (const line of text.split("\n")) {
        if (/^\s*\[/.test(line)) break;
        if (/^\s*hooks\s*=/.test(line))
            return "a top-level `hooks = ...` key must not be set (Codex reads 'hooks' as a sequence of stage tables)";
    }
    for (const region of tableRegions(text, CODEX_HOOKS_TABLE)) {
        const commands = readCodexHookCommands(region);
        if (commands.length === 0)
            return `a ${CODEX_HOOKS_TABLE} entry carries no command`;
        if (commands.some((command) => command.trim() === ""))
            return `a ${CODEX_HOOKS_TABLE} entry carries an empty command`;
        // The MatcherGroup shape: handler fields belong INSIDE `hooks = [...]`.
        // Without this the entry loads and is silently ignored.
        //
        // Scoped to OUR entry on purpose. A foreign entry with the wrong shape is
        // its owner's bug, and refusing to write bili's own correct entry because
        // of it would strand exactly the users who already run another hook tool.
        if (
            commands.some(isBiliCodexHookCommand) &&
            !isNestedHookRegion(region)
        )
            return `a ${CODEX_HOOKS_TABLE} entry must nest its handler in a 'hooks = [{ type = "command", ... }]' array (fields set directly on the entry are dropped by Codex, which registers nothing)`;
    }
    return undefined;
}
