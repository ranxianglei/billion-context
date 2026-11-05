interface PretestCacheComponent {
    name: string;
    dir: string;
    inputs: string[];
}

interface PretestCacheResult {
    name: string;
    hit: boolean;
    ms: number;
}

export const MARKER_NAME: string;
export const COMPONENTS: PretestCacheComponent[];
export function hashComponent(root: string, comp: PretestCacheComponent, platform?: string): string;
export function markerIsFresh(distDir: string, hash: string): boolean;
export function runPretestCache(opts?: {
    root?: string;
    components?: PretestCacheComponent[];
    log?: (line: string) => void;
    build?: (comp: PretestCacheComponent, root: string) => void;
}): PretestCacheResult[];
