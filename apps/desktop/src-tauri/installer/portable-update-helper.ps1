param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$Current,
  [Parameter(Mandatory=$true)][string]$Stage,
  [Parameter(Mandatory=$true)][string]$Backup
)
$ErrorActionPreference = 'Stop'
try {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw '旧程序未在 60 秒内退出' }
  if (Test-Path -LiteralPath $Backup) { throw '历史版本目录已存在' }
  if (-not (Test-Path -LiteralPath (Join-Path $Current 'data'))) { throw '便携数据目录缺失' }
  Move-Item -LiteralPath $Current -Destination $Backup
  try {
    Move-Item -LiteralPath $Stage -Destination $Current
    Move-Item -LiteralPath (Join-Path $Backup 'data') -Destination (Join-Path $Current 'data')
    $next = Start-Process -FilePath (Join-Path $Current 'zichan.exe') -PassThru
    Start-Sleep -Seconds 20
    if ($next.HasExited) { throw "新程序提前退出：$($next.ExitCode)" }
  } catch {
    $failed = "$Backup.failed"
    if (Test-Path -LiteralPath (Join-Path $Current 'data')) {
      Move-Item -LiteralPath (Join-Path $Current 'data') -Destination (Join-Path $Backup 'data')
    }
    if (Test-Path -LiteralPath $Current) { Move-Item -LiteralPath $Current -Destination $failed }
    Move-Item -LiteralPath $Backup -Destination $Current
    Start-Process -FilePath (Join-Path $Current 'zichan.exe') | Out-Null
    throw
  }
} catch {
  [IO.File]::WriteAllText("$Backup.update-error.txt", [string]$_, [Text.UTF8Encoding]::new($false))
}
