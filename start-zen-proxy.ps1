# Start the opencode zen reverse proxy detached.
$env:NODE_USE_ENV_PROXY = '1'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }
$port = 7901
$existing = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) { Write-Host "already listening (pid $($existing.OwningProcess))"; exit 0 }
Start-Process -FilePath 'G:\nodejs\node.exe' -ArgumentList '"G:\omp works\Tools\agentrouter-filter\oc-zen-proxy.mjs"' -WorkingDirectory 'G:\omp works\Tools\agentrouter-filter' -WindowStyle Hidden
Start-Sleep -Seconds 2
$now = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($now) { Write-Host "started (pid $($now.OwningProcess))" } else { Write-Host "FAILED"; exit 1 }
