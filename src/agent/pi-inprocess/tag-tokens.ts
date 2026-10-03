import { defaultCountTokens } from "acp-kernel";

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${Math.round(tokens / 1000)}K`;
}

export function stableTagTokens(text: string): string {
  return formatTokens(defaultCountTokens(text));
}

export function rewriteTagTokens(tag: string, body: string): string {
  return tag.replace(/tokens="[^"]*"/, `tokens="${stableTagTokens(body)}"`);
}