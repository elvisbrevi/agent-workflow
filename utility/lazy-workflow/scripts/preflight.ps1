# Read-only preflight for lazy-workflow from PowerShell. Output: one JSON document.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workingDirectory = (Get-Location).Path
$hu = ''
$issue = ''
$ticket = ''

for ($i = 0; $i -lt $args.Count; $i++) {
  $flag = [string]$args[$i]
  if ($flag -in @('--working-directory', '--hu', '--issue', '--ticket')) {
    if ($i + 1 -ge $args.Count) { [Console]::Error.WriteLine("$flag requires a value"); exit 2 }
    $i++
    $value = [string]$args[$i]
    switch ($flag) {
      '--working-directory' { $workingDirectory = $value }
      '--hu' { $hu = $value }
      '--issue' { $issue = $value }
      '--ticket' { $ticket = $value }
    }
  } elseif ($flag -in @('-h', '--help')) {
    Write-Output 'preflight.ps1 [--working-directory PATH] [--hu ID [--ticket ID] | --issue ID]'
    exit 0
  } else {
    [Console]::Error.WriteLine("Unknown argument: $flag")
    exit 2
  }
}
if ($ticket -and -not $hu) { [Console]::Error.WriteLine('--ticket also needs --hu'); exit 2 }

$runner = @()
if ($env:LAZY_WORKFLOW_BIN) {
  $runner = @($env:LAZY_WORKFLOW_BIN)
} elseif (Get-Command lazy-workflow -ErrorAction SilentlyContinue) {
  $runner = @('lazy-workflow')
} else {
  $skillDirectory = Split-Path -Parent $PSScriptRoot
  $skillItem = Get-Item -LiteralPath $skillDirectory -Force
  if ($skillItem.PSObject.Properties['LinkType'] -and $skillItem.LinkType) {
    $skillDirectory = [string]$skillItem.Target
  }
  $agentDirectory = if ($env:LAZY_WORKFLOW_HOME) { $env:LAZY_WORKFLOW_HOME } else { Join-Path $skillDirectory '../../agent/lazy-workflow' }
  $main = Join-Path $agentDirectory 'main.ts'
  if ((Test-Path -LiteralPath $main -PathType Leaf) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
    $runner = @('bun', 'run', $main)
  }
}
if ($runner.Count -eq 0) {
  [Console]::Error.WriteLine('No lazy-workflow binary found. Install with install.ps1 --all-global, or set LAZY_WORKFLOW_BIN or LAZY_WORKFLOW_HOME.')
  exit 3
}

$probes = @()
$notes = @()
$branch = $null

function Probe([string]$label, [string[]]$toolArgs) {
  $stderrFile = [IO.Path]::GetTempFileName()
  try {
    $command = $script:runner[0]
    $prefix = if ($script:runner.Count -gt 1) { @($script:runner[1..($script:runner.Count - 1)]) } else { @() }
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $lines = & $command @prefix @toolArgs --no-color 2> $stderrFile }
    finally { $ErrorActionPreference = $oldPreference }
    $status = $LASTEXITCODE
    $output = ($lines | Out-String).Trim()
    $errorText = (Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue | Select-Object -Last 5 | Out-String).Trim()
    $entry = [ordered]@{ probe = $label; command = "lazy-workflow $($toolArgs -join ' ')"; ok = $false }
    if ($status -eq 0 -and $output) {
      try {
        $entry.ok = $true
        $entry.result = $output | ConvertFrom-Json
        if ($label -eq 'hu-branch') { $script:branch = $entry.result }
      } catch { $entry.error = "Invalid JSON from tool: $($_.Exception.Message)" }
    } else {
      $entry.exitCode = $status
      $entry.error = if ($errorText) { $errorText } else { $output }
    }
    $script:probes += $entry
  } finally { Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue }
}

if ($hu) {
  $scope = 'azure'
  Probe 'hu' @('hu-info', '--hu', $hu)
  Probe 'hu-children' @('hu-children-info', '--hu', $hu)
  Probe 'hu-branch' @('hu-branch-info', '--hu', $hu)
  if ($ticket) {
    Probe 'ticket' @('ticket-info', '--hu', $hu, '--ticket', $ticket)
    Probe 'ticket-completion' @('ticket-completion-info', '--hu', $hu, '--ticket', $ticket)
  }
  if ($null -ne $branch -and $null -eq $branch.branch) {
    $notes += "HU $hu has no integration branch link: the first code --hu $hu provisions hu/$hu from master or main; pass --base-branch for another base."
  }
} else {
  $scope = 'github'
  Probe 'auth' @('github-auth-info', '--working-directory', $workingDirectory)
  Probe 'repo' @('github-repo-info', '--working-directory', $workingDirectory)
  if ($issue) { Probe 'issue' @('github-issue-info', '--issue', $issue, '--working-directory', $workingDirectory) }
  else {
    Probe 'queue' @('github-issue-list', '--working-directory', $workingDirectory)
    Probe 'selection' @('github-issue-select', '--working-directory', $workingDirectory)
  }
}

$allOk = @($probes | Where-Object { -not $_.ok }).Count -eq 0
if (-not $allOk) { $notes += "A probe failed: read its error before proposing a command." }
[ordered]@{
  scope = $scope
  workingDirectory = $workingDirectory
  runner = ($runner -join ' ')
  allOk = $allOk
  probes = $probes
  notes = $notes
} | ConvertTo-Json -Depth 30
