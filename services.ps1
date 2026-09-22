# The zen free tier is reached through the local HTTP proxy: a direct TLS
# handshake to opencode.ai hangs (curl HTTP 000 after 20s) while the same GET
# through 127.0.0.1:7897 answers 200 in ~1.3s. Node only honours HTTPS_PROXY for
# its built-in fetch when NODE_USE_ENV_PROXY is set BEFORE the process starts,
# so export both here and let run-service-tab.ps1 inherit them.
$env:NODE_USE_ENV_PROXY = '1'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }

# Service table shared by autostart.ps1 (port probe + tab launch) and
# run-service-tab.ps1 (actual execution). Keeping the paths here means the only
# argument that crosses a process boundary is the space-free service key, which
# sidesteps Start-Process -ArgumentList's lack of quoting.

$ServiceTable = [ordered]@{
  'agentrouter-gw' = @{
    Port = 7878
    Dir  = 'G:\omp works\Tools\agentrouter-filter'
    Exe  = 'G:\nodejs\node.exe'
    Args = @('G:\omp works\Tools\agentrouter-filter\server.mjs')
    Log  = 'G:\omp works\.tmp\argw-autostart.log'
  }
  'opencode-zen-proxy' = @{
    Port = 7901
    Dir  = 'G:\omp works\Tools\agentrouter-filter'
    Exe  = 'G:\nodejs\node.exe'
    Args = @('G:\omp works\Tools\agentrouter-filter\oc-zen-proxy.mjs')
    Log  = 'G:\omp works\.tmp\oc-zen-proxy.log'
  }
  'wb2api'         = @{
    Port = 7863
    Dir  = 'G:\workbuddy2api'
    Exe  = 'G:\workbuddy2api\out\wb2api.exe'
    Args = @('-config', 'config.json')
    Log  = 'G:\workbuddy2api\logs\gateway.log'
  }
  'wbgui'          = @{
    Port = 8787
    Dir  = 'G:\workbuddy2api-gui'
    Exe  = 'G:\workbuddy2api-gui\wbgui.exe'
    Args = @('-config', 'config.json')
    Log  = 'G:\workbuddy2api-gui\logs\panel.log'
  }
}

# Launch order (gateway first: wbgui reports gateway health at startup).
$ServiceOrder = @('agentrouter-gw', 'opencode-zen-proxy', 'wb2api', 'wbgui')
