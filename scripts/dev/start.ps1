# Start the selected zichan development or local-server mode.
# The default is web. Other modes: sync, server, desktop, all.
param(
  [ValidateSet('web', 'sync', 'server', 'desktop', 'all')]
  [string]$Mode = 'web'
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

function Stop-Port([int]$p) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { taskkill /PID $_ /T /F *> $null }
}

function Mode-Ports([string]$mode) {
  switch ($mode) {
    'web' { @(5173) }
    'desktop' { @(5173) }
    'sync' { @(8787) }
    'server' { @(8787) }
    'all' { @(5173, 8787) }
  }
}

function Mode-Commands([string]$mode) {
  switch ($mode) {
    'web' { @(@{ Name = 'Web'; Url = 'http://localhost:5173'; Command = 'npm run dev --workspace @zichan/web' }) }
    'sync' { @(@{ Name = 'Sync API'; Url = 'http://localhost:8787/api/health'; Command = 'npm start --workspace @zichan/sync-server' }) }
    'server' { @(@{ Name = 'Desktop all-in-one server'; Url = 'http://localhost:8787'; Command = 'npm run server --workspace @zichan/desktop' }) }
    'desktop' { @(@{ Name = 'Tauri desktop'; Url = 'native window + http://localhost:5173'; Command = 'npm run dev --workspace @zichan/desktop' }) }
    'all' {
      @(
        @{ Name = 'Web'; Url = 'http://localhost:5173'; Command = 'npm run dev --workspace @zichan/web' },
        @{ Name = 'Desktop all-in-one server'; Url = 'http://localhost:8787'; Command = 'npm run server --workspace @zichan/desktop' }
      )
    }
  }
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'First run: installing dependencies (npm install) ...' -ForegroundColor Yellow
  npm install
}

$ports = Mode-Ports $Mode
foreach ($p in $ports) { Stop-Port $p }

$commands = Mode-Commands $Mode
Write-Host ''
Write-Host "zichan start mode: $Mode" -ForegroundColor Green
foreach ($item in $commands) {
  Write-Host "   $($item.Name) -> $($item.Url)" -ForegroundColor Green
}
Write-Host '   Press Ctrl+C to stop and clean up child processes and ports.' -ForegroundColor DarkGray
Write-Host ''

$procs = @()
foreach ($item in $commands) {
  $procs += Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', $item.Command `
    -NoNewWindow -PassThru -WorkingDirectory $root
}

try {
  while ($true) {
    $alive = $procs | Where-Object { -not $_.HasExited }
    if (-not $alive) { break }
    Start-Sleep -Seconds 1
  }
} finally {
  Write-Host ''
  Write-Host 'Stopping and cleaning up ...' -ForegroundColor Yellow
  foreach ($proc in $procs) {
    if (-not $proc.HasExited) { taskkill /PID $proc.Id /T /F *> $null }
  }
  foreach ($p in $ports) { Stop-Port $p }
  Write-Host "   Cleaned ports $($ports -join ', ') and stopped child processes." -ForegroundColor DarkGray
}
