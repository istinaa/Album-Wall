@echo off
cd /d "%~dp0"
if exist "dist\Album Wall-win32-x64\Album Wall.exe" (
  start "" "dist\Album Wall-win32-x64\Album Wall.exe"
  exit /b
)
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "desktop\main.mjs"
  exit /b
)
echo Please run npm install, npm run setup:desktop, then npm run package once.
pause
