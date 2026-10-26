/** #2196: argv safety contract for the cmd.exe pass-through path.
 *
 * On Windows, .cmd/.bat shims and extensionless names cannot be executed by
 * CreateProcess, so bili wraps them as `comspec /d /s /c "<line>"` (#679) and
 * lets cmd.exe re-parse that line. cmd.exe has NO escape mechanism: embedded
 * double quotes split tokens, %VAR% expands, &|<>^() act as command operators,
 * empty tokens vanish, and line breaks terminate the command. An argument in
 * any of those shapes CANNOT survive that trip verbatim — the old code just
 * let it be mangled (or worse, interpreted) silently.
 *
 * This module defines which tokens are unsafe for that path so every comspec
 * wrap site (launcher planClientSpawn, dsh-channel planDshSpawn) refuses with
 * an actionable error instead of corrupting user argv. Direct-spawn forms
 * (.exe and friends) never go through this check: Node encodes their argv
 * losslessly itself.
 */

/** Returns a human-readable reason why this token cannot cross the cmd.exe
 *  line parser verbatim, or undefined when it can (the safe set): plain text,
 *  whitespace-bearing text quoted whole, Unicode, semicolons/commas/equals,
 *  backslashes in even runs or outside quoted positions, and `!` (delayed
 *  expansion is opt-in via ^setlocal enabledelayedexpansion^ and standard npm
 *  shims never enable it). The offending CONTENT is deliberately not part of
 *  the return value — callers may log the reason but must not echo the token
 *  (prompts routinely carry secrets; see AGENTS.md log-masking rule). */
export function winCmdUnsafeToken(token: string): string | undefined {
    if (token === "") return "an empty argument";
    if (token.includes('"')) return "a double quote";
    if (token.includes("%")) return "% (cmd.exe expands %VAR%)";
    if (/[&|<>^()]/.test(token)) return "cmd metacharacters (& | < > ^ ( ))";
    if (/[\r\n]/.test(token)) return "a line break";
    // Odd trailing-backslash run matters only when quoteWinToken will wrap the
    // token in quotes (whitespace-bearing, quote-free): the final `\` then
    // escapes the closing quote in MSVCRT parsing and swallows it.
    if (/\s/.test(token)) {
        const trail = /\\+$/.exec(token)?.[0].length ?? 0;
        if (trail % 2 === 1) return "an odd number of trailing backslashes";
    }
    return undefined;
}

/** Builds the refusal error for `what` + `reason` with a lane-specific hint
 *  pointing at the lossless alternatives. */
export function winCmdRefusalError(what: string, reason: string, hint: string): Error {
    return new Error(
        `this ${what} cannot be passed through cmd.exe: it contains ${reason}. ` +
        `cmd.exe re-parses the whole command line — embedded quotes split tokens, %VAR% expands, &|<>^() are command operators — so such arguments arrive corrupted or execute unintended commands. ${hint}`,
    );
}
