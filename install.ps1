# PowerShell entry point for the same install modes as install.sh.
# Git and Bun are required for executable agents; Git is required for every install.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$categories = @('utility', 'discovery', 'design', 'planning', 'implementation', 'diagnosis', 'review')
$cache = Join-Path $HOME '.cache/agent-workflow'
$cacheParent = Split-Path -Parent $cache
$manifestPath = Join-Path $cacheParent 'agent-workflow-copies.json'
$repoUrl = if ($env:AGENT_WORKFLOW_REPO_URL) { $env:AGENT_WORKFLOW_REPO_URL } else { 'https://github.com/elvisbrevi/agent-workflow.git' }
$ref = 'main'
$mode = ''
$target = (Get-Location).Path
$dryRun = $false
$force = $false
$uninstall = $false
$managedCopies = @{}

function Fail([string]$message) { throw $message }
function Exists([string]$path) { return $null -ne (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) }
function Usage {
  @'
Usage: install.ps1 [OPTIONS]

Install agent-workflow skills and agents in the same destinations as install.sh.

  --all-global       All supported global integrations
  --claude-global    Claude skills, agents and launcher globally
  --claude-local     Claude skills, agents and launcher in --target
  --global           Shared ~/.agents/ skills and agents
  --local            Local .agents/ skills and agents
  --opencode         Local .opencode/ skills and agents
  --codex            Codex skills globally
  --both             Local .agents/ and .opencode/
  --target D         Project directory for local modes (default: current directory)
  --uninstall        Remove managed entries
  --dry-run          Preview without changing installed files or cache
  --force            Replace existing entries without prompting
  --ref REF          Branch or tag (default: main)
  -h, --help         Show this help
'@ | Write-Output
}

for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    { $_ -in @('--all-global', '--claude-global', '--claude-local', '--global', '--local', '--opencode', '--codex', '--both') } {
      $mode = $args[$i].Substring(2); break
    }
    '--target' {
      if ($i + 1 -ge $args.Count) { Fail '--target requires a directory' }
      $i++; $target = [string]$args[$i]; break
    }
    '--ref' {
      if ($i + 1 -ge $args.Count) { Fail '--ref requires a branch or tag' }
      $i++; $ref = [string]$args[$i]; break
    }
    '--dry-run' { $dryRun = $true; break }
    '--force' { $force = $true; break }
    '--uninstall' { $uninstall = $true; break }
    { $_ -in @('-h', '--help') } { Usage; exit 0 }
    default { Fail "Unknown option: $($args[$i]). Use --help for usage." }
  }
}

if (-not $mode) {
  if ([Console]::IsInputRedirected) { Fail 'Interactive mode requires a TTY. Pass an explicit mode such as --all-global.' }
  Write-Host '1) All global  2) Claude global  3) Claude local  4) Shared global'
  Write-Host '5) Shared local  6) OpenCode local  7) Both local  8) Codex global'
  $choice = Read-Host 'Select [1-8]'
  $modes = @('all-global', 'claude-global', 'claude-local', 'global', 'local', 'opencode', 'both', 'codex')
  if ($choice -notmatch '^[1-8]$') { Fail "Invalid selection: $choice" }
  $mode = $modes[[int]$choice - 1]
  if ($mode -in @('claude-local', 'local', 'opencode', 'both')) {
    $answer = Read-Host 'Project directory (Enter for current directory)'
    if ($answer) { $target = $answer }
  }
  $dryRun = (Read-Host 'Dry run? [y/N]') -match '^[Yy]$'
}

if (-not (Test-Path -LiteralPath $target -PathType Container)) { Fail "Target directory not found: $target" }
$target = (Resolve-Path -LiteralPath $target).Path

function Load-Manifest {
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return }
  $saved = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($property in $saved.PSObject.Properties) { $script:managedCopies[$property.Name] = [string]$property.Value }
}

function Save-Manifest {
  if ($dryRun) { return }
  New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null
  $json = ConvertTo-Json -InputObject $managedCopies -Depth 3
  [IO.File]::WriteAllText($manifestPath, "$json`n")
}

function Discover-Skills([string]$source) {
  foreach ($category in $categories) {
    $directory = Join-Path $source $category
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($skill in (Get-ChildItem -LiteralPath $directory -Directory)) {
      if (Test-Path -LiteralPath (Join-Path $skill.FullName 'SKILL.md') -PathType Leaf) {
        [pscustomobject]@{ Name = $skill.Name; Source = $skill.FullName }
      }
    }
  }
}

function Discover-Agents([string]$source) {
  $directory = Join-Path $source 'agent'
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return }
  foreach ($agent in (Get-ChildItem -LiteralPath $directory -Directory)) {
    if (Test-Path -LiteralPath (Join-Path $agent.FullName 'AGENT.md') -PathType Leaf) {
      [pscustomobject]@{ Name = $agent.Name; Source = $agent.FullName }
    }
  }
}

function Prepare-Dependencies([string]$source) {
  if ($dryRun -or $uninstall -or $mode -notin @('all-global', 'claude-global', 'claude-local')) { return }
  foreach ($agent in (Discover-Agents $source)) {
    $package = Join-Path $agent.Source 'package.json'
    if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { continue }
    if (-not (Exists (Join-Path $agent.Source 'run.sh')) -and -not (Exists (Join-Path $agent.Source 'run.cmd'))) { continue }
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail 'Bun is required to install executable agent dependencies.' }
    Write-Host "Installing runtime dependencies for $($agent.Name)..."
    Push-Location $agent.Source
    try {
      & bun install --frozen-lockfile | Out-Host
      if ($LASTEXITCODE -ne 0) { Fail "Unable to install dependencies for $($agent.Name)." }
    } finally { Pop-Location }
  }
}

function Sync-Cache {
  if ($dryRun -and (Test-Path -LiteralPath $cache -PathType Container)) { return $cache }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is required to install agent-workflow.' }
  $temporary = if ($dryRun) { Join-Path ([IO.Path]::GetTempPath()) ("agent-workflow-preview-" + [guid]::NewGuid()) } else { "$cache.refresh.$PID" }
  $previous = "$cache.previous.$PID"
  if (-not $dryRun) { New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null }
  Write-Host "Refreshing managed cache ($ref)..."
  & git clone --branch $ref --depth 1 $repoUrl $temporary --quiet
  if ($LASTEXITCODE -ne 0) {
    if (Exists $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    Fail "Unable to download $repoUrl at $ref; existing cache was left untouched."
  }
  if ($dryRun) { return $temporary }
  try {
    Prepare-Dependencies $temporary
    if (Exists $cache) { Move-Item -LiteralPath $cache -Destination $previous }
    try { Move-Item -LiteralPath $temporary -Destination $cache }
    catch {
      if (Exists $previous) { Move-Item -LiteralPath $previous -Destination $cache }
      throw
    }
    if (Exists $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    Write-Host "Managed cache refreshed: $cache"
    return $cache
  } finally {
    if (Exists $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}

function Link-Target([IO.FileSystemInfo]$item) {
  if (-not $item.PSObject.Properties['LinkType'] -or -not $item.LinkType) { return $null }
  $linkTarget = $item.Target
  if ($linkTarget -is [array]) { $linkTarget = $linkTarget[0] }
  if (-not $linkTarget) { return $null }
  foreach ($prefix in @('\\?\', '\??\')) {
    if ($linkTarget.StartsWith($prefix)) { $linkTarget = $linkTarget.Substring($prefix.Length) }
  }
  return [string]$linkTarget
}

function Remove-Managed([string]$directory) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return }
  foreach ($item in (Get-ChildItem -LiteralPath $directory -Force)) {
    $owned = $false
    $linkTarget = Link-Target $item
    if ($linkTarget -and $linkTarget.StartsWith("$cache$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
      $owned = $true
    } elseif ($managedCopies.ContainsKey($item.FullName) -and -not $item.PSIsContainer) {
      $owned = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -eq $managedCopies[$item.FullName]
      [void]$managedCopies.Remove($item.FullName)
    }
    if ($owned) {
      if ($dryRun) { Write-Host "  dry-run  remove managed $($item.FullName)" }
      else {
        # Windows PowerShell 5.1 prompts before Remove-Item on a populated
        # junction. Delete the junction itself without traversing its target.
        if ($item.PSIsContainer -and $linkTarget) { [IO.Directory]::Delete($item.FullName) }
        else { Remove-Item -LiteralPath $item.FullName -Force }
        Write-Host "Removed managed link: $($item.FullName)"
      }
    }
  }
}

function Prepare-Destination([string]$destination) {
  $existing = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
  if ($null -eq $existing) { return $true }
  if (-not $force) {
    if ([Console]::IsInputRedirected) { Fail "Cannot prompt to overwrite $destination without a TTY. Re-run with --force." }
    if ((Read-Host "Already exists: $destination. Overwrite? [y/N]") -notmatch '^[Yy]$') { return $false }
  }
  if ($existing.PSIsContainer) {
    if (Link-Target $existing) { [IO.Directory]::Delete($destination) }
    else { Remove-Item -LiteralPath $destination -Recurse -Force }
  } else { Remove-Item -LiteralPath $destination -Force }
  [void]$managedCopies.Remove($destination)
  return $true
}

function Install-Entry([string]$source, [string]$destination, [string]$kind) {
  if ($dryRun) { Write-Host "  dry-run  install $destination -> $source"; return }
  if (-not (Prepare-Destination $destination)) { return }
  try {
    $linkKind = if ($kind -eq 'directory' -and $env:OS -eq 'Windows_NT') { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkKind -Path $destination -Target $source | Out-Null
  } catch {
    if ($kind -eq 'directory') { Fail "Cannot link $destination to ${source}: $($_.Exception.Message)" }
    if (Exists $destination) { Remove-Item -LiteralPath $destination -Force }
    Copy-Item -LiteralPath $source -Destination $destination
    $managedCopies[$destination] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  }
  Write-Host "Installed: $destination"
}

function Install-Runner([string]$source, [string]$destination) {
  if ($env:OS -ne 'Windows_NT') {
    $unixLauncher = Join-Path $source 'run.sh'
    if (Exists $unixLauncher) { Install-Entry $unixLauncher $destination 'file' }
    return
  }
  $entrypoint = Join-Path $source 'main.ts'
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { return }
  if (-not (Exists (Join-Path $source 'run.cmd'))) { return }
  if ($dryRun) { Write-Host "  dry-run  install $destination -> $entrypoint"; return }
  if (-not (Prepare-Destination $destination)) { return }
  # Keep the batch file ASCII; %USERPROFILE% expands Unicode profile paths at
  # runtime even when cmd.exe reads the launcher using a legacy code page.
  $relative = $entrypoint.Substring($cache.Length).Replace('/', '\')
  $escaped = '%USERPROFILE%\.cache\agent-workflow' + $relative
  $content = "@echo off`r`nwhere bun >nul 2>nul`r`nif errorlevel 1 (echo lazy-workflow: Bun is required but was not found in PATH. 1>&2 & exit /b 127)`r`nbun run `"$escaped`" %*`r`nexit /b %errorlevel%`r`n"
  [IO.File]::WriteAllText($destination, $content, [Text.Encoding]::ASCII)
  $managedCopies[$destination] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  Write-Host "Installed runner: $destination"
}

function Install-PowerShellRunner([string]$source, [string]$destination) {
  $scriptPath = Join-Path $source 'run.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { return }
  if ($dryRun) { Write-Host "  dry-run  install $destination -> $scriptPath"; return }
  if (-not (Prepare-Destination $destination)) { return }
  $relative = $scriptPath.Substring($cache.Length).Replace('/', '\')
  $installedScript = '.cache\agent-workflow' + $relative
  $content = @'
$sourceScript = Join-Path $env:USERPROFILE '{{SCRIPT}}'
& $sourceScript @args
exit $LASTEXITCODE
'@
  $content = $content.Replace('{{SCRIPT}}', $installedScript)
  [IO.File]::WriteAllText($destination, $content, [Text.Encoding]::ASCII)
  $managedCopies[$destination] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  Write-Host "Installed PowerShell runner: $destination"
}

function Destinations {
  $claude = Join-Path $HOME '.claude'
  $shared = Join-Path $HOME '.agents'
  $bin = Join-Path $HOME '.local/bin'
  $codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  switch ($mode) {
    'all-global' {
      @{ Kind = 'skills'; Path = (Join-Path $claude 'skills') }
      @{ Kind = 'claude-agents'; Path = (Join-Path $claude 'agents') }
      @{ Kind = 'runners'; Path = $bin }
      @{ Kind = 'skills'; Path = (Join-Path $shared 'skills') }
      @{ Kind = 'agents'; Path = (Join-Path $shared 'agents') }
      @{ Kind = 'skills'; Path = (Join-Path $codex 'skills') }
    }
    'claude-global' {
      @{ Kind = 'skills'; Path = (Join-Path $claude 'skills') }
      @{ Kind = 'claude-agents'; Path = (Join-Path $claude 'agents') }
      @{ Kind = 'runners'; Path = $bin }
    }
    'claude-local' {
      @{ Kind = 'skills'; Path = (Join-Path $target '.claude/skills') }
      @{ Kind = 'claude-agents'; Path = (Join-Path $target '.claude/agents') }
      @{ Kind = 'runners'; Path = (Join-Path $target '.claude/bin') }
    }
    'global' {
      @{ Kind = 'skills'; Path = (Join-Path $shared 'skills') }
      @{ Kind = 'agents'; Path = (Join-Path $shared 'agents') }
    }
    'local' {
      @{ Kind = 'skills'; Path = (Join-Path $target '.agents/skills') }
      @{ Kind = 'agents'; Path = (Join-Path $target '.agents/agents') }
    }
    'opencode' {
      @{ Kind = 'skills'; Path = (Join-Path $target '.opencode/skills') }
      @{ Kind = 'agents'; Path = (Join-Path $target '.opencode/agent') }
    }
    'both' {
      @{ Kind = 'skills'; Path = (Join-Path $target '.agents/skills') }
      @{ Kind = 'agents'; Path = (Join-Path $target '.agents/agents') }
      @{ Kind = 'skills'; Path = (Join-Path $target '.opencode/skills') }
      @{ Kind = 'agents'; Path = (Join-Path $target '.opencode/agent') }
    }
    'codex' { @{ Kind = 'skills'; Path = (Join-Path $codex 'skills') } }
  }
}

try {
  Load-Manifest
  $source = Sync-Cache
  $skills = @(Discover-Skills $source)
  $agents = @(Discover-Agents $source)
  Write-Host "Skills found: $($skills.Count); agents found: $($agents.Count)"
  foreach ($destination in (Destinations)) {
    $directory = $destination.Path
    $kind = $destination.Kind
    $action = if ($uninstall) { 'Uninstalling' } else { 'Installing' }
    Write-Host "$action $kind -> $directory"
    if (-not $uninstall -and -not $dryRun) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    Remove-Managed $directory
    if ($uninstall) { continue }
    if ($kind -eq 'skills') {
      foreach ($skill in $skills) { Install-Entry $skill.Source (Join-Path $directory $skill.Name) 'directory' }
    } elseif ($kind -eq 'agents') {
      foreach ($agent in $agents) { Install-Entry $agent.Source (Join-Path $directory $agent.Name) 'directory' }
    } elseif ($kind -eq 'claude-agents') {
      foreach ($agent in $agents) { Install-Entry (Join-Path $agent.Source 'AGENT.md') (Join-Path $directory "$($agent.Name).md") 'file' }
    } elseif ($kind -eq 'runners') {
      foreach ($agent in $agents) {
        $runnerName = if ($env:OS -eq 'Windows_NT') { "$($agent.Name).cmd" } else { $agent.Name }
        Install-Runner $agent.Source (Join-Path $directory $runnerName)
        if ($env:OS -eq 'Windows_NT') {
          Install-PowerShellRunner $agent.Source (Join-Path $directory "$($agent.Name)-powershell.ps1")
        }
      }
    }
  }
  Save-Manifest
  if ($dryRun) { Write-Host 'Dry-run mode: no installed files or cache were changed.' }
  else { Write-Host 'Done!' }
  if ($source -ne $cache -and (Exists $source)) { Remove-Item -LiteralPath $source -Recurse -Force }
} catch {
  [Console]::Error.WriteLine("agent-workflow: $($_.Exception.Message)")
  exit 1
}
