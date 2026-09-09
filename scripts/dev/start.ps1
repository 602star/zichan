# Compatibility wrapper; process ownership is managed by the shared Node launcher.
param(
  [ValidateSet('web', 'sync', 'server', 'desktop', 'all')][string]$Mode = 'server',
  [switch]$NoBuild,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$launcherArgs = @((Join-Path $PSScriptRoot 'runner.mjs'), 'start', $Mode)
if ($NoBuild) { $launcherArgs += '--no-build' }
if ($Check) { $launcherArgs += '--check' }
& node @launcherArgs
exit $LASTEXITCODE
