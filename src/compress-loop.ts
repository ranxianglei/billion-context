export function buildVisibilityMarker(toolName: string, result: string): string {
    const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const failed = lines.some((l) =>
        l.includes("FAILED")
        || l.includes("not found")
        || l.includes("is required")
        || l.includes("No blocks matched")
    );
    const icons: Record<string, string> = {
        compress: "📦",
        decompress: "📤",
        search_context: "🔍",
        acp_status: "📊",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status" && lines.length >= 2) {
        const dataLine = lines.slice(0, 3).join(" | ").replace(/\s+/g, " ");
        return `\n${icon} [ACP] ${dataLine}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}
