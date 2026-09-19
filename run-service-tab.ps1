# Start one service DETACHED, then tail its log in this tab.
#
# Design (chosen after testing the alternatives):
#   - The service must outlive the terminal window. wb2api is the API endpoint
#     live agent sessions talk to (its own DEPLOY-NOTES: never kill it while
#     sessions run), and a shared WT window is easy to close by accident.
#     Attaching it to the tab (`& exe | Tee-Object`) would make a stray click
#     fatal, so the service is started detached and this tab only *watches* it.
#   - Start-Process -WindowStyle Hidden -RedirectStandardOutput is the only
#     PS 5.1 mechanism that streams a detached child's output to a file live.
#     The ProcessStartInfo route needs ArgumentList (PS7-only) and
#     `OutputDataReceived +=` (unsupported on PS 5.1's Process).
#   - stdout and stderr go to SEPARATE files (Start-Process cannot merge them),
#     and Go's log package writes to stderr, so the tab tails BOTH - otherwise
#     the wb2api/wbgui tabs would sit blank while the real log went to .err.
#   - Get-Content -Wait on two paths reads fine while the writer holds the
#     handles (Start-Process opens them share-read), which is why this works
#     without the FileStream/FileShare plumbing an earlier version needed.

param(
  [Parameter(Mandatory = $true)][string]$Service
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'services.ps1')

if (-not $ServiceTable.Contains($Service)) {
  Write-Host "unknown service key: $Service"
  exit 2
}

$spec = $ServiceTable[$Service]
$Host.UI.RawUI.WindowTitle = $Service

$logDir = Split-Path -Parent $spec.Log
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$errLog = "$($spec.Log).err"

# Already running? Then this tab is just a viewer.
$already = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $spec.Port -ErrorAction SilentlyContinue)
if (-not $already) {
  $argLine = (($spec.Args | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $proc = Start-Process -FilePath $spec.Exe `
    -ArgumentList $argLine `
    -WorkingDirectory $spec.Dir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $spec.Log `
    -RedirectStandardError $errLog `
    -PassThru
  Write-Host "[run-service-tab] started $Service (pid $($proc.Id)) in $($spec.Dir)"
  Start-Sleep -Seconds 2
} else {
  Write-Host "[run-service-tab] $Service already listening on $($spec.Port); viewing only"
}

Write-Host "[run-service-tab] tailing $($spec.Log) (+ .err) - closing this tab will NOT stop $Service"

# Tail both streams. Two background readers keep the tab live for either source.
$jobs = @()
if (Test-Path -LiteralPath $spec.Log) {
  $jobs += Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait -Tail 20 } -ArgumentList $spec.Log
}
if (Test-Path -LiteralPath $errLog) {
  $jobs += Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait -Tail 20 } -ArgumentList $errLog
}
if ($jobs.Count -eq 0) {
  Write-Host "[run-service-tab] no log file yet at $($spec.Log); waiting for it.."
  while (-not (Test-Path -LiteralPath $spec.Log)) { Start-Sleep -Seconds 1 }
  $jobs += Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait -Tail 20 } -ArgumentList $spec.Log
}

# Stream job output to this console until the tab is closed.
try {
  while ($true) {
    Receive-Job -Job $jobs
    Start-Sleep -Milliseconds 500
  }
} finally {
  $jobs | Stop-Job -ErrorAction SilentlyContinue
  $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
}
