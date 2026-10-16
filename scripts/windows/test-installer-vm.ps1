param(
  [Parameter(Mandatory = $true)][ValidateSet('msi', 'nsis')][string]$Format,
  [Parameter(Mandatory = $true)][string]$CurrentInstaller,
  [Parameter(Mandatory = $true)][string]$CurrentVersion,
  [string]$PreviousInstaller,
  [string]$PreviousVersion,
  [string]$InstallRoot,
  [switch]$SkipLaunch,
  [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
if ($env:ZICHAN_INSTALLER_VM -ne '1') {
  throw 'Installer smoke test modifies Windows installation state. Set ZICHAN_INSTALLER_VM=1 inside a disposable VM.'
}
if ([bool]$PreviousInstaller -ne [bool]$PreviousVersion) {
  throw 'PreviousInstaller and PreviousVersion must be supplied together.'
}
if ($PreviousInstaller -and ([version]$PreviousVersion -ge [version]$CurrentVersion)) {
  throw 'PreviousVersion must be lower than CurrentVersion for an upgrade test.'
}
if (-not $InstallRoot) {
  $InstallRoot = if ($Format -eq 'msi') {
    Join-Path $env:ProgramFiles '资产生命周期'
  } else {
    Join-Path $env:LOCALAPPDATA '资产生命周期'
  }
}
$CurrentInstaller = (Resolve-Path -LiteralPath $CurrentInstaller).Path
if ($PreviousInstaller) { $PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstaller).Path }
$dataRoot = Join-Path $env:LOCALAPPDATA 'com.zichan.ledger'
if (Test-Path -LiteralPath $dataRoot) { throw "VM must start without application data: $dataRoot" }
if (Test-Path -LiteralPath $InstallRoot) { throw "VM must start without an existing installation: $InstallRoot" }
if ($Format -eq 'msi' -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'MSI smoke test requires an elevated VM shell'
}

function Assert-Signature([string]$path) {
  if (-not $RequireSignature) { return }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
    throw "Missing trusted signature or timestamp: $path"
  }
}

function Install-Package([string]$path, [string]$label) {
  Assert-Signature $path
  if ($Format -eq 'msi') {
    $log = Join-Path $env:TEMP "zichan-$label-msi.log"
    & msiexec.exe /i $path "INSTALLDIR=$InstallRoot" /qn /norestart /L*v $log
  } else {
    & $path /S "/D=$InstallRoot"
  }
  if ($LASTEXITCODE -ne 0) { throw "$label installation failed with exit code $LASTEXITCODE" }
}

function Assert-Installation([string]$version) {
  $exe = Join-Path $InstallRoot 'zichan.exe'
  $markerPath = Join-Path $InstallRoot 'installed-mode.json'
  $manifestPath = Join-Path $InstallRoot 'installed-files.json'
  foreach ($path in @($exe, $markerPath, $manifestPath, (Join-Path $InstallRoot 'server/node.exe'), (Join-Path $InstallRoot 'server/server.mjs'), (Join-Path $InstallRoot 'server/web/index.html'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Installed file missing: $path" }
  }
  if (Test-Path -LiteralPath (Join-Path $InstallRoot 'portable-mode.json')) { throw 'Portable marker leaked into installer' }
  if (Test-Path -LiteralPath (Join-Path $InstallRoot 'data')) { throw 'User data appeared in install directory' }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($marker.appVersion -ne $version -or $manifest.appVersion -ne $version) { throw 'Installed version mismatch' }
  $expected = @{}
  foreach ($file in $manifest.files) {
    $expected[$file.path.ToLowerInvariant()] = $true
    $path = Join-Path $InstallRoot ($file.path.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest file missing: $path" }
    $info = Get-Item -LiteralPath $path
    if ($info.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
      throw "Installed resource differs from manifest: $path"
    }
  }
  $server = Join-Path $InstallRoot 'server'
  foreach ($file in Get-ChildItem -LiteralPath $server -File -Recurse) {
    $relative = ('server/' + $file.FullName.Substring($server.Length + 1).Replace('\', '/')).ToLowerInvariant()
    if (-not $expected.ContainsKey($relative)) { throw "Unexpected installed resource: $relative" }
  }
  Assert-Signature $exe
  return $exe
}

function Start-And-Close([string]$exe) {
  $process = Start-Process -FilePath $exe -PassThru
  try {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $dataRoot 'runtime/app.lock'))) {
      if ($process.HasExited) { throw "Installed executable exited early: $($process.ExitCode)" }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'runtime/app.lock'))) { throw 'Installed app did not initialize user data' }
  } finally {
    if (-not $process.HasExited) {
      $null = $process.CloseMainWindow()
      if (-not $process.WaitForExit(10000)) { Stop-Process -Id $process.Id -Force }
    }
  }
}

$initialInstaller = if ($PreviousInstaller) { $PreviousInstaller } else { $CurrentInstaller }
$initialVersion = if ($PreviousVersion) { $PreviousVersion } else { $CurrentVersion }
Install-Package $initialInstaller 'initial'
$exe = Assert-Installation $initialVersion
if ($SkipLaunch) { New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null }
else { Start-And-Close $exe }
$sentinel = Join-Path $dataRoot 'installer-smoke-preserve.txt'
'keep user data across upgrade and uninstall' | Set-Content -LiteralPath $sentinel -Encoding UTF8
if ($PreviousInstaller) {
  Install-Package $CurrentInstaller 'upgrade'
  $exe = Assert-Installation $CurrentVersion
  if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Upgrade removed user data' }
  if (-not $SkipLaunch) { Start-And-Close $exe }
}
if ($Format -eq 'msi') {
  & msiexec.exe /x $CurrentInstaller /qn /norestart /L*v (Join-Path $env:TEMP 'zichan-uninstall-msi.log')
} else {
  $uninstaller = Get-ChildItem -LiteralPath $InstallRoot -File -Filter 'uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { throw 'NSIS uninstaller missing' }
  Assert-Signature $uninstaller.FullName
  & $uninstaller.FullName /S
}
if ($LASTEXITCODE -ne 0) { throw "Uninstall failed with exit code $LASTEXITCODE" }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'zichan.exe'))) { Start-Sleep -Milliseconds 500 }
if (Test-Path -LiteralPath (Join-Path $InstallRoot 'zichan.exe')) { throw 'Uninstall left the executable behind' }
if (-not (Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed user data' }
Write-Output "PASS $Format install, $(if ($PreviousInstaller) { 'upgrade, ' })uninstall, resource integrity, and user-data preservation"
