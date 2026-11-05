<#
.SYNOPSIS
    把 billion-context 装成 Codex 桌面版插件。

.DESCRIPTION
    做四件事：
      1. 确保 bili CLI 可用（插件的 MCP server 需要 dist/mcp.js）
      2. 把上游仓库注册成 Git marketplace —— 这是"有更新"检测的关键：
         只有 Git 源有版本推进语义，local / npm 源的版本号恒为 null
      3. 安装插件本身
      4. 打开 features.enable_mcp_apps（渲染 MCP App 组件用）

    安装后需要重启 Codex。

.EXAMPLE
    .\install.ps1
    .\install.ps1 -SkipCli   # 已经装好 bili CLI 时
#>

[CmdletBinding()]
param(
    # 跳过 bili CLI 的安装检查
    [switch]$SkipCli,
    # 只打印将要执行的操作，不真的执行
    [switch]$WhatIfOnly
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2{ param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

# ---------------------------------------------------------------- codex 可执行文件
function Resolve-Codex {
    $cmd = Get-Command codex -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # 桌面版把 codex.exe 放在 AppData 下，不一定在 PATH
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"),
        (Join-Path $env:LOCALAPPDATA "Programs\codex")
    )
    foreach ($dir in $candidates) {
        if (-not (Test-Path $dir)) { continue }
        $hit = Get-ChildItem -Path $dir -Filter "codex.exe" -Recurse -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Invoke-Codex {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $global:CodexBin = Resolve-Codex
    if (-not $global:CodexBin) {
        throw "找不到 codex 可执行文件。请确认已安装 Codex 桌面版或 codex CLI。"
    }
    & $global:CodexBin @Args
    if ($LASTEXITCODE -ne 0) {
        throw "codex $($Args -join ' ') 退出码 $LASTEXITCODE"
    }
}

# ---------------------------------------------------------------- 1. bili CLI
if (-not $SkipCli) {
    Write-Step "检查 bili CLI"
    $bili = Get-Command bili -ErrorAction SilentlyContinue
    if ($bili) {
        Write-Ok "已安装：$($bili.Source)"
    } else {
        Write-Warn2 "未找到 bili，正在安装 npm 包 billion-context…"
        if (-not $WhatIfOnly) {
            npm install -g billion-context
            if ($LASTEXITCODE -ne 0) {
                throw "npm install -g billion-context 失败"
            }
        }
    }
}

# ---------------------------------------------------------------- 2. marketplace
# 必须用 Git 源：只有 Git marketplace 才有版本推进语义，Codex 会把它识别成
# sourceType=git，并在后台自动拉取上游更新（plugins-marketplace-auto-upgrade）。
# local / npm 源的 PluginSummary.version 恒为 null，插件页面永远看不到"有更新"。
Write-Step "注册 Git marketplace（更新检测依赖它）"
$repo = "ranxianglei/billion-context"
$codexBin = Resolve-Codex
if (-not $codexBin) {
    throw "找不到 codex 可执行文件。请确认已安装 Codex 桌面版或 codex CLI。"
}
$existing = & $codexBin plugin marketplace list 2>&1 | Out-String
if ($existing -match "billion-context") {
    Write-Ok "marketplace 已存在"
} else {
    if (-not $WhatIfOnly) {
        Invoke-Codex plugin marketplace add $repo
    }
    Write-Ok "已注册 $repo"
}

# ---------------------------------------------------------------- 3. 安装插件
Write-Step "安装插件"
if (-not $WhatIfOnly) {
    Invoke-Codex plugin add "billion-context@billion-context"
}
Write-Ok "已安装 billion-context 插件"

# ---------------------------------------------------------------- 4. MCP Apps
Write-Step "开启 features.enable_mcp_apps"
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$config = Join-Path $codexHome "config.toml"
if (Test-Path $config) {
    # 读写都走 .NET API 而不是 Get/Set-Content：PS 5.1 的 Get-Content 默认按
    # ANSI/GBK 解码，会把 config.toml 里的非 ASCII（如中文注释）读成乱码再原样
    # 写回；Set-Content -Encoding UTF8 在 5.1 又会加 BOM（已有 BOM 时变双 BOM）。
    # .NET 这对 API 恒定 UTF-8、不加 BOM、跨版本行为一致。
    $text = [System.IO.File]::ReadAllText($config)
    if ($text -notmatch "(?m)^\s*enable_mcp_apps\s*=") {
        if (-not $WhatIfOnly) {
            # 追加到 [features] 段；没有该段就新建一个
            if ($text -match "(?m)^\[features\]") {
                $text = $text -replace "(?m)^(\[features\]\r?\n)", "`$1enable_mcp_apps = true`n"
            } else {
                $text = $text.TrimEnd() + "`n`n[features]`nenable_mcp_apps = true`n"
            }
            [System.IO.File]::WriteAllText($config, $text, [System.Text.UTF8Encoding]::new($false))
        }
        Write-Ok "已开启"
    } else {
        Write-Ok "已开启"
    }
} else {
    Write-Warn2 "找不到 $config，跳过"
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host ""
Write-Host "接下来：" -ForegroundColor Cyan
Write-Host "  1. 重启 Codex 桌面版"
Write-Host "  2. 打开 插件 页面，确认列表里能看到 billion-context"
Write-Host "  3. 在对话里说「查看上下文压缩状态」即可调用 acp_status 工具"
Write-Host ""
Write-Host "更新检测：Codex 会自动拉取上游 Git marketplace 的新提交。" -ForegroundColor Cyan
Write-Host "上游发新版本后，插件页面会显示新版本号，点更新即可。"
Write-Host ""
Write-Host "注意：压缩功能本身还需要 bili 代理在跑（bili start），" -ForegroundColor Yellow
Write-Host "      或者用 'bili codex' 启动 Codex 以便代理与客户端同时运行。"
