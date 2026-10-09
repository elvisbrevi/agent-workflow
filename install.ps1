# PowerShell 5.1 bootstrap; installation policy lives in installer/.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'agent-workflow: Se requiere Git en PATH.' }
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'agent-workflow: Se requiere Bun en PATH. Instala Bun: https://bun.sh' }
$installerRef = 'main'
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq '--ref') {
    $i++
    if ($i -ge $args.Count) { throw 'agent-workflow: --ref requiere una rama o tag.' }
    $installerRef = [string]$args[$i]
  }
}
$installerRepo = if ($env:AGENT_WORKFLOW_REPO_URL) { $env:AGENT_WORKFLOW_REPO_URL } else { 'https://github.com/elvisbrevi/agent-workflow.git' }
$installerTemporary = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-bootstrap-' + [guid]::NewGuid())
try {
  & git clone --branch $installerRef --depth 1 $installerRepo $installerTemporary --quiet
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & bun run (Join-Path $installerTemporary 'installer/main.ts') @args
  exit $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $installerTemporary) { Remove-Item -LiteralPath $installerTemporary -Recurse -Force }
}
