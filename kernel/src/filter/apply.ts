import { listMessageFilters } from "./registry.js";
import type { CoreMessage } from "../types.js";
import type {
  FilterResult,
  MessageFilterContext,
  MessageFiltersConfig,
} from "./types.js";

export interface ApplyResult {
  messages: CoreMessage[];
  partsFiltered: number;
  partsDropped: number;
  partsModified: number;
}

export function applyMessageFilters(
  messages: CoreMessage[],
  config: MessageFiltersConfig | undefined,
): ApplyResult {
  if (!config?.enabled) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }

  const active = listMessageFilters().filter(
    (filter) => config.filters?.[filter.name]?.enabled !== false,
  );
  if (active.length === 0) {
    return { messages, partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  }

  let working = messages.map((message) => ({ ...message }));
  const tally = { partsFiltered: 0, partsDropped: 0, partsModified: 0 };
  const total = working.length;

  const immediate = active.filter((filter) => !filter.keepLastOnly);
  for (let index = 0; index < working.length; index++) {
    const message = working[index]!;
    const text = message.text ?? "";
    if (text.length === 0) continue;
    let current = text;
    const baseCtx: MessageFilterContext = {
      text: current,
      role: message.role,
      messageIndex: index,
      totalMessages: total,
      toolName: message.toolName,
    };
    for (const filter of immediate) {
      let decision: FilterResult;
      try {
        decision = filter.filter(baseCtx);
      } catch {
        continue;
      }
      if (decision.action === "keep") continue;
      tally.partsFiltered++;
      if (decision.action === "drop") {
        current = "";
        tally.partsDropped++;
      } else if (decision.action === "modify" && decision.text !== undefined) {
        current = decision.text;
        tally.partsModified++;
      }
      baseCtx.text = current;
    }
    if (current !== text) working[index] = { ...message, text: current };
  }

  const keepLast = active.filter((filter) => filter.keepLastOnly);
  for (const filter of keepLast) {
    let foundLast = false;
    for (let index = working.length - 1; index >= 0; index--) {
      const message = working[index]!;
      const text = message.text ?? "";
      if (text.length === 0) continue;
      const ctx: MessageFilterContext = {
        text,
        role: message.role,
        messageIndex: index,
        totalMessages: total,
        toolName: message.toolName,
      };
      let decision: FilterResult;
      try {
        decision = filter.filter(ctx);
      } catch {
        continue;
      }
      if (decision.action !== "drop" && decision.action !== "modify") continue;
      if (foundLast) {
        tally.partsFiltered++;
        tally.partsDropped++;
        working[index] = { ...message, text: "" };
      } else {
        foundLast = true;
        if (decision.action === "modify" && decision.text !== undefined) {
          tally.partsFiltered++;
          tally.partsModified++;
          working[index] = { ...message, text: decision.text };
        }
      }
    }
  }

  return { messages: working, ...tally };
}
