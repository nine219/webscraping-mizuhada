@echo off
REM Build the Next.js dashboard and restart its PM2 process.
REM Run from anywhere: double-click or `rebuild-dashboard.bat`.

setlocal
REM Move to the repo root (this script lives in scripts/, one level down)
cd /d "%~dp0.."

echo [1/2] Building dashboard...
cd dashboard

REM Windows Smart App Control / WDAC blocks Next's unsigned native SWC binary,
REM which crashes the build worker before it can fall back. Move the native
REM package aside so Next uses the @next/swc-wasm-nodejs fallback (devDependency).
REM npm install restores the native dir, so re-disable it on every build.
if exist "node_modules\@next\swc-win32-x64-msvc" (
  echo   Disabling blocked native SWC - building with WASM fallback...
  if exist "node_modules\@next\swc-win32-x64-msvc.disabled" rmdir /s /q "node_modules\@next\swc-win32-x64-msvc.disabled"
  move /y "node_modules\@next\swc-win32-x64-msvc" "node_modules\@next\swc-win32-x64-msvc.disabled" >nul
)

call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED - dashboard not restarted.
  cd ..
  exit /b 1
)
cd ..

echo.
echo [2/2] Restarting dashboard...
call npx pm2 restart api dashboard 

echo.
echo Done.
endlocal
