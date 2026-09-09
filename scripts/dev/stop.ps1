# Never stop a process just because it owns a port.
param([ValidateSet('web', 'sync', 'server', 'desktop', 'all')][string]$Mode = 'all')
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'runner.mjs') stop $Mode
exit $LASTEXITCODE
