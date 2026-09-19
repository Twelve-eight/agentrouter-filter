# Start one service DETACHED, then tail its log in this tab.
#
# Design (each point was tested, not assumed):
#
#   Lifetime - the service must outlive the terminal window. wb2api is the API
#   endpoint live agent sessions talk to (its DEPLOY-NOTES: never kill it while
#   sessions run) and a shared WT window is easy to close by accident, so the
#   service is started detached and this tab only *watches* it. Verified: killing
#   the tailing powershell left the detached process still listening.
#
#   Logging - `Start-Process -RedirectStandardOutput` TRUNCATES the target and
#   cannot merge stderr, which would have wiped wb2api's log history and split
#   Go's stderr logging into a second file. The detached child is therefore
#   launched through cmd.exe with `>> log 2>&1`, which appends and merges exactly
#   like the previous launchers. Verified: a pre-existing line survived and the
#   new output was appended to the same file.
#
#   Tailing - Get-Content -Wait reads while the writer holds the handle, so the
#   tab streams the log live without extra plumbing.

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

function Quote-Arg([string]$s) {
  if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s }
}

# Already running? Then this tab is just a viewer.
$already = $null -ne (Get-NetTCPConnection -State Listen -LocalPort $spec.Port -ErrorAction SilentlyContinue)
if (-not $already) {
  $exeLine = (Quote-Arg $spec.Exe) + ' ' + (($spec.Args | ForEach-Object { Quote-Arg $_ }) -join ' ')
  # cmd /c "<cmdline> >> <log> 2>&1": append (never truncate) and merge streams,
  # matching the `start /min cmd /c ".. >> log 2>&1"` launchers this replaces.
  $cmdArgs = '/c ' + $exeLine + ' >> "' + $spec.Log + '" 2>&1'
  $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs `
    -WorkingDirectory $spec.Dir -WindowStyle Hidden -PassThru
  Write-Host "[run-service-tab] started $Service via cmd wrapper (pid $($proc.Id)) in $($spec.Dir)"
  Start-Sleep -Seconds 2
} else {
  Write-Host "[run-service-tab] $Service already listening on $($spec.Port); viewing only"
}

Write-Host "[run-service-tab] tailing $($spec.Log) - closing this tab will NOT stop $Service"

if (-not (Test-Path -LiteralPath $spec.Log)) {
  Write-Host "[run-service-tab] waiting for $($spec.Log) .."
  while (-not (Test-Path -LiteralPath $spec.Log)) { Start-Sleep -Seconds 1 }
}

# Get-Content -Wait blocks this runspace, which is exactly what a tail tab wants;
# the finally block still runs on Ctrl+C / tab close.
try {
  Get-Content -LiteralPath $spec.Log -Wait -Tail 30
} finally {
  Write-Host "[run-service-tab] tail stopped (service keeps running)"
}
