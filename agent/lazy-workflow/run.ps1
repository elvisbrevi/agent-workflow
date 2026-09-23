$ErrorActionPreference = 'Stop'

# Windows PowerShell 5 quotes native arguments differently from PowerShell 7.
# Preserve quotes and trailing backslashes when forwarding a prompt to Bun.
function Convert-NativeArgument([string]$value) {
  if ($PSVersionTable.PSVersion.Major -ge 7) { return $value }
  if ($value.Length -eq 0) { return '""' }
  $escaped = [regex]::Replace($value, '(\\*)"', '${1}${1}\"')
  if ($value -match '\s') { $escaped = [regex]::Replace($escaped, '(\\+)$', '${1}${1}') }
  return $escaped
}

$agentDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$entrypoint = Join-Path $agentDirectory 'main.ts'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('lazy-workflow: Bun is required but was not found in PATH.')
  exit 127
}

$forwarded = @($args | ForEach-Object { Convert-NativeArgument ([string]$_) })
& bun run $entrypoint @forwarded
exit $LASTEXITCODE
