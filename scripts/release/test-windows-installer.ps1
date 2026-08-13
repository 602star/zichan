# Install, launch, and uninstall a Windows MSI in release CI.
param(
  [Parameter(Mandatory = $true)]
  [string] $MsiPath,
  [string] $DisplayName = '资产生命周期',
  [string] $ExecutableName = 'zichan.exe'
)

$ErrorActionPreference = 'Stop'
$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
$installLog = Join-Path $env:TEMP 'zichan-msi-install.log'
$uninstallLog = Join-Path $env:TEMP 'zichan-msi-uninstall.log'

function Invoke-Msi {
  param([string[]] $Arguments)
  $process = Start-Process msiexec.exe -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -notin 0, 3010) {
    throw "msiexec failed with exit code $($process.ExitCode)."
  }
}

function Find-InstalledApplication {
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $registryRoots) {
    $entry = Get-ItemProperty $root -ErrorAction SilentlyContinue |
      Where-Object DisplayName -EQ $DisplayName |
      Select-Object -First 1
    if ($entry) { return $entry }
  }
  return $null
}

$installed = $false
$application = $null
$launched = $null
try {
  Invoke-Msi @('/i', $resolvedMsi, '/qn', '/norestart', '/l*v', $installLog)
  $installed = $true
  $application = Find-InstalledApplication
  if (-not $application) {
    throw "Installed application '$DisplayName' was not found in the uninstall registry."
  }

  $candidates = @()
  if ($application.InstallLocation) {
    $candidates += Join-Path $application.InstallLocation $ExecutableName
  }
  if ($application.DisplayIcon) {
    $displayIcon = ($application.DisplayIcon -replace ',\d+$', '').Trim('"')
    if ([IO.Path]::GetFileName($displayIcon) -ine $ExecutableName) {
      throw "Installed application DisplayIcon does not point to '$ExecutableName': $displayIcon"
    }
    $candidates += $displayIcon
  }
  $executable = $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
  if (-not $executable) {
    throw "Installed executable '$ExecutableName' was not found."
  }
  $executable = (Resolve-Path -LiteralPath $executable).Path
  if ([IO.Path]::GetFileName($executable) -ine $ExecutableName) {
    throw "Installed executable is not '$ExecutableName': $executable"
  }

  $launched = Start-Process -FilePath $executable -PassThru
  Start-Sleep -Seconds 8
  if ($launched.HasExited) {
    throw "Installed application exited during the startup smoke test with code $($launched.ExitCode)."
  }
} finally {
  if ($launched -and -not $launched.HasExited) {
    Stop-Process -Id $launched.Id -Force -ErrorAction SilentlyContinue
  }
  if ($installed) {
    Invoke-Msi @('/x', $resolvedMsi, '/qn', '/norestart', '/l*v', $uninstallLog)
  }
}

if (Find-InstalledApplication) {
  throw "Application '$DisplayName' remains registered after uninstall."
}
