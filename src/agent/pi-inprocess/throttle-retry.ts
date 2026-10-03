import { extractText } from "./messages.js";

// Load-bearing string: must contain "429" + "rate limit" so pi's post-run
// classifier (isRetryableAssistantError) treats the rewritten message as
// retryable, while the "rate limit" hit on pi-ai's NON_OVERFLOW exclusion
// patterns keeps it off the context-overflow/compaction path. It must match
// no NON_RETRYABLE quota/billing pattern. Pinned by tests/throttle-retry.test.ts.
export const THROTTLE_RETRY_ERROR_MESSAGE = "429 rate limit: Too many tokens, please wait before trying again.";

export const THROTTLE_KICK_SENTINEL = "[ACP:provider-throttle]";
export const THROTTLE_KICK_TEXT = `${THROTTLE_KICK_SENTINEL} The previous assistant response was interrupted by a provider rate limit (transient, not a real failure). Resume the task exactly where it left off — do not re-run completed steps and do not discuss the interruption unless asked.`;

const BEDROCK_THROTTLE_PHRASE = /too many tokens, please wait before trying again/i;
const THROTTLE_NAME = /throttl/i;
const OVERFLOW_GUARD = /prompt is too long|request_too_large|exceeds the context window|maximum context length|input token count.*exceeds|reduce the length of the messages|exceeded model token limit|context[_ ]length[_ ]exceeded/i;
const QUOTA_GUARD = /quota exceeded|insufficient_quota|out of budget|available balance|monthly usage limit|free usage limit|billing/i;

export interface ThrottleErrorProbe {
  role: string;
  stopReason?: string;
  errorMessage?: string;
  content: unknown;
}

export function isThrottleError(msg: ThrottleErrorProbe): boolean {
  if (msg.role !== "assistant" || msg.stopReason !== "error") return false;
  const haystack = `${msg.errorMessage ?? ""}\n${extractText(msg.content)}`;
  if (OVERFLOW_GUARD.test(haystack)) return false;
  if (QUOTA_GUARD.test(haystack)) return false;
  if (THROTTLE_NAME.test(msg.errorMessage ?? "")) return true;
  return BEDROCK_THROTTLE_PHRASE.test(haystack);
}

export function isKickMessage(msg: { role: string; content: unknown }): boolean {
  if (msg.role !== "user") return false;
  return extractText(msg.content).trimStart().startsWith(THROTTLE_KICK_SENTINEL);
}

export interface ThrottleRetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMode?: "exponential" | "fixed";
}

export interface ResolvedThrottleRetry {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMode: "exponential" | "fixed";
}

export const DEFAULT_THROTTLE_RETRY: ResolvedThrottleRetry = {
  enabled: true,
  maxRetries: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 300_000,
  backoffMode: "exponential",
};

export function resolveThrottleRetry(cfg: boolean | ThrottleRetryConfig | undefined): ResolvedThrottleRetry {
  if (cfg === false) return { ...DEFAULT_THROTTLE_RETRY, enabled: false };
  const c = typeof cfg === "object" ? cfg : {};
  const base = Math.max(1, Math.floor(c.baseDelayMs ?? DEFAULT_THROTTLE_RETRY.baseDelayMs));
  const explicitMax = typeof c.maxDelayMs === "number" ? Math.floor(c.maxDelayMs) : undefined;
  const maxDelay = Math.max(base, explicitMax ?? DEFAULT_THROTTLE_RETRY.maxDelayMs);
  return {
    enabled: c.enabled !== false,
    maxRetries: Math.max(1, Math.floor(c.maxRetries ?? DEFAULT_THROTTLE_RETRY.maxRetries)),
    baseDelayMs: base,
    maxDelayMs: maxDelay,
    backoffMode: c.backoffMode ?? "exponential",
  };
}

export function throttleDelayMs(kickNumber: number, r: ResolvedThrottleRetry): number {
  const delay = r.backoffMode === "exponential" ? r.baseDelayMs * 2 ** (Math.max(1, kickNumber) - 1) : r.baseDelayMs;
  return Math.min(delay, r.maxDelayMs);
}

export interface ThrottleEpisodeState {
  attempts: number;
  kicks: number;
  candidate: boolean;
}

export const INITIAL_THROTTLE_STATE: ThrottleEpisodeState = { attempts: 0, kicks: 0, candidate: false };

export class ThrottleEpisode {
  state: ThrottleEpisodeState = { ...INITIAL_THROTTLE_STATE };
  private cancel: AbortController | null = null;

  reset(): void {
    this.state = { ...INITIAL_THROTTLE_STATE };
    if (this.cancel) {
      this.cancel.abort();
      this.cancel = null;
    }
  }

  onProgress(): void {
    this.reset();
  }

  onUserMessage(kick: boolean): void {
    if (!kick) this.reset();
  }

  onThrottleError(maxRetries: number): "rewrite" | "exhausted" {
    if (this.state.attempts >= maxRetries) {
      this.state = { ...this.state, candidate: false };
      return "exhausted";
    }
    this.state = { attempts: this.state.attempts + 1, kicks: this.state.kicks, candidate: true };
    return "rewrite";
  }

  onNonThrottleError(): void {
    this.state = { ...this.state, candidate: false };
  }

  readyToKick(maxRetries: number): boolean {
    return this.state.candidate && this.state.attempts < maxRetries;
  }

  onKickStarted(): void {
    this.state = { ...this.state, kicks: this.state.kicks + 1 };
  }

  onKickCancelled(): void {
    this.reset();
  }

  sleepController(): AbortController {
    if (!this.cancel) this.cancel = new AbortController();
    return this.cancel;
  }

  cancelSleep(): void {
    this.cancel?.abort();
  }
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<"ok" | "aborted"> {
  const end = Date.now() + ms;
  for (;;) {
    if (signal.aborted) return "aborted";
    const remaining = end - Date.now();
    if (remaining <= 0) return "ok";
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
}
