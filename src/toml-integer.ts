/** Parse the non-negative TOML integer subset used for model token limits. */
export function nonNegativeTomlInteger(value: string): number | undefined {
    // Reject numeric prefixes of floats/dates. Underscores only separate digits
    // of the selected base, and model limits must remain exactly representable.
    if (!/^(?:\+?(?:0|[1-9](?:_?[0-9])*)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/.test(value)) return undefined;
    const parsed = Number(value.replace(/_/g, ""));
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
