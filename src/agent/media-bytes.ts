// #4111: the gate's oversize arms priced the RAW body at bytes/4 — a floor
// that only holds for text (real text density ≥ ~6.8 B/token, #2122) and
// wildly overbills inline media: a base64 screenshot is resolution-billed at
// ~2,000-4,000 B/token upstream, so a ~4MB image payload minted ~1M phantom
// tokens and tripped a "provably over window" refusal the real upstream never
// would have made. The relay's egress fuse already excludes media from its
// byte math (server/relay.ts — same caliber as preflight's doomed probe);
// this is the agent-lane twin: a recursive, protocol-agnostic walk of the
// wire shapes that carry inline media (anthropic {type:"base64",data} source
// blocks and redacted_thinking payloads, openai input_audio parts and data:
// URLs incl. file file_data, responses input_image whose image_url is a bare
// data-URL string (singular form), google inlineData), returning their byte
// mass so native refusal gates bill core text only. Keyed structurally (field
// names/types), never by content: a base64 blob pasted as TEXT (a
// {type:"text"} block or plain string content) is NOT media on any wire and
// stays billed as text — the genuinely-huge-text direction keeps its teeth.
export function mediaBytesOfWireBody(raw: string): number {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 0;
    }
    let mediaBytes = 0;
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const bytesOf = (s: string): number => Buffer.byteLength(s);
    const dataUrlBytes = (s: string): number => (s.startsWith("data:") ? bytesOf(s) : 0);
    const walk = (v: unknown): void => {
        if (Array.isArray(v)) {
            for (const item of v) walk(item);
            return;
        }
        if (!isObj(v)) return;
        if (typeof v.data === "string" && (v.type === "base64" || v.type === "redacted_thinking")) mediaBytes += bytesOf(v.data);
        if (typeof v.url === "string") mediaBytes += dataUrlBytes(v.url);
        if (typeof v.file_data === "string") mediaBytes += dataUrlBytes(v.file_data);
        // responses-wire input_image carries the whole data URL as a STRING
        // under image_url (singular form) — same shape family as the object form.
        if (typeof v.image_url === "string") mediaBytes += dataUrlBytes(v.image_url);
        if (isObj(v.input_audio) && typeof v.input_audio.data === "string") mediaBytes += bytesOf(v.input_audio.data);
        if (isObj(v.inlineData) && typeof v.inlineData.data === "string") mediaBytes += bytesOf(v.inlineData.data);
        for (const child of Object.values(v)) walk(child);
    };
    walk(parsed);
    return mediaBytes;
}
