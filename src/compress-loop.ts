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
        absorb: "🧽",
    };
    const icon = failed ? "❌" : (icons[toolName] ?? "📦");

    if (toolName === "acp_status") {
        return `\n${icon} [ACP] acp_status result:\n${result.trim()}\n`;
    }

    if (toolName === "absorb") {
        return `\n${icon} [ACP] absorb result (durable record — original tool output is hidden):\n${result.trim()}\n`;
    }

    const inner = (lines[0] ?? "").replace(/^\[/, "").replace(/\]$/, "").trim();
    return `\n${icon} [ACP] ${inner}\n`;
}
