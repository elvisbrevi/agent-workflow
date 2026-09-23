# Human-in-the-loop reproduction loop for PowerShell.
# Copy this file, edit the steps below, and run it with:
#   .\hitl-loop.template.ps1

$ErrorActionPreference = 'Stop'

function Step([string]$instruction) {
  Write-Host "`n>>> $instruction"
  [void](Read-Host '    [Enter when done]')
}

function Capture([string]$question) {
  Write-Host "`n>>> $question"
  return Read-Host '    >'
}

# --- edit below ---------------------------------------------------------

Step 'Open the app at http://localhost:3000 and sign in.'

$errored = Capture "Click the 'Export' button. Did it throw an error? (y/n)"

$errorMessage = Capture "Paste the error message (or 'none'):"

# --- edit above ---------------------------------------------------------

Write-Output "`n--- Captured ---"
Write-Output "ERRORED=$errored"
Write-Output "ERROR_MSG=$errorMessage"
