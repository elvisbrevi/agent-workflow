$ErrorActionPreference = 'Stop'

$agentDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$entrypoint = Join-Path $agentDirectory 'main.ts'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('lazy-workflow: Bun is required but was not found in PATH.')
  exit 127
}

& bun run $entrypoint @args
exit $LASTEXITCODE
