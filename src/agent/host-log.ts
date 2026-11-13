// Shared host-safe log channel for the native lanes (#2827/#2831). These
// diagnostics run INSIDE the host agent process, where stdout/stderr IS the
// interactive TUI terminal (Pi editor, dsh TUI, opencode TUI, …). A console.*
// write lands on the physical screen bypassing the host renderer — text
// appears appended to whatever line holds the cursor (e.g. the input-box
// draft) until the next redraw clears it. Route mid-session events here
// instead: same durable record, zero terminal traffic. Boot-time banners that
// fire before the TUI takes over may still use console.* deliberately.
//
// Line grammar mirrors src/logger.ts (`<ts> [level] [v=<build>] <msg>` — ts is
// local wall clock, no zone suffix, #4535), so a shared log written by
// mixed-version hosts self-identifies every physical line; `origin` marks which lane wrote it ([native-client],
// [dsh-client], …). An EMPTY origin is allowed when the message already
// carries its own prefix (launcher attach diagnostics, #3200) — the separator
// is dropped so the line stays byte-identical to the legacy teeLog format.
// Best-effort — a failed append must never break the host; appendFileSync
// reopens by path on every call, so the proxy's rotation (rename to .old)
// can't strand these writes on a renamed inode.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { maskIpsInText, maskUrlsForDiagnostics, redactSecretsInText } from "../log-mask.js";
import { logTimestamp } from "../logger.js";
import { defaultLogFile } from "../paths.js";
import { VERSION } from "../version.js";

export function logHostEvent(level: "info" | "warn" | "error", origin: string, msg: string): void {
    try {
        const file = defaultLogFile();
        mkdirSync(path.dirname(file), { recursive: true });
        // #3651: these lines share the paste-able bili.log with proxy-side
        // lines, so they get the same sink-level safety net the proxy logger
        // applies at its choke point (#1718/#255/#897). Before this, client-
        // side events wrote real upstream hosts verbatim — the #3651 field log
        // leaked provider domains through [dsh-client] lines while every
        // proxy-side line masked them.
        const safe = maskUrlsForDiagnostics(maskIpsInText(redactSecretsInText(msg)));
        appendFileSync(file, `${logTimestamp()} [${level}] [v=${VERSION}] ${origin ? `${origin} ` : ""}${safe}\n`);
    } catch {
        // best-effort: logging must never break the host
    }
}
