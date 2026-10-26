import type { MessageFilter } from "./types.js";

const registry = new Map<string, MessageFilter>();

export function registerMessageFilter(filter: MessageFilter): void {
  const existing = registry.get(filter.name);
  if (existing && existing.version !== filter.version) {
    throw new Error(
      `Message filter "${filter.name}" already registered with version ${existing.version}, cannot register version ${filter.version}.`,
    );
  }
  registry.set(filter.name, filter);
}

export function getMessageFilter(name: string): MessageFilter | undefined {
  return registry.get(name);
}

export function listMessageFilters(): MessageFilter[] {
  return [...registry.values()];
}

export function clearMessageFilters(): void {
  registry.clear();
}
