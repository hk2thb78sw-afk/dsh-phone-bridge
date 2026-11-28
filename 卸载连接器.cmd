@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0install.ps1" (
  echo.
  echo [错误] 找不到同目录下的 install.ps1。
  echo.
  echo 原因：你可能是在压缩包的预览窗口里直接双击运行，这里只是临时目录。
  echo 正确做法：右键压缩包 → 全部解压缩，进入解压后的文件夹，再运行本文件。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
echo.
pause
