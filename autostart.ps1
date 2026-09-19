# agentrouter / workbuddy stack autostart (login), rendered as Windows Terminal tabs.
#
# Replaces the two console-based launchers:
#   - HKCU\..\Run  "agentrouter-gateway" -> agentrouter-filter\autostart.cmd
#   - Startup      "WorkBuddyGateway.cmd" -> two minimized cmd consoles
#
# One `wt` invocation opens ONE Windows Terminal window with one tab per service,
# so the three services sit together instead of in stray consoles. -w names the
# window, so a later launch with the same name adds tabs to that same window
# rather than opening a second one (verified).
#
# Ports are probed first: an already-listening service is skipped, which makes a
# manual re-run safe (and is why the live-services case is a no-op).
#
# NOTE: `;` between tab definitions is REQUIRED - wt parses everything after
# `new-tab ..` up to the next `;` as that tab's command line.

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'services.ps1')

$runner = Join-Path $here 'run-service-tab.ps1'
$wt = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
if (-not (Test-Path $wt)) { $wt = 'wt.exe' }

function Test-Listening([int]$Port) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

# Quote an argument for the wt command line (spaces / quotes need wrapping).
function Quote([string]$s) {
  if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s }
}

$tabs = @()

# Apply any staged wb2api build before probing ports. It refuses while 7863 is
# listening, so at logon (nothing running yet) a pending fix takes effect, and
# during a live session it is a harmless no-op.
& (Join-Path $here 'apply-staged-wb2api.ps1')

foreach ($key in $ServiceOrder) {
  $spec = $ServiceTable[$key]
  if (Test-Listening $spec.Port) { continue }
  if ($tabs.Count -gt 0) { $tabs += ';' }
  # Only the space-free $key crosses the boundary; run-service-tab.ps1 resolves
  # the paths from services.ps1. Quoting is still applied because the script
  # paths themselves live under "G:\omp works".
  $tabs += @(
    'new-tab', '--title', $key, '--suppressApplicationTitle',
    'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote $runner), '-Service', $key
  )
}

if ($tabs.Count -eq 0) { exit 0 }

Start-Process -FilePath $wt -ArgumentList (@('-w', 'omp-services') + $tabs)
