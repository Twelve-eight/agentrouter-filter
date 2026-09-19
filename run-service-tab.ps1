# Run one service in this tab, showing its output AND appending it to its log.
#
# Only the space-free service key crosses the process boundary (the paths live in
# services.ps1), because Start-Process -ArgumentList joins arguments with spaces
# without quoting them.
#
# Constraints this works around (Windows PowerShell 5.1, not PS7):
#   - ProcessStartInfo has no ArgumentList; a single quoted Arguments string is used.
#   - System.Diagnostics.Process does not support `$proc.OutputDataReceived += ...`;
#     the streams are read synchronously with ReadLine() instead.
#   - Tee-Object -Append / cmd's `>>` hold the log open exclusively, so a second
#     writer fails; the log is opened through a FileStream with FileShare.ReadWrite.

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

# Shared-writer log handle: never blocks another reader/writer.
$stream = [System.IO.File]::Open(
  $spec.Log,
  [System.IO.FileMode]::Append,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::ReadWrite
)
$writer = New-Object System.IO.StreamWriter($stream)
$writer.AutoFlush = $true

function Quote-Arg([string]$s) {
  if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s }
}

try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $spec.Exe
  $psi.WorkingDirectory = $spec.Dir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.Arguments = (($spec.Args | ForEach-Object { Quote-Arg $_ }) -join ' ')

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()

  # Read both pipes without deadlocking: stderr is drained on a background task,
  # stdout on this thread. ReadLine() blocks until a line or EOF, so the loop
  # simply runs until stdout closes (the process exiting closes it).
  $errTask = $proc.StandardError.ReadToEndAsync()

  while ($true) {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    Write-Host $line
    $writer.WriteLine($line)
  }

  $err = $errTask.GetAwaiter().GetResult()
  if ($err) {
    foreach ($e in ($err -split "`r?`n")) {
      if ($e) { Write-Host $e; $writer.WriteLine($e) }
    }
  }

  $msg = "[run-service-tab] $Service exited with code $($proc.ExitCode)"
  Write-Host $msg
  $writer.WriteLine($msg)
} finally {
  $writer.Flush()
  $writer.Dispose()
  $stream.Dispose()
}
