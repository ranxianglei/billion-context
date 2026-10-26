export interface MessageFilterContext {
  text: string;
  role: string;
  messageIndex: number;
  totalMessages: number;
  toolName?: string;
  modelContextLimit?: number;
}

export interface FilterResult {
  action: "keep" | "modify" | "drop";
  text?: string;
  reason?: string;
}

export interface MessageFilter {
  name: string;
  version: string;
  description: string;
  filter(ctx: MessageFilterContext): FilterResult;
  keepLastOnly?: boolean;
}

export type MessageFilterConfig = Record<string, { enabled: boolean }>;

export interface MessageFiltersConfig {
  enabled: boolean;
  filters: MessageFilterConfig;
}
