@echo off
setlocal EnableExtensions
title Mobile Agent - PC

cd /d "%~dp0"

REM Optional: pass a port as the first argument -  "start.bat 3000"
set "PORT=8787"
if not "%~1"=="" set "PORT=%~1"

if not exist "pc\node_modules" (
  echo   Dependencies are missing. Run setup.bat first.
  pause
  exit /b 1
)

echo.
echo   Mobile Agent - PC Edition
echo   Starting the local agent server on port %PORT% ...
echo   Leave this window open - closing it stops the agent.
echo   The browser opens by itself once the server is up.
echo.

pushd pc
node server/index.js --port %PORT% --open
set "EXITCODE=%ERRORLEVEL%"
popd

if not "%EXITCODE%"=="0" (
  echo.
  echo   The server stopped with code %EXITCODE%.
  echo   Port already in use? Try:   start.bat 8788
  pause
)
exit /b %EXITCODE%
