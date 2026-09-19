# Replace out\wb2api.exe with a freshly built out\wb2api-new.exe, then leave the
# service stopped so autostart's port probe starts the new binary.
#
# Why this exists: "swap the binary" used to be a manual, interactive-only step
# (apply-update.cmd, which deliberately refuses non-interactive use because it
# kills live sessions). The staged build is now applied at logon instead, when no
# session depends on the gateway.
#
# Safety:
#   - Refuses while 7863 is listening (a live session would be cut off).
#   - Keeps a .old copy so a rollback is a file rename.
#   - No-op when no staged build exists, so it is safe to call every logon.

param(
  [string]$Service = 'wb2api'
)

$ErrorActionPreference = 'Continue'

$dir = 'G:\workbuddy2api'
$cur = Join-Path $dir 'out\wb2api.exe'
$new = Join-Path $dir 'out\wb2api-new.exe'
$old = Join-Path $dir 'out\wb2api.exe.old'

if (-not (Test-Path -LiteralPath $new)) { exit 0 }   # nothing staged

$listening = $null -ne (Get-NetTCPConnection -State Listen -LocalPort 7863 -ErrorAction SilentlyContinue)
if ($listening) {
  Write-Host "[apply-staged] 7863 is listening; NOT swapping (a live session would be cut off)."
  exit 0
}

# Only replace when the staged build is actually newer, so a stale stage cannot
# overwrite a newer installed binary.
$curTime = if (Test-Path -LiteralPath $cur) { (Get-Item -LiteralPath $cur).LastWriteTimeUtc } else { [datetime]::MinValue }
$newTime = (Get-Item -LiteralPath $new).LastWriteTimeUtc
if ($newTime -le $curTime) {
  Write-Host "[apply-staged] staged build is not newer; nothing to do."
  exit 0
}

if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
if (Test-Path -LiteralPath $cur) { Move-Item -LiteralPath $cur -Destination $old -Force }
Move-Item -LiteralPath $new -Destination $cur -Force
Write-Host "[apply-staged] installed $cur (previous kept as wb2api.exe.old)"
