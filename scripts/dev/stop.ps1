# Stop processes listening on the ports used by the selected development mode.
param(
  [ValidateSet('web', 'sync', 'server', 'desktop', 'all')]
  [string]$Mode = 'all'
)

function Mode-Ports([string]$mode) {
  switch ($mode) {
    'web' { @(5173) }
    'desktop' { @(5173) }
    'sync' { @(8787) }
    'server' { @(8787) }
    'all' { @(5173, 8787) }
  }
}

$ports = Mode-Ports $Mode
$stopped = @()

foreach ($port in $ports) {
  $ids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  if ($ids) {
    foreach ($processId in $ids) { taskkill /PID $processId /T /F *> $null }
    $stopped += "port $port (PID: $($ids -join ', '))"
  }
}

if ($stopped.Count) {
  Write-Host "Stopped: $($stopped -join '; ')" -ForegroundColor Green
} else {
  Write-Host "No listener for mode $Mode on ports: $($ports -join ', ')." -ForegroundColor DarkGray
}
