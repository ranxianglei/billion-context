import { emitStreamError, emitPreflightError } from "./stream-error.js";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip, pipePluginJson } from "./plugin.js";
import { startServer } from "./server.js";

// Exit-enumeration matrix (#588): every wire exit x cross-cutting concern
// must have an explicit cell here. `Record<WireExitId, ExitCell>` is the
// compile-time guard — adding an exit to WIRE_EXITS without filling its row
// in EVERY concern table fails typecheck. `implementer` holds live symbol
// references (moving/deleting an implementation breaks the import), and
// `coveredBy` names the test file(s) asserting the cell's contract — the
// matrix test (tests/wire-exit-matrix.test.ts) fails if a listed file is
// missing, and behavior tests iterate WIRE_EXITS so a new exit with no
// scenario coverage fails the run. This is a registry only: no runtime
// behavior is routed through it.

export const WIRE_EXITS = [
    "proxy-openai-sse",
    "proxy-anthropic-sse",
    "proxy-responses-sse",
    "proxy-json",
    "plugin-chat-sse",
    "plugin-responses-sse",
    "plugin-json",
] as const;

export type WireExitId = (typeof WIRE_EXITS)[number];

export interface ExitCell {
    readonly implementer: readonly unknown[];
    readonly contract: string;
    readonly coveredBy: readonly string[];
}

export const ERROR_DELIVERY: Record<WireExitId, ExitCell> = {
    "proxy-openai-sse": {
        implementer: [emitStreamError, emitPreflightError, startServer],
        contract: "mid-stream upstream failure → inline `error` delta + finish + [DONE]; late (early-committed) preflight failure → top-level error object + [DONE] in-band",
        coveredBy: ["tests/proxy-stream-error.test.ts", "tests/wire-exit-matrix.test.ts", "tests/wire-exit-gap-cells.test.ts"],
    },
    "proxy-anthropic-sse": {
        implementer: [emitStreamError, emitPreflightError, startServer],
        contract: "mid-stream failure → content_block_delta error + message_stop; late preflight failure → event: error payload in-band",
        coveredBy: ["tests/proxy-stream-error.test.ts", "tests/preflight-hold.test.ts", "tests/wire-exit-gap-cells.test.ts"],
    },
    "proxy-responses-sse": {
        implementer: [emitStreamError, emitPreflightError, startServer],
        contract: "mid-stream failure → full item lifecycle (added → delta → done) + response.failed; late preflight failure → event: error in-band",
        coveredBy: ["tests/proxy-stream-error.test.ts", "tests/preflight-hold.test.ts", "tests/wire-exit-gap-cells.test.ts"],
    },
    "proxy-json": {
        implementer: [emitPreflightError, startServer],
        contract: "pre-headers failure → 4xx/5xx `{error}` JSON; post-early-commit failure → identical `{error}` JSON body on the already-committed 200",
        coveredBy: ["tests/preflight-hold.test.ts", "tests/preflight-fail-fast.test.ts", "tests/wire-exit-gap-cells.test.ts"],
    },
    "plugin-chat-sse": {
        implementer: [pipePluginChatWithStrip],
        contract: "byte-faithful passthrough: pre-stream fetch failure → JSON `{error: formatUpstreamError}` before any SSE byte; upstream cut without terminal event → synthesized terminal byte when a finish reason was delivered, else protocol-native in-band error event (#721); client abort → clean end",
        coveredBy: ["tests/issue411-abort-usage.test.ts", "tests/plugin-agent.test.ts", "tests/plugin-truncation-weak-overflow.test.ts"],
    },
    "plugin-responses-sse": {
        implementer: [pipePluginResponsesWithStrip],
        contract: "same as plugin-chat-sse, responses wire",
        coveredBy: ["tests/issue411-abort-usage.test.ts", "tests/plugin-truncation-weak-overflow.test.ts"],
    },
    "plugin-json": {
        implementer: [pipePluginJson],
        contract: "upstream non-2xx/fetch failure → `{error: formatUpstreamError}` JSON; client abort mid-body → clean end, timer cleared",
        coveredBy: ["tests/issue411-abort-usage.test.ts", "tests/host-usage-postfold.test.ts"],
    },
};

export const ABORT_PROPAGATION: Record<WireExitId, ExitCell> = {
    "proxy-openai-sse": {
        implementer: [startServer],
        contract: "client disconnects mid-stream → the in-flight upstream request is destroyed (no orphaned summarization/forward), session lock released",
        coveredBy: ["tests/wire-exit-matrix.test.ts", "tests/wire-exit-gap-cells.test.ts"],
    },
    "proxy-anthropic-sse": {
        implementer: [startServer],
        contract: "same as proxy-openai-sse, anthropic wire",
        coveredBy: ["tests/wire-exit-matrix.test.ts"],
    },
    "proxy-responses-sse": {
        implementer: [startServer],
        contract: "same as proxy-openai-sse, responses wire",
        coveredBy: ["tests/wire-exit-matrix.test.ts"],
    },
    "proxy-json": {
        implementer: [startServer],
        contract: "client disconnects while awaiting the buffered JSON → upstream request destroyed",
        coveredBy: ["tests/wire-exit-matrix.test.ts"],
    },
    "plugin-chat-sse": {
        implementer: [pipePluginChatWithStrip],
        contract: "client abort → upstream stream cancelled, fetch-util timer cleared, sniffed usage kept (#411); repeated aborts do not accumulate timers",
        coveredBy: ["tests/issue411-abort-usage.test.ts"],
    },
    "plugin-responses-sse": {
        implementer: [pipePluginResponsesWithStrip],
        contract: "same as plugin-chat-sse, responses wire",
        coveredBy: ["tests/issue411-abort-usage.test.ts"],
    },
    "plugin-json": {
        implementer: [pipePluginJson],
        contract: "client abort mid-body → no crash, timer cleared (#411)",
        coveredBy: ["tests/issue411-abort-usage.test.ts"],
    },
};

export const HOST_USAGE_PASSTHROUGH: Record<WireExitId, ExitCell> = {
    "proxy-openai-sse": {
        implementer: [startServer],
        contract: "provider-measured (post-fold) usage credited to the internal ledger and forwarded to the host verbatim — no baseline backfill (#660)",
        coveredBy: ["tests/host-usage-postfold.test.ts"],
    },
    "proxy-anthropic-sse": {
        implementer: [startServer],
        contract: "message_start/message_delta usage frames credited, forwarded verbatim",
        coveredBy: ["tests/host-usage-postfold.test.ts"],
    },
    "proxy-responses-sse": {
        implementer: [startServer],
        contract: "response.completed usage frame credited (issue #589 frame shape), forwarded verbatim",
        coveredBy: ["tests/issue589-usage-frame.test.ts", "tests/host-usage-postfold.test.ts"],
    },
    "proxy-json": {
        implementer: [startServer],
        contract: "non-stream usage object credited; no session → skipped (title-gen must not clobber lastInputTokens); forwarded verbatim",
        coveredBy: ["tests/host-usage-postfold.test.ts"],
    },
    "plugin-chat-sse": {
        implementer: [pipePluginChatWithStrip],
        contract: "sniffed usage credited unless the call is session-less (#460 title-gen skip); stream bytes untouched",
        coveredBy: ["tests/host-usage-postfold.test.ts", "tests/issue411-abort-usage.test.ts"],
    },
    "plugin-responses-sse": {
        implementer: [pipePluginResponsesWithStrip],
        contract: "sniffed usage credited; verbatim variant skips accounting by design",
        coveredBy: ["tests/host-usage-postfold.test.ts"],
    },
    "plugin-json": {
        implementer: [pipePluginJson],
        contract: "JSON usage object credited; response body forwarded verbatim",
        coveredBy: ["tests/host-usage-postfold.test.ts"],
    },
};

export const EXIT_CONCERNS = {
    errorDelivery: ERROR_DELIVERY,
    abortPropagation: ABORT_PROPAGATION,
    hostUsagePassthrough: HOST_USAGE_PASSTHROUGH,
} as const;

export type ExitConcernId = keyof typeof EXIT_CONCERNS;
