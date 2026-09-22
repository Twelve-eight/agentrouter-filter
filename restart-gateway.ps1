<#
Restart the unified gateway (server.mjs) in place with the current working tree.

Why this exists (each point was a real failure mode):
  - The gateway is the only path Codex has to every upstream, so a restart is a
    short but complete outage of all providers. The window must stay inside one
    command: check -> stop -> start -> verify.
  - `node --check` on every module BEFORE stopping anything: a syntax error in an
    edited file used to mean a dead gateway rather than a refused restart.
  - The listener is matched against its own command line, so the script can never
    stop an unrelated process that happens to hold the port.
  - Startup output is appended (never truncated) with `>> log 2>&1`, matching
    services.ps1, so gateway.log history and stderr stay in one file.
  - Files are snapshotted to <workspace>\.tmp\gateway-restart-<stamp>\ first, so
    the exact pre-restart code can be restored even if git is not usable.

Usage:
  powershell -File restart-gateway.ps1                 # restart + verify
  powershell -File restart-gateway.ps1 -CheckOnly      # syntax + snapshot only
#>
[CmdletBinding()]
param(
  [int]$Port = 7878,
  [string]$LogPath = 'G:\omp works\.tmp\argw-autostart.log',
  [string]$SnapshotRoot = 'G:\omp works\.tmp',
  [switch]$CheckOnly,
  [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'G:\nodejs\node.exe'
$entry = Join-Path $here 'server.mjs'

function Fail([string]$msg) { Write-Host "FAIL: $msg"; exit 1 }

# 1. syntax gate -------------------------------------------------------------
$modules = Get-ChildItem -LiteralPath $here -File -Filter *.mjs
foreach ($m in $modules) {
  & $node --check $m.FullName
  if ($LASTEXITCODE -ne 0) { Fail "node --check failed on $($m.Name)" }
}
Write-Host "[1/5] syntax ok ($($modules.Count) modules)"

# 2. snapshot ----------------------------------------------------------------
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$snap = Join-Path $SnapshotRoot "gateway-restart-$stamp"
New-Item -ItemType Directory -Path $snap -Force | Out-Null
foreach ($name in 'server.mjs', 'bridge.mjs', 'filter.mjs', 'providers.json', 'usage.mjs', 'stats-api.mjs') {
  $f = Join-Path $here $name
  if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination (Join-Path $snap $name) -Force }
}
try {
  (git -C $here rev-parse HEAD) | Out-File -LiteralPath (Join-Path $snap 'HEAD.txt') -Encoding ascii
  (git -C $here status --short) | Out-File -LiteralPath (Join-Path $snap 'git-status.txt') -Encoding ascii
} catch { Write-Host "      (git snapshot skipped: $($_.Exception.Message))" }
Write-Host "[2/5] snapshot -> $snap"

if ($CheckOnly) { Write-Host 'CheckOnly: not touching the running gateway.'; exit 0 }

# 3. stop the listener (only if it is this gateway) --------------------------
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
$oldPid = $null
if ($conn) {
  $oldPid = ($conn | Select-Object -First 1).OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
  $cmd = [string]$proc.CommandLine
  if ($cmd -notmatch 'server\.mjs') { Fail "port $Port is held by pid $oldPid ($($proc.Name)) which is not server.mjs: $cmd" }
  if ($cmd -notmatch [regex]::Escape($here)) { Fail "pid $oldPid holds port $Port but runs from another directory: $cmd" }
  Write-Host "[3/5] stopping pid $oldPid (server.mjs)"
  Stop-Process -Id $oldPid -Force
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { Fail "port $Port still listening after stop" }
} else {
  Write-Host "[3/5] nothing listening on $Port (starting fresh)"
}

# 4. start detached ----------------------------------------------------------
$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$cmdArgs = '/c ""' + $node + '" "' + $entry + '" >> "' + $LogPath + '" 2>&1"'
$newProc = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdArgs -WorkingDirectory $here -WindowStyle Hidden -PassThru
Write-Host "[4/5] start requested (cmd wrapper pid $($newProc.Id))"

# 5. verify ------------------------------------------------------------------
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$listener = $null
while ((Get-Date) -lt $deadline) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($listener) { break }
  Start-Sleep -Milliseconds 300
}
if (-not $listener) { Fail "gateway did not listen on $Port within $TimeoutSeconds s - check $LogPath" }
$newPid = ($listener | Select-Object -First 1).OwningProcess
$models = $null
try {
  $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/u/v1/models" -TimeoutSec 10
} catch {
  Fail "listening (pid $newPid) but /u/v1/models failed: $($_.Exception.Message)"
}
$count = @($models.data).Count
if ($count -lt 1) { Fail "gateway answered /u/v1/models with 0 models" }
Write-Host "[5/5] gateway up: pid $newPid, $count models"
exit 0
