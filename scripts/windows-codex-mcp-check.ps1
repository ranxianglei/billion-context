#Requires -Version 5.1
<#
Headless verification for issue #686.

Question answered: does `codex` accept the `<CODEX_HOME>-bili` overlay that
`bili codex` produces, and register the `bili` MCP server from it?

Why no model upstream / API key is needed:
  `bili codex mcp list` starts the bili proxy, points CODEX_HOME at the generated
  overlay (win32) or injects inline -c (posix), then forwards `mcp list` to codex.
  `codex mcp list` only reads config.toml and enumerates MCP servers -- it never
  calls a model, so no E2E_UPSTREAM_URL / E2E_UPSTREAM_KEY is required.

Stream contract (verified against the built dist): bili writes ALL of its own
status lines to STDERR (console.error); the child codex writes its `mcp list`
result to STDOUT. We assert on STDOUT only, so bili's own "injecting native bili
MCP tools" line cannot cause a false positive.

Usage (Windows box):
  npm i -g billion-context@latest @openai/codex
  powershell -ExecutionPolicy Bypass -File scripts/windows-codex-mcp-check.ps1

Exit codes: 0 = PASS (codex registered bili); 1 = FAIL; 2 = missing prerequisite.
Writes a transcript to ./windows-codex-mcp-output.txt for reporting.
#>
$ErrorActionPreference = 'Stop'
$transcript = 'windows-codex-mcp-output.txt'

foreach ($cmd in @('bili', 'codex')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "MISSING: '$cmd' not found on PATH. Install with: npm i -g billion-context@latest @openai/codex"
        exit 2
    }
}

$env:BILI_LAUNCHER_PLUGIN = '1'
$sb = New-Object System.Text.StringBuilder

Write-Host "=== [1/2] bili codex mcp list (asserting on codex STDOUT only) ==="
$list = (& bili codex mcp list 2>$null | Out-String)
[void]$sb.AppendLine("--- codex mcp list (stdout) ---")
[void]$sb.AppendLine($list)
Write-Host $list

Write-Host "=== [2/2] bili codex mcp get bili (soft check) ==="
$get = (& bili codex mcp get bili 2>$null | Out-String)
[void]$sb.AppendLine("--- codex mcp get bili (stdout) ---")
[void]$sb.AppendLine($get)
Write-Host $get

Set-Content -Path $transcript -Value $sb.ToString()
Write-Host "Transcript saved to: $transcript"

$failures = New-Object System.Collections.Generic.List[string]
if ($list -notmatch 'bili') {
    $failures.Add("'codex mcp list' did not show a 'bili' server -> codex likely rejected the CODEX_HOME overlay")
}
if ($get -notmatch 'BILI_MCP_PROXY') {
    Write-Warning "'codex mcp get bili' did not show BILI_MCP_PROXY (soft check; some codex versions lack this subcommand)"
}

if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL: $f" }
    Write-Host "Capture the transcript above and report back in #686."
    exit 1
}

Write-Host "PASS: codex accepted the CODEX_HOME overlay and registered the bili MCP server."
exit 0
