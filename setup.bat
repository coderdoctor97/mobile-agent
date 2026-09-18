@echo off
setlocal EnableExtensions
title Mobile Agent - PC Setup

cd /d "%~dp0"

echo.
echo   Mobile Agent - PC Edition - Setup
echo   ================================
echo.

REM ---- 1. Node.js check -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js was not found on this PC.
  echo.
  echo       Install the LTS version from https://nodejs.org ^(big green button^),
  echo       then run this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set "NODEV=%%v"
echo   [1/3] Node.js %NODEV% found.

node -e "const m=process.versions.node.split('.').map(Number);process.exit(m[0]>=20?0:1)" 2>nul
if errorlevel 1 (
  echo   [X] Node.js 20 or newer is required ^(you have %NODEV%^).
  echo       Update from https://nodejs.org and run setup again.
  pause
  exit /b 1
)

REM ---- 2. Dependencies ---------------------------------------------------
echo   [2/3] Installing dependencies ^(first run takes a minute^)...
echo.
pushd pc
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  echo.
  echo   [X] npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)
popd

REM ---- 3. Data directory -------------------------------------------------
if not exist "pc\data" mkdir "pc\data"
echo   [3/3] Data directory ready: pc\data

echo.
echo   Setup complete.
echo.
echo   Next: double-click start.bat - the agent opens in your browser
echo   at http://localhost:8787
echo.
pause
exit /b 0
