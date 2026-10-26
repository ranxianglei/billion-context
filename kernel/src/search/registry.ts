/**
 * Algorithm registry. Builtins are pre-registered; hosts may register
 * additional algorithms (e.g. an embedding-based semantic provider) via
 * registerSearchAlgorithm and reference them by name in SearchOptions.
 */
import type { AnySearchAlgorithm } from "./types.js";
import { substringAlgorithm } from "./algorithms/substring.js";
import { bm25Algorithm } from "./algorithms/bm25.js";
import { fuzzyAlgorithm } from "./algorithms/fuzzy.js";
import { hybridAlgorithm } from "./algorithms/hybrid.js";

const registry = new Map<string, AnySearchAlgorithm>();

export function registerSearchAlgorithm(algo: AnySearchAlgorithm): void {
  registry.set(algo.name, algo);
}

export function getSearchAlgorithm(
  name: string,
): AnySearchAlgorithm | undefined {
  return registry.get(name);
}

export function listSearchAlgorithms(): AnySearchAlgorithm[] {
  return [...registry.values()];
}

// Pre-register builtins. Hybrid is the default (see types.ts DEFAULT_ALGORITHM).
registerSearchAlgorithm(substringAlgorithm);
registerSearchAlgorithm(bm25Algorithm);
registerSearchAlgorithm(fuzzyAlgorithm);
registerSearchAlgorithm(hybridAlgorithm);
