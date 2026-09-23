@echo off
where bun >nul 2>nul
if errorlevel 1 (
  echo lazy-workflow: Bun is required but was not found in PATH. 1>&2
  exit /b 127
)
bun run "%~dp0main.ts" %*
exit /b %errorlevel%
