// Ticket 01: top-level TOML scalar surgery for ~/.codex/config.toml.
//
// Deliberately NOT a TOML parser. Only top-level `key = "value"` lines ABOVE
// the first table header are touched, so every user comment, blank line,
// ordering and nested `[table]` survives byte-for-byte — the content-ownership
// rule from the Codex proxy spec: bili updates only its own field and never
// rewrites the rest of the file.

/** A located top-level scalar. `line` is a 0-based index into `text.split("\n")`. */
interface TopLevelScalar {
    key: string;
    value: string;
    line: number;
}

/** TOML basic (double-quoted) and literal (single-quoted) string bodies. A
 *  line whose value is an array/inline-table/multiline string is NOT a scalar
 *  we can own — it is reported as not-found rather than mis-parsed. */
const SCALAR_RE =
    /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/;

/** Any TOML table header, including `[[array-of-tables]]`. In TOML every new
 *  header ENDS the previous table's scope — an array-of-tables header included.
 *  Treating only single-bracket headers as boundaries lets an inserted or read
 *  scalar bleed into a following `[[...]]` element, where Codex's serde drops
 *  unknown keys silently (the exact failure class this module exists to avoid). */
function parseTableHeader(
    line: string,
): { kind: "table" | "array"; name: string } | undefined {
    const m = /^\s*(\[\[?)([^\]]+)(\]\]?)\s*(?:#.*)?$/.exec(line);
    if (m === null) return undefined;
    const opening = m[1]!;
    const closing = m[3]!;
    if (opening === "[[" && closing !== "]]") return undefined;
    if (opening === "[" && closing !== "]") return undefined;
    return { kind: opening === "[[" ? "array" : "table", name: m[2]!.trim() };
}

function decode(raw: string, quoted: "basic" | "literal"): string {
    if (quoted === "literal") return raw;
    try {
        const parsed: unknown = JSON.parse(`"${raw}"`);
        return typeof parsed === "string" ? parsed : raw;
    } catch {
        return raw;
    }
}

function preserveInlineComment(original: string, rendered: string): string {
    let quote: "basic" | "literal" | undefined;
    let escaped = false;
    for (let i = 0; i < original.length; i++) {
        const char = original[i]!;
        if (quote === "basic") {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quote = undefined;
        } else if (quote === "literal") {
            if (char === "'") quote = undefined;
        } else if (char === '"') quote = "basic";
        else if (char === "'") quote = "literal";
        else if (char === "#") return `${rendered} ${original.slice(i).trimEnd()}`;
    }
    return rendered;
}

/** Locate a top-level scalar, stopping at the first table header: a key after
 *  `[some.table]` belongs to that table, not to the file root. */
export function findTopLevelScalar(
    text: string,
    key: string,
): TopLevelScalar | undefined {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line.startsWith("[")) return undefined;
        if (line === "" || line.startsWith("#")) continue;
        const m = SCALAR_RE.exec(line);
        if (m === null || m[1] !== key) continue;
        return {
            key,
            value:
                m[2] !== undefined ? decode(m[2], "basic") : decode(m[3]!, "literal"),
            line: i,
        };
    }
    return undefined;
}

/** Set (or insert) a top-level scalar. JSON.stringify emits a valid TOML basic
 *  string — both grammars escape `\` and `"` identically — which is the same
 *  serialization plugin-install.ts `codexBlock` relies on. */
export function setTopLevelScalar(
    text: string,
    key: string,
    value: string,
): string {
    const rendered = `${key} = ${JSON.stringify(value)}`;
    const lines = text.split("\n");
    const existing = findTopLevelScalar(text, key);
    if (existing !== undefined) {
        lines[existing.line] = preserveInlineComment(
            lines[existing.line]!,
            rendered,
        );
        return lines.join("\n");
    }
    // Insert after the last top-level key; with none, at the very top so the
    // key can never land inside a nested table.
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line.startsWith("[")) break;
        if (line === "" || line.startsWith("#")) continue;
        at = i + 1;
    }
    lines.splice(at, 0, rendered);
    return lines.join("\n");
}

/** Delete a top-level scalar line. Only that line goes; surrounding comments
 *  and blank lines are left exactly as the user had them. */
export function removeTopLevelScalar(text: string, key: string): string {
    const existing = findTopLevelScalar(text, key);
    if (existing === undefined) return text;
    const lines = text.split("\n");
    lines.splice(existing.line, 1);
    return lines.join("\n");
}

/** A located scalar inside an exact TOML table. */
interface TableScalar extends TopLevelScalar {
    table: string;
}

export function findTableScalar(
    text: string,
    table: string,
    key: string,
): TableScalar | undefined {
    const lines = text.split("\n");
    let active = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        const header = parseTableHeader(line);
        if (header !== undefined) {
            if (active) return undefined;
            active = header.kind === "table" && header.name === table;
            continue;
        }
        if (!active || line === "" || line.startsWith("#")) continue;
        const match = SCALAR_RE.exec(line);
        if (!match || match[1] !== key) continue;
        return {
            table,
            key,
            value:
                match[2] !== undefined
                    ? decode(match[2], "basic")
                    : decode(match[3]!, "literal"),
            line: i,
        };
    }
    return undefined;
}

export function setTableScalar(
    text: string,
    table: string,
    key: string,
    value: string,
): string {
    const lines = text.split("\n");
    const rendered = `${key} = ${JSON.stringify(value)}`;
    const existing = findTableScalar(text, table, key);
    if (existing) {
        lines[existing.line] = preserveInlineComment(
            lines[existing.line]!,
            rendered,
        );
        return lines.join("\n");
    }
    let tableLine = -1;
    let tableEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const header = parseTableHeader(lines[i]!);
        if (header === undefined) continue;
        if (tableLine >= 0) {
            tableEnd = i;
            break;
        }
        if (header.kind === "table" && header.name === table) tableLine = i;
    }
    if (tableLine < 0) {
        const prefix =
            text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
        return `${prefix}\n[${table}]\n${rendered}\n`;
    }
    lines.splice(tableEnd, 0, rendered);
    return lines.join("\n");
}

export function removeTableScalar(
    text: string,
    table: string,
    key: string,
): string {
    const existing = findTableScalar(text, table, key);
    if (!existing) return text;
    const lines = text.split("\n");
    lines.splice(existing.line, 1);
    return lines.join("\n");
}

/** Insert a raw (already rendered) line inside an exact table, after its last
 *  scalar. Unlike `setTableScalar` this writes NON-string TOML (booleans,
 *  arrays, inline tables) — used for `[features] hooks = true`-style switches
 *  and for array-of-inline-table hook entries. Existing content is untouched;
 *  when the key is already present the caller decides (replace vs. refuse). */
export function insertTableRaw(
    text: string,
    table: string,
    rendered: string,
): string {
    const lines = text.split("\n");
    let tableLine = -1;
    let tableEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
        const header = parseTableHeader(lines[i]!);
        if (header === undefined) continue;
        if (tableLine >= 0) {
            tableEnd = i;
            break;
        }
        if (header.kind === "table" && header.name === table) tableLine = i;
    }
    if (tableLine < 0) {
        const prefix =
            text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
        return `${prefix}\n[${table}]\n${rendered}\n`;
    }
    // Land before trailing blank/comment lines so the new scalar stays inside
    // the table's own block instead of after a user's separator comment.
    let at = tableEnd;
    while (at > tableLine + 1) {
        const line = lines[at - 1]!.trim();
        if (line !== "" && !line.startsWith("#")) break;
        at--;
    }
    lines.splice(at, 0, rendered);
    return lines.join("\n");
}

/** Every region of `text` covered by an exact `[table]` or `[[table]]` header
 *  (until the next header at any level). Lets a caller assert "this table is
 *  ours" before a rewrite, instead of assuming the shape it expects.
 *
 *  Array-of-tables headers are matched too, and deliberately carry their
 *  brackets into the reported region: Codex requires `[[hooks.SessionStart]]`,
 *  and a caller that rewrote or dropped the region while leaving `[hooks...]`
 *  behind would silently corrupt the array into a map. */
export function tableRegions(text: string, table: string): string[] {
    const lines = text.split("\n");
    const out: string[] = [];
    let current: string[] | undefined;
    for (const line of lines) {
        const header = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/.exec(line);
        if (header) {
            if (current !== undefined) out.push(current.join("\n"));
            const raw = header[1];
            const inner = raw?.replace(/^\[\[?/, "").replace(/\]\]?$/, "").trim();
            current = inner === table ? [line] : undefined;
            continue;
        }
        if (current !== undefined) current.push(line);
    }
    if (current !== undefined) out.push(current.join("\n"));
    return out.filter((region) => region.trim().startsWith("["));
}
