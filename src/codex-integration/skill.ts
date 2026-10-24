// Ticket 08: the ACP skill face for native Codex.
//
// Codex discovers reusable procedures as skills under
// `<CODEX_HOME>/skills/<name>/SKILL.md` (YAML frontmatter + markdown body) —
// the same extension point `skills/.system/*` and third-party skills use. The
// Claude lane ships the equivalent as a slash command (`/acp-cache`, see
// CLAUDE_ACP_CACHE_COMMAND in plugin-install.ts); Codex has no slash-command
// file, so the skill IS the parity surface: it tells the model which ACP tools
// exist on the `bili` MCP server and when to reach for them.
//
// Ownership: the content is embedded here (not read from a shipped asset) so
// every install form — checkout, global npm, dsh profile copy — carries the
// same bytes. bili rewrites the file only while the frontmatter still names
// `bili`; a same-named skill the user wrote themselves is reported, never
// clobbered.

import fs from "node:fs";
import path from "node:path";
import { resolveCodexHome } from "../client-config.js";

/** Directory name under `<CODEX_HOME>/skills`. */
const CODEX_SKILL_NAME = "bili";

/** Ownership marker. A skill file carrying this comment is bili's and may be
 *  refreshed in place; a same-named file WITHOUT it belongs to the user (or
 *  another tool) and is never written or deleted — the same content-based rule
 *  the model route and the hook face use. The name alone is not proof. */
const CODEX_SKILL_MARKER =
    "<!-- bili-managed: refreshed by `bili plugin install codex`; local edits are overwritten -->";

/** The skill document bili installs. Kept as a constant so `codexSkillStatus`
 *  and the installer cannot drift apart. */
export const CODEX_SKILL_MARKDOWN = `---
name: bili
description: billion-context (bili) ACP context compression for this Codex session. Use when the conversation feels summarized, when you need to read or search context that was compressed away, or when checking whether compression is working.
---

${CODEX_SKILL_MARKER}

# billion-context (bili) for Codex

bili keeps long Codex sessions inside the model's context window by folding
consumed older turns into compressed blocks and re-expanding them on demand.
The model route is persistent (bili owns one field in \`config.toml\`), and the
tools below ride along on the \`bili\` MCP server.

## Tools

| Tool | Use it for |
| --- | --- |
| \`acp_status\` | Context usage for this session: what is live, what is folded, compressible ranges with their refs |
| \`acp_cache\` | Prompt-cache reconciliation for this session: hit rate, what caused a miss, what a fold cost |
| \`search_context\` | Keyword search across compressed block summaries — use this BEFORE decompressing blindly |
| \`decompress\` | Restore a folded range by \`blockId\` (or \`startId\`/\`endId\`); \`full: true\` restores originals |
| \`compress\` | Fold consumed ranges into one summary you write (usually automatic; call it only when asked) |
| \`acp_retrieve\` | Read back the full original text behind an \`[acp-stored #mNNNNN]\` placeholder |

## Rules of thumb

- Retrieve narrowly: \`search_context\` first, then \`decompress\` the one block that matters. \`full: true\` is a last resort.
- Compression is automatic under pressure; a manual \`compress\` is a deliberate optimization, not routine hygiene.
- Numbers from \`acp_cache\`/\`acp_status\` describe THIS session. Never present them as another session's.
- A tool call failing with \`bili proxy unreachable\` means the local proxy is down: run \`bili service status\` (\`bili service restart\` to fix), then retry.

## Troubleshooting

- Route check: \`bili doctor\` (look at \`codex model route\` and the CC Switch section).
- Install or refresh the integration: \`bili plugin install codex\`. Revert it with \`bili plugin remove codex\`.
- CC Switch Direct mode installs a reversible route on the active provider's \`base_url\`. If CC Switch
  rewrites or re-syncs that provider, bili reports a conflict and leaves the field alone rather than
  fighting it — re-run \`bili plugin install codex\` after switching CC Switch modes.
`;

/** `<CODEX_HOME>/skills/bili`. */
export function codexSkillDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(resolveCodexHome(env), "skills", CODEX_SKILL_NAME);
}

/** `<CODEX_HOME>/skills/bili/SKILL.md`. */
export function codexSkillFile(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(codexSkillDir(env), "SKILL.md");
}

/** The frontmatter name a skill file declares, when parseable. */
export function readSkillName(text: string): string | undefined {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    const body = frontmatter?.[1];
    if (body === undefined) return undefined;
    const match = /^name:\s*(.+?)\s*$/m.exec(body);
    const name = match?.[1];
    if (name === undefined) return undefined;
    return name.replace(/^["']|["']$/g, "");
}

type CodexSkillState = "installed" | "missing" | "outdated" | "foreign";

/** Disk state of the skill face. `outdated` means our marker is present but the
 *  bytes differ (an upgrade is due, or the user edited a bili-managed file);
 *  `foreign` means a same-named skill bili does not own. */
export function codexSkillStatus(
    env: NodeJS.ProcessEnv = process.env,
): CodexSkillState {
    let text: string;
    try {
        text = fs.readFileSync(codexSkillFile(env), "utf8");
    } catch {
        return "missing";
    }
    if (text === CODEX_SKILL_MARKDOWN) return "installed";
    return text.includes(CODEX_SKILL_MARKER) ? "outdated" : "foreign";
}

interface CodexSkillInstall {
    state: CodexSkillState | "written";
    note: string;
    written: boolean;
}

/** Install or refresh the skill. A file bili does not own is left alone. */
export function installCodexSkill(
    env: NodeJS.ProcessEnv = process.env,
): CodexSkillInstall {
    const file = codexSkillFile(env);
    const state = codexSkillStatus(env);
    if (state === "installed")
        return {
            state,
            note: "ACP skill already installed",
            written: false,
        };
    if (state === "foreign")
        return {
            state,
            note: `${file} exists but is not a bili skill — left untouched`,
            written: false,
        };
    fs.mkdirSync(codexSkillDir(env), { recursive: true });
    fs.writeFileSync(file, CODEX_SKILL_MARKDOWN, { mode: 0o644 });
    return {
        state: "written",
        note:
            state === "missing"
                ? `ACP skill installed -> ${file}`
                : `ACP skill refreshed -> ${file}`,
        written: true,
    };
}

/** Remove the skill file only when it is ours; drops the directory when empty. */
export function removeCodexSkill(env: NodeJS.ProcessEnv = process.env): {
    removed: boolean;
    note: string;
} {
    const state = codexSkillStatus(env);
    if (state === "missing")
        return { removed: false, note: "ACP skill not installed" };
    if (state === "foreign")
        return {
            removed: false,
            note: "ACP skill directory is not owned by bili — left untouched",
        };
    fs.unlinkSync(codexSkillFile(env));
    try {
        fs.rmdirSync(codexSkillDir(env));
    } catch {
        // A user may keep notes next to the skill; a non-empty dir stays.
    }
    return { removed: true, note: "ACP skill removed" };
}
