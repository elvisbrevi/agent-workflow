# Exercises the PowerShell preflight without credentials or a live tracker.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = Split-Path -Parent $PSScriptRoot
$preflight = Join-Path $repository 'utility/lazy-workflow/scripts/preflight.ps1'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$testRoot = Join-Path $tempBase ("agent-workflow-preflight-test-" + [guid]::NewGuid().ToString('N'))
$previousRunner = $env:LAZY_WORKFLOW_BIN

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  $runner = Join-Path $testRoot 'fake runner.cmd'
  [IO.File]::WriteAllText($runner, "@echo off`r`necho {`"branch`":null,`"command`":`"%1`"}`r`nexit /b 0`r`n", [Text.Encoding]::ASCII)
  $env:LAZY_WORKFLOW_BIN = $runner

  $github = (& $preflight --issue 42 --working-directory $testRoot | Out-String) | ConvertFrom-Json
  Assert ($github.scope -eq 'github') 'GitHub scope was not reported'
  Assert ($github.allOk -eq $true) 'GitHub probes failed'
  Assert ($github.probes.Count -eq 3) 'GitHub issue preflight did not run three probes'
  Assert ($github.probes[2].result.command -eq 'github-issue-info') 'Issue probe did not call the requested tool'
  Write-Output 'PASS: PowerShell GitHub preflight parses isolated tool JSON'

  $azure = (& $preflight --hu 123 --ticket 456 --working-directory $testRoot | Out-String) | ConvertFrom-Json
  Assert ($azure.scope -eq 'azure') 'Azure scope was not reported'
  Assert ($azure.allOk -eq $true) 'Azure probes failed'
  Assert ($azure.probes.Count -eq 5) 'Azure ticket preflight did not run five probes'
  Assert ($azure.probes[4].result.command -eq 'ticket-completion-info') 'Completion probe did not call the requested tool'
  Write-Output 'PASS: PowerShell Azure preflight runs the ticket probes'
} finally {
  $env:LAZY_WORKFLOW_BIN = $previousRunner
  $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedRoot.StartsWith("$tempBase$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedRoot)) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  }
}
