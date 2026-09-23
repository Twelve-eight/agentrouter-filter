# Per-service environment overrides.
#
# IMPORTANT: do NOT export NODE_USE_ENV_PROXY / HTTPS_PROXY for the whole file.
# That was tried on 2026-09-22 and broke the gateway: with NODE_USE_ENV_PROXY=1
# Node's own http(s) machinery adds a CONNECT on top of the tunnel server.mjs
# already opens by hand for anyrouter (providers.json "proxy"), so the
# double-proxied handshake fails with
#   B0660000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error
#   (SSL alert number 80)
# and every anyrouter request 502s. The variables belong to the zen proxy ONLY,
# which reaches opencode.ai through the same local proxy (a direct TLS handshake
# to opencode.ai hangs: curl HTTP 000 after 20s, vs 200 in ~1.3s via the proxy).
# Node reads NODE_USE_ENV_PROXY at STARTUP, so it must be set on that child.

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
    # Scoped to this service only - see the note at the top of this file.
    Env  = @{
      NODE_USE_ENV_PROXY = '1'
      HTTPS_PROXY        = 'http://127.0.0.1:7897'
    }
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
