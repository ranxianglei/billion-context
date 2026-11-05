// #4482: body dumps exist for byte-exact forensics (prefix diffs, rejection
// post-mortems), so their content is NEVER redacted — the full plaintext
// conversation body lands on disk and may carry real credentials (tool
// arguments, host-injected content). Every plaintext-body dump file therefore
// starts with this standing warning so a dump that gets shared (issue
// attachments, pastes) announces what it carries before the reader scrolls
// past it. Keep the text free of ": " — dump parsers treat head lines as
// headers and the first line is skipped as the request line.
export const DUMP_PLAINTEXT_BANNER = "PLAINTEXT DUMP — full conversation body, may contain credentials; scrub before sharing";

/** Drop one leading banner line if `text` starts with it (LF or CRLF). */
export function stripDumpBanner(text: string): string {
    const nl = text.indexOf("\n");
    if (nl > 0 && text.slice(0, nl).replace(/\r$/, "") === DUMP_PLAINTEXT_BANNER) return text.slice(nl + 1);
    return text;
}
