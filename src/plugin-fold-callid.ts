/** #1567: folds executed through POST /__bili/plugin/tool are minted this
 *  synthetic callId, which the client can never echo back — its own re-sent
 *  compress pair is the summary carrier for such blocks, so the kernel's
 *  in-place acp_summary anchor is redundant and must be stripped (#1567). */
export const PLUGIN_FOLD_CALLID_PREFIX = "plugin_";
export function isPluginFoldCallId(callId: string | undefined): boolean {
    return typeof callId === "string" && callId.startsWith(PLUGIN_FOLD_CALLID_PREFIX);
}
