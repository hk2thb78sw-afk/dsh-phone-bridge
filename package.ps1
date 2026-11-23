# 打包：生成可拷到 U 盘的 zip
# 用法：powershell -ExecutionPolicy Bypass -File .\package.ps1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
$staging = Join-Path $dist 'staging'
$version = '0.3.2'
$zipName = "dsh-phone-bridge-$version.zip"

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Copy-Item (Join-Path $root 'phone-bridge') (Join-Path $staging 'phone-bridge') -Recurse -Force
Copy-Item (Join-Path $root 'install.ps1') $staging -Force
Copy-Item (Join-Path $root '安装手机桥.cmd') $staging -Force
Copy-Item (Join-Path $root '卸载手机桥.cmd') $staging -Force
Copy-Item (Join-Path $root '安装说明.md') $staging -Force

$zip = Join-Path $dist $zipName
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "已生成：$zip ($size KB)" -ForegroundColor Green
Get-ChildItem $dist | Select-Object Name, Length
