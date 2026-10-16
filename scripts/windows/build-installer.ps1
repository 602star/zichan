param([switch]$RequireSignature, [switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repository
$version = (Get-Content .node-version -Raw).Trim()
$actualNode = (& node.exe -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0 -or $actualNode -ne $version) {
  throw "Installer build requires Node.js $version; found $actualNode"
}
if ((& node.exe -p 'process.arch').Trim() -ne 'x64') { throw 'Installer build requires x64 Node.js' }
foreach ($tool in @('cargo.exe', 'rustc.exe', 'perl.exe')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build tool: $tool" }
}
$signingConfig = Join-Path $repository 'apps\desktop\src-tauri\tauri.installer.signing.generated.json'
$thumbprint = [string]$env:ZICHAN_SIGNING_THUMBPRINT
$thumbprint = $thumbprint.Replace(' ', '').ToUpperInvariant()
if ($RequireSignature -and $thumbprint -notmatch '^[0-9A-F]{40}$') {
  throw 'A 40-character ZICHAN_SIGNING_THUMBPRINT is required for signed release builds'
}
$verifySignature = $RequireSignature -or [bool]$thumbprint
$installerConfig = 'src-tauri/tauri.installer.conf.json'
if ($thumbprint) {
  if ($thumbprint -notmatch '^[0-9A-F]{40}$') { throw 'Invalid ZICHAN_SIGNING_THUMBPRINT' }
  $certificate = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object Thumbprint -EQ $thumbprint | Select-Object -First 1
  if (-not $certificate -or -not $certificate.HasPrivateKey) { throw 'Signing certificate with private key is unavailable' }
  $timestampUrl = $env:ZICHAN_TIMESTAMP_URL
  if (-not $timestampUrl -or -not $timestampUrl.StartsWith('https://')) { throw 'ZICHAN_TIMESTAMP_URL must be an HTTPS timestamp service' }
  $config = Get-Content 'apps/desktop/src-tauri/tauri.installer.conf.json' -Raw | ConvertFrom-Json
  $config.bundle.windows | Add-Member -NotePropertyName certificateThumbprint -NotePropertyValue $thumbprint
  $config.bundle.windows | Add-Member -NotePropertyName digestAlgorithm -NotePropertyValue 'sha256'
  $config.bundle.windows | Add-Member -NotePropertyName timestampUrl -NotePropertyValue $timestampUrl
  $config.bundle.windows | Add-Member -NotePropertyName tsp -NotePropertyValue $true
  [IO.File]::WriteAllText($signingConfig, ($config | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  $installerConfig = 'src-tauri/tauri.installer.signing.generated.json'
}
try {
  if (-not $VerifyOnly) {
    foreach ($command in @('release:check', 'test:release', 'test:scripts', 'build:server', 'typecheck', 'test')) {
      & npm.cmd run $command
      if ($LASTEXITCODE -ne 0) { throw "npm run $command failed" }
    }
    $env:ZICHAN_BUILD_PREPARED = '1'
    $env:ZICHAN_RELEASE_BUILD = '1'
    $buildStarted = Get-Date
    & npm.cmd run build --workspace '@zichan/desktop' -- --config $installerConfig --bundles msi nsis --ci -- --locked
    if ($LASTEXITCODE -ne 0) { throw 'Tauri installer build failed' }
  }
  $msi = @(Get-ChildItem 'apps/desktop/src-tauri/target/release/bundle/msi' -Filter '*.msi' -File)
  $nsis = @(Get-ChildItem 'apps/desktop/src-tauri/target/release/bundle/nsis' -Filter '*-setup.exe' -File)
  if ($msi.Count -ne 1 -or $nsis.Count -ne 1) { throw 'Expected exactly one MSI and one NSIS installer' }
  if (-not $VerifyOnly -and ($msi[0].LastWriteTime -lt $buildStarted.AddSeconds(-2) -or $nsis[0].LastWriteTime -lt $buildStarted.AddSeconds(-2))) {
    throw 'Installer outputs were not refreshed by this build'
  }
  $manifest = Get-Content 'apps/desktop/src-tauri/installer/installed-files.json' -Raw | ConvertFrom-Json
  if ($manifest.nodeVersion -ne $version -or $manifest.appVersion -ne (Get-Content 'package.json' -Raw | ConvertFrom-Json).version) {
    throw 'Installed resource manifest version mismatch'
  }
  $expected = @('server/node.exe', 'server/node-LICENSE.txt', 'server/server.mjs', 'server/web/index.html')
  foreach ($path in $expected) {
    if ($path -notin @($manifest.files | ForEach-Object path)) { throw "Missing installed resource: $path" }
  }
  $sourceRoot = Join-Path $repository 'apps\desktop\resources'
  $actualFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File)
  if ($actualFiles.Count -ne $manifest.files.Count) { throw 'Resource manifest does not cover the complete server tree' }
  foreach ($row in $manifest.files) {
    if (-not $row.path.StartsWith('server/')) { throw "Resource outside server/: $($row.path)" }
    $source = Join-Path $sourceRoot $row.path.Substring(7).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source resource: $source" }
    $info = Get-Item -LiteralPath $source
    if ($info.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $row.sha256) {
      throw "Source resource hash mismatch: $source"
    }
  }
  $wix = Get-Content 'apps/desktop/src-tauri/target/release/wix/x64/main.wxs' -Raw
  $nsisScript = Get-Content 'apps/desktop/src-tauri/target/release/nsis/x64/installer.nsi' -Raw
  foreach ($required in @('installed-mode.json', 'installed-files.json', 'server.mjs', '687bf6a9-bf19-505b-81cc-864ac03395d5')) {
    if (-not $wix.Contains($required)) { throw "MSI payload or upgrade contract missing: $required" }
  }
  $wixXml = [xml]$wix
  $webviewBinary = $wixXml.SelectSingleNode("//*[local-name()='Binary' and @Id='MicrosoftEdgeWebView2RuntimeInstaller.exe']")
  if (-not $webviewBinary) { throw 'MSI does not embed the offline WebView2 installer' }
  $webviewSignature = Get-AuthenticodeSignature -LiteralPath $webviewBinary.SourceFile
  if ($webviewSignature.Status -ne 'Valid' -or $webviewSignature.SignerCertificate.Subject -notlike '*Microsoft Corporation*') {
    throw 'Offline WebView2 installer lacks a valid Microsoft signature'
  }
  foreach ($required in @('installed-mode.json', 'installed-files.json', 'server\server.mjs', 'installer\upgrade.nsh')) {
    if (-not $nsisScript.Contains($required)) { throw "NSIS payload or upgrade cleanup missing: $required" }
  }
  $hook = Get-Content 'apps/desktop/src-tauri/installer/upgrade.nsh' -Raw
  if (-not $hook.Contains('RMDir /r "$INSTDIR\server"')) { throw 'NSIS upgrade hook does not remove stale server resources' }
  foreach ($artifact in @($msi[0], $nsis[0])) {
    $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$($artifact.FullName).sha256", "$hash  $($artifact.Name)`n", [Text.UTF8Encoding]::new($false))
    if ($verifySignature) {
      $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint -or -not $signature.TimeStamperCertificate) {
        throw "Installer signature or timestamp invalid: $($artifact.FullName)"
      }
    }
    Write-Output "Verified installer: $($artifact.FullName) SHA256=$hash"
  }
  $exe = 'apps/desktop/src-tauri/target/release/zichan.exe'
  if ($verifySignature) {
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumbprint -or -not $signature.TimeStamperCertificate) {
      throw 'Desktop executable signature or timestamp invalid'
    }
  }
} finally {
  Remove-Item -LiteralPath $signingConfig -Force -ErrorAction SilentlyContinue
  Remove-Item Env:ZICHAN_BUILD_PREPARED -ErrorAction SilentlyContinue
  Remove-Item Env:ZICHAN_RELEASE_BUILD -ErrorAction SilentlyContinue
}
