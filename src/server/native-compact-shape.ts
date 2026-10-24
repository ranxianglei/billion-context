// #2411 Class A: detect host-native compaction requests on the OpenAI wire so
// bili can stand down its own compression surface for that one turn.
//
// Evidence (ezjbc live captures, #2411 thread, unified Trae client via
// sidecar -> bili, 2026-10-18~23 window):
// - 17/17 native auto-compaction requests carry the host's summarization
//   template as the LAST user message; 38/40 session-store copies are
//   byte-identical across 21 days / 9 models / 2 channels. Store original:
//   6,861 raw-LF bytes, sha256 d56eeae339bd8007… (reporter's correction —
//   his first-posted e5a1804e… was the CRLF-normalized digest). The
//   thread-pasted copy embedded in the test fixture lost 4 bytes (newlines)
//   in markdown transit — hence anchors below instead of a full-text hash.
// - Both known variants (6861-char Trae mainstream, 6980-char legacy with an
//   <analysis> block) share line 1 and the final instruction sentence. The
//   Trae-only "<user_input/>" line and the <summary>/<analysis> tags are
//   deliberately NOT anchors: variant-specific, and model free-form products
//   never matched them anyway (#2849's phrase pair has zero hits here).
// - Secondary anchor "/compact": manual slash-command form from static
//   bytecode (module 79484 QP predicate); zero occurrences in the 17 live
//   samples, kept as a cheap secondary signal for manual triggers.
// - The compaction PRODUCT (re-injected head-of-history user turn such as
//   "## 1. Primary Request and Intent") is deliberately NOT matched — it is
//   model free-form per the template's <example>, so product-shape matching
//   is fragile; instruction-shape matching is stable (40/40).
//
// Evidence-permitlist discipline (#970/#1104): this predicate gates ACP
// surface suppression on ONE wire family only. It fails open — any structural
// deviation (parts-array content, non-user last message, missing either
// anchor, unparseable body) leaves the request fully instrumented, exactly as
// before this module existed.

/** First line of both known template variants (offset 0, 40/40 hits). */
const NATIVE_COMPACT_LEAD_ANCHOR = "Your task is to create a detailed summary of the conversation so far";
/** Final instruction sentence shared by both variants (false-positive guard). */
const NATIVE_COMPACT_TAIL_ANCHOR = "Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.";
/** Manual slash-command trigger form (static bytecode evidence only). */
const NATIVE_COMPACT_SLASH_FORM = "/compact";

// Leading ACP render-tag prefix(es) the host may echo back verbatim — bili
// renders refs into outbound messages (renderTags), clients persist those
// bytes and resend them. Grammar mirrors src/server/chain-artifacts.ts
// (unescaped wire form); hex escapes per KDD #2.
const LEADING_ACP_TAGS = /^\s*(?:\x3cacp\s+tokens="\d+(?:\.\d+)?K?"\s+type="[^"]*"\s*\x3em\d{1,8}\x3c\/acp\x3e\s*)+/;

/** Strip leading ACP render-tag prefix(es) plus surrounding whitespace. */
export function stripLeadingAcpTags(text: string): string {
    return text.replace(LEADING_ACP_TAGS, "").trimStart();
}

/** True when the request IS a host-native compaction act: the last user
 *  message is the host's summarization template (or the manual "/compact"
 *  form). See the module header for anchors and evidence. Fails open. */
export function looksLikeNativeCompactionRequest(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== "object") return false;
    const messages = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (!last || typeof last !== "object") return false;
    const rec = last as { role?: unknown; content?: unknown };
    if (rec.role !== "user" || typeof rec.content !== "string") return false;
    const t = stripLeadingAcpTags(rec.content).trimEnd();
    if (t === "") return false;
    if (t === NATIVE_COMPACT_SLASH_FORM) return true;
    return t.startsWith(NATIVE_COMPACT_LEAD_ANCHOR) && t.includes(NATIVE_COMPACT_TAIL_ANCHOR);
}
