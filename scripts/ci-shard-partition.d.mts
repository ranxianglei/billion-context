interface ShardWeights {
    msPerLineFallback: number;
    files: Record<string, number>;
}

export function lineCount(rel: string): number;
export function fileWeight(rel: string, table?: ShardWeights): number;
export function partitionAll(files: string[], n: number, table?: ShardWeights): string[][];
