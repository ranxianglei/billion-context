export declare function findRelativeImportRefs(text: string): string[];

export declare function checkDistImportAnnotations(distDir: string): Array<{ file: string; refs: string[] }>;
