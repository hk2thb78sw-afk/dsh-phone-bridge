# DSH 连接器 · 安装 / 卸载（Windows）
#
# 双击「安装连接器.cmd」或「卸载连接器.cmd」即可；也可以在 PowerShell 里：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1              # 安装
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall   # 卸载
#
# 不带参数运行且已经安装时，会问你要卸载还是重装。
#
# 参数：
#   -Uninstall        卸载（从 profile 移除插件并清理本机副本）
#   -PurgeState       卸载时连配对记录（%USERPROFILE%\.dsh\phone-bridge）一起删
#   -Profile <name>   指定 profile（默认自动找 desktop）
#   -DshHome <path>   指定 DSH 数据目录（默认 $env:DSH_HOME 或 %USERPROFILE%\.dsh）
#   -PluginDir <path> 指定插件安装目录（默认 %LOCALAPPDATA%\dsh-phone-bridge）
#   -Force            已安装时强制重装/更新链接

[CmdletBinding()]
param(
  [string]$Profile,
  [string]$DshHome,
  [string]$PluginDir,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$PurgeState
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-phone-bridge'
$sourceDir = Join-Path $PSScriptRoot 'phone-bridge'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Fail([string]$text) { Write-Host "    $text" -ForegroundColor Red }

function Find-DshHome {
  if ($DshHome) { return (Resolve-Path $DshHome).Path }
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $env:USERPROFILE '.dsh')
}

function Find-Profile([string]$dshHomePath) {
  $root = Join-Path $dshHomePath 'profiles'
  if (-not (Test-Path $root)) { throw "找不到 DSH 的 profiles 目录：$root。请先启动一次 DSH 桌面端。" }
  if ($Profile) {
    $candidate = Join-Path $root $Profile
    if (-not (Test-Path $candidate)) { throw "profile 不存在：$candidate" }
    return $candidate
  }
  $desktop = Join-Path $root 'desktop'
  if (Test-Path (Join-Path $desktop 'package.json')) {
    if ((Get-Content (Join-Path $desktop 'package.json') -Raw) -match 'dsh-web-app') { return $desktop }
  }
  foreach ($dir in Get-ChildItem $root -Directory) {
    $manifest = Join-Path $dir.FullName 'package.json'
    if (-not (Test-Path $manifest)) { continue }
    if ((Get-Content $manifest -Raw) -match 'dsh-web-app') { return $dir.FullName }
  }
  throw "没有找到带 Web 界面的 profile（在 $root 下）。"
}

function Find-NodeAndPnpm([string]$dshHomePath) {
  $nodeCandidates = @()
  $pnpmCandidates = @()

  foreach ($runtime in Get-ChildItem (Join-Path $dshHomePath 'dsh-runtimes') -Directory -ErrorAction SilentlyContinue) {
    $deps = Join-Path $runtime.FullName 'dependencies'
    $nodeCandidates += Join-Path $deps 'node\bin\node.exe'
    $pnpmCandidates += Join-Path $deps 'pnpm\bin\pnpm.mjs'
  }

  $appDirs = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness')
  )
  foreach ($app in $appDirs) {
    if (-not $app) { continue }
    $deps = Join-Path $app 'resources\runtime\primary-runtime\dependencies'
    $nodeCandidates += Join-Path $deps 'node\bin\node.exe'
    $pnpmCandidates += Join-Path $deps 'pnpm\bin\pnpm.mjs'
  }

  $node = $nodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  $pnpm = $pnpmCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $node) {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { $node = $command.Source }
  }
  if (-not $pnpm) {
    $command = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($command) { $pnpm = $command.Source }
  }

  return @{ Node = $node; Pnpm = $pnpm }
}

function Read-Package([string]$path) {
  $raw = Get-Content $path -Raw
  return ($raw.TrimStart([char]0xFEFF) | ConvertFrom-Json)
}

function Write-JsonFile([string]$path, $value) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 20), $utf8)
}

function Invoke-PnpmInstall([string]$profilePath, $runtime) {
  Push-Location $profilePath
  try {
    if ($runtime.Node -and $runtime.Pnpm) {
      & $runtime.Node $runtime.Pnpm install --ignore-scripts
    } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
      pnpm install --ignore-scripts
    } else {
      Write-Warn2 '找不到 pnpm，跳过依赖重装；node_modules 里的插件链接可能需要手动删除'
      return
    }
    if ($LASTEXITCODE -ne 0) { throw "pnpm 安装失败（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------- 定位环境

Write-Step '检查运行环境'
$homePath = Find-DshHome
if (-not (Test-Path $homePath)) { throw "找不到 DSH 数据目录：$homePath。请先启动一次 DSH 桌面端。" }
$profilePath = Find-Profile $homePath
$packagePath = Join-Path $profilePath 'package.json'
$lockPath = Join-Path $profilePath 'pnpm-lock.yaml'
$runtime = Find-NodeAndPnpm $homePath
Write-Ok "DSH 数据目录：$homePath"
Write-Ok "目标 profile：$profilePath"

$package = Read-Package $packagePath
$installed = $package.dependencies -and ($package.dependencies.PSObject.Properties.Name -contains $pluginName)

# 不带参数且已安装：问一下要卸载还是重装
if (-not $Uninstall -and -not $Force -and $installed) {
  Write-Host ''
  Write-Host '检测到这台电脑已经装了连接器。' -ForegroundColor Yellow
  $answer = (Read-Host '  [U] 卸载    [R] 重新安装    [Enter] 退出').Trim().ToUpper()
  if ($answer -eq 'U') { $Uninstall = $true }
  elseif ($answer -ne 'R') { Write-Ok '没有做任何改动。'; exit 0 }
}

# ---------------------------------------------------------------- 卸载

if ($Uninstall) {
  if (-not $installed) {
    Write-Warn2 '这台电脑没有装连接器，无需卸载。'
    exit 0
  }

  Write-Step '从 profile 移除插件'
  $package.dependencies.PSObject.Properties.Remove($pluginName)
  $package.dsh.profile.bundles = @(@($package.dsh.profile.bundles) | Where-Object { $_ -ne $pluginName })
  Write-JsonFile $packagePath $package
  Write-Ok '已更新 package.json'

  Write-Step '重装依赖（摘掉插件链接）'
  Invoke-PnpmInstall $profilePath $runtime
  Write-Ok '依赖已更新'

  Write-Step '清理本机插件副本'
  $targetDir = if ($PluginDir) { $PluginDir } else { Join-Path $env:LOCALAPPDATA 'dsh-phone-bridge' }
  if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force; Write-Ok $targetDir }

  if ($PurgeState) {
    Write-Step '清理配对记录'
    $stateDir = Join-Path $homePath 'phone-bridge'
    if (Test-Path $stateDir) { Remove-Item $stateDir -Recurse -Force; Write-Ok $stateDir }
    else { Write-Warn2 '没有配对记录可清理' }
  }

  Write-Host ''
  Write-Host '卸载完成。完全退出 DSH 桌面端再打开一次，连接器就彻底不再运行。' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- 安装

if (-not (Test-Path $sourceDir)) { throw "缺少插件目录：$sourceDir。请确认解压完整。" }
if ($installed -and -not $Force) {
  Write-Warn2 '这个 profile 已经装过。'
  exit 0
}
if (-not $runtime.Node) { throw '找不到 Node.js（DSH 自带的也没找到）。' }
Write-Ok "Node：$($runtime.Node)"
if ($runtime.Pnpm) { Write-Ok "pnpm：$($runtime.Pnpm)" } else { Write-Warn2 '没找到 pnpm.mjs，将尝试 PATH 里的 pnpm' }

Write-Step '复制插件到本机目录'
$targetDir = if ($PluginDir) { $PluginDir } else { Join-Path $env:LOCALAPPDATA 'dsh-phone-bridge' }
$sourceFull = (Resolve-Path $sourceDir).Path
if ($sourceFull -ne $targetDir) {
  if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item (Join-Path $sourceFull '*') $targetDir -Recurse -Force
}
Write-Ok "插件位置：$targetDir"

# 安全网：如果 package.json 带了 UTF-8 BOM，DSH 会解析失败并跳过整个插件，这里顺手去掉。
$packageInTarget = Join-Path $targetDir 'package.json'
if (Test-Path $packageInTarget) {
  $bytes = [System.IO.File]::ReadAllBytes($packageInTarget)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $text = [System.Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
    [System.IO.File]::WriteAllText($packageInTarget, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok '已修正 package.json 编码（去掉 BOM）'
  }
}

Write-Step '备份并修改 profile'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $profilePath ".phone-bridge-backup-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item $packagePath $backupDir -Force
if (Test-Path $lockPath) { Copy-Item $lockPath $backupDir -Force }
Write-Ok "备份：$backupDir"

try {
  $linkPath = $targetDir.Replace('\', '/')
  if (-not $package.dependencies) { $package | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
  $package.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue "link:$linkPath" -Force

  $bundles = @($package.dsh.profile.bundles)
  if ($bundles -notcontains $pluginName) { $bundles += $pluginName }
  $package.dsh.profile.bundles = $bundles

  Write-JsonFile $packagePath $package
  Write-Ok '已写入依赖与 bundle'

  Write-Step '安装依赖（不联网）'
  Invoke-PnpmInstall $profilePath $runtime

  $installedFile = Join-Path $profilePath "node_modules\$pluginName\lib\index.js"
  if (-not (Test-Path $installedFile)) { throw "安装后没有找到 $installedFile" }
  Write-Ok '安装完成'
}
catch {
  Write-Fail $_.Exception.Message
  Write-Step '回滚 profile'
  Copy-Item (Join-Path $backupDir 'package.json') $packagePath -Force
  if (Test-Path (Join-Path $backupDir 'pnpm-lock.yaml')) { Copy-Item (Join-Path $backupDir 'pnpm-lock.yaml') $lockPath -Force }
  Write-Ok '已恢复原配置（插件目录保留，可再次运行）'
  exit 1
}

Write-Host ''
Write-Host '安装完成，还差最后一步：' -ForegroundColor Green
Write-Host '  1) 完全退出 DSH 桌面端（托盘图标右键退出），再重新打开'
Write-Host '  2) 重启后在浏览器打开：' -NoNewline
Write-Host ' http://127.0.0.1:4870/__phone/desktop' -ForegroundColor Cyan
Write-Host '  3) 页面上会显示配对码和手机可用的地址；手机连同一个 Wi-Fi 后打开地址、输码'
Write-Host ''
Write-Host '卸载：双击「卸载连接器.cmd」，或 powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall' -ForegroundColor DarkGray
