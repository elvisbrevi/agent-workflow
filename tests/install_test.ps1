# Windows integration checks for install.ps1. Every install stays under one temporary root.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repository 'install.ps1'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$testRoot = Join-Path $tempBase ("agent-workflow-install-test-" + [guid]::NewGuid().ToString('N'))
$source = Join-Path $testRoot 'catalog-source'
$profile = Join-Path $testRoot ('home con espacio ' + [char]0x00FC)
$project = Join-Path $testRoot 'project with spaces'
$cache = Join-Path $profile '.cache/agent-workflow'
$previousHome = $HOME
$previousUserProfile = $env:USERPROFILE
$previousRepoUrl = $env:AGENT_WORKFLOW_REPO_URL
$previousCodexHome = $env:CODEX_HOME

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function Invoke-Git([string[]]$arguments) {
  & git @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git failed: $($arguments -join ' ')" }
}

function Invoke-Installer([string[]]$arguments) {
  & $installer @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed: $($arguments -join ' ')" }
}

try {
  New-Item -ItemType Directory -Path $source, $profile, $project -Force | Out-Null
  $skill = Join-Path $source 'utility/alpha'
  $agent = Join-Path $source 'agent/runner'
  New-Item -ItemType Directory -Path $skill, $agent -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $skill 'SKILL.md'), '# Test skill')
  [IO.File]::WriteAllText((Join-Path $agent 'AGENT.md'), '# Test agent')
  [IO.File]::WriteAllText((Join-Path $agent 'main.ts'), 'console.log(JSON.stringify(process.argv.slice(2)));')
  [IO.File]::WriteAllText((Join-Path $agent 'run.cmd'), '@echo off')
  Copy-Item -LiteralPath (Join-Path $repository 'agent/lazy-workflow/run.ps1') -Destination (Join-Path $agent 'run.ps1')
  Invoke-Git @('-C', $source, 'init', '-b', 'main')
  Invoke-Git @('-C', $source, 'config', 'user.name', 'Install Test')
  Invoke-Git @('-C', $source, 'config', 'user.email', 'install-test@example.invalid')
  Invoke-Git @('-C', $source, 'add', '.')
  Invoke-Git @('-C', $source, 'commit', '-m', 'fixture')

  Set-Variable -Name HOME -Value $profile -Force
  $env:USERPROFILE = $profile
  $env:AGENT_WORKFLOW_REPO_URL = $source
  $env:CODEX_HOME = Join-Path $testRoot 'codex home'

  Invoke-Installer @('--local', '--target', $project, '--dry-run')
  Assert (-not (Test-Path -LiteralPath $cache)) 'Dry run created the cache'
  Assert (-not (Test-Path -LiteralPath (Join-Path $project '.agents'))) 'Dry run installed files'
  Write-Output 'PASS: dry run leaves cache and target unchanged'

  $globalSkill = Join-Path $profile '.agents/skills/alpha'
  $foreignSkill = Join-Path $testRoot 'foreign-skill'
  New-Item -ItemType Directory -Path $foreignSkill, (Split-Path -Parent $globalSkill) -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $foreignSkill 'marker.txt'), 'preserve me')
  New-Item -ItemType Junction -Path $globalSkill -Target $foreignSkill | Out-Null
  Invoke-Installer @('--global', '--force')
  $globalAgent = Join-Path $profile '.agents/agents/runner'
  Assert (Test-Path -LiteralPath (Join-Path $globalSkill 'SKILL.md')) 'Shared skill was not installed'
  Assert (Test-Path -LiteralPath (Join-Path $globalAgent 'AGENT.md')) 'Shared agent was not installed'
  Assert (Test-Path -LiteralPath (Join-Path $foreignSkill 'marker.txt')) 'Replacing a foreign junction deleted its target'
  Invoke-Installer @('--uninstall', '--global')
  Assert (-not (Test-Path -LiteralPath $globalSkill)) 'Shared skill remained after uninstall'
  Assert (-not (Test-Path -LiteralPath $globalAgent)) 'Shared agent remained after uninstall'
  Assert (Test-Path -LiteralPath (Join-Path $cache 'utility/alpha/SKILL.md')) 'Uninstall removed the cache source'
  Write-Output 'PASS: shared install and uninstall preserve the cache source'

  Invoke-Installer @('--claude-local', '--target', $project, '--force')
  $claudeSkill = Join-Path $project '.claude/skills/alpha'
  $claudeAgent = Join-Path $project '.claude/agents/runner.md'
  $runner = Join-Path $project '.claude/bin/runner.cmd'
  $powershellRunner = Join-Path $project '.claude/bin/runner-powershell.ps1'
  Assert (Test-Path -LiteralPath (Join-Path $claudeSkill 'SKILL.md')) 'Claude skill was not installed'
  Assert (Test-Path -LiteralPath $claudeAgent) 'Claude agent was not installed'
  Assert (Test-Path -LiteralPath $runner) 'Windows runner was not installed'
  Assert (Test-Path -LiteralPath $powershellRunner) 'PowerShell runner was not installed'
  $runnerOutput = & $runner 'argument with spaces'
  Assert ($LASTEXITCODE -eq 0) 'Windows runner failed'
  Assert ($runnerOutput -eq '["argument with spaces"]') "Windows runner lost its argument: $runnerOutput"
  $prompt = "quote `"inside`" and a second line`nwith a path C:\folder\`"name`""
  $powershellOutput = & $powershellRunner '--prompt' $prompt | ConvertFrom-Json
  Assert ($LASTEXITCODE -eq 0) 'PowerShell runner failed'
  Assert ($powershellOutput[1] -ceq $prompt) 'PowerShell runner changed a quoted multiline prompt'
  Invoke-Installer @('--uninstall', '--claude-local', '--target', $project)
  Assert (-not (Test-Path -LiteralPath $claudeSkill)) 'Claude skill remained after uninstall'
  Assert (-not (Test-Path -LiteralPath $claudeAgent)) 'Claude agent remained after uninstall'
  Assert (-not (Test-Path -LiteralPath $runner)) 'Windows runner remained after uninstall'
  Assert (-not (Test-Path -LiteralPath $powershellRunner)) 'PowerShell runner remained after uninstall'
  Write-Output 'PASS: Claude local install, runner and uninstall work with spaces and Unicode'

  Invoke-Installer @('--all-global', '--force')
  $globalClaudeSkill = Join-Path $profile '.claude/skills/alpha'
  $globalSharedSkill = Join-Path $profile '.agents/skills/alpha'
  $globalCodexSkill = Join-Path $env:CODEX_HOME 'skills/alpha'
  $globalRunner = Join-Path $profile '.local/bin/runner.cmd'
  $globalPowerShellRunner = Join-Path $profile '.local/bin/runner-powershell.ps1'
  foreach ($path in @($globalClaudeSkill, $globalSharedSkill, $globalCodexSkill, $globalRunner, $globalPowerShellRunner)) {
    Assert (Test-Path -LiteralPath $path) "All-global did not install $path"
  }
  Invoke-Installer @('--uninstall', '--all-global')
  foreach ($path in @($globalClaudeSkill, $globalSharedSkill, $globalCodexSkill, $globalRunner, $globalPowerShellRunner)) {
    Assert (-not (Test-Path -LiteralPath $path)) "All-global did not remove $path"
  }
  Write-Output 'PASS: all-global installs and removes every Windows destination'
} finally {
  Set-Variable -Name HOME -Value $previousHome -Force
  $env:USERPROFILE = $previousUserProfile
  $env:AGENT_WORKFLOW_REPO_URL = $previousRepoUrl
  $env:CODEX_HOME = $previousCodexHome
  $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedRoot.StartsWith("$tempBase$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedRoot)) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  }
}
