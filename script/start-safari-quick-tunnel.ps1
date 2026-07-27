<#
  Starts the local Safari relay while cpolar supplies the public HTTPS/WSS
  endpoint. cpolar is installed as a Windows service and owns the stable
  public endpoint; this script owns only the local Bun relay for the lifetime
  of the JYYCode desktop process.
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$LaunchDesktop,
  [switch]$ForceTryCloudflareIPv4,
  [int]$DesktopPid,
  [string]$StopFile
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cpolarPath = "${env:ProgramFiles}\cpolar\cpolar.exe"
if (-not (Test-Path $cpolarPath)) { throw "cpolar is not installed or configured." }

$bunShim = (Get-Command bun.cmd -ErrorAction SilentlyContinue).Source
$fallbackBunShim = Join-Path $env:APPDATA "npm\bun.cmd"
if (-not $bunShim -and (Test-Path $fallbackBunShim)) { $bunShim = $fallbackBunShim }
$bunPath = if ($bunShim) { Join-Path (Split-Path -Parent $bunShim) "node_modules\bun\bin\bun.exe" }
if (-not $bunPath -or -not (Test-Path $bunPath)) { $bunPath = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source }
if (-not $bunPath) { throw "Bun is not available for the local relay." }

function Get-CpolarPublicUrl {
  $logDirectory = Join-Path $env:USERPROFILE ".cpolar\logs"
  $logs = Get-ChildItem $logDirectory -Filter "*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 3
  foreach ($log in $logs) {
    $text = Get-Content $log.FullName -Raw -ErrorAction SilentlyContinue
    $matches = [regex]::Matches($text, 'PublicUrl\\?":\\?"(https://[^"\\\s]+)')
    if ($matches.Count -gt 0) { return $matches[$matches.Count - 1].Groups[1].Value.TrimEnd('/') }
    $matches = [regex]::Matches($text, 'Tunnel established at (https://\S+)')
    if ($matches.Count -gt 0) { return $matches[$matches.Count - 1].Groups[1].Value.TrimEnd('/') }
  }
  return $null
}

Push-Location $root
$relay = $null
$relayConfigFile = Join-Path $env:LOCALAPPDATA "JYYCode\mobile-relay-url.txt"
$relayUrl = $null
if ($StopFile) { Remove-Item $StopFile -Force -ErrorAction SilentlyContinue }

try {
  $service = Get-Service -Name cpolar -ErrorAction Stop
  if ($service.Status -ne "Running") { throw "The cpolar Windows service is not running." }

  & $bunPath run --cwd packages/mobile-web build
  if ($LASTEXITCODE -ne 0) { throw "Safari web build failed." }

  $env:HOSTNAME = "127.0.0.1"
  $env:PORT = "$Port"
  $env:JYYCODE_MOBILE_WEB_ROOT = Join-Path $root "packages/mobile-web/dist"
  $relay = Start-Process -FilePath $bunPath -ArgumentList @("packages/relay/src/main.ts") -WorkingDirectory $root -PassThru -NoNewWindow

  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
      if ($health.ok) { $healthy = $true; break }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $healthy) { throw "The local relay did not start on the configured port." }

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $publicUrl = Get-CpolarPublicUrl
    if ($publicUrl) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $publicUrl) { throw "cpolar did not report an HTTPS endpoint." }

  $relayUrl = ($publicUrl -replace "^https://", "wss://") + "/connect"
  New-Item -ItemType Directory -Path (Split-Path -Parent $relayConfigFile) -Force | Out-Null
  [System.IO.File]::WriteAllText($relayConfigFile, "$relayUrl`n", [System.Text.UTF8Encoding]::new($false))

  while ($true) {
    if ($StopFile -and (Test-Path $StopFile)) { break }
    if ($DesktopPid -gt 0 -and -not (Get-Process -Id $DesktopPid -ErrorAction SilentlyContinue)) { break }
    # cpolar can reconnect to a new temporary address independently of the
    # local relay. Keep the desktop page and the next WebSocket reconnect on
    # the authoritative address without requiring a JYYCode restart.
    $updatedPublicUrl = Get-CpolarPublicUrl
    if ($updatedPublicUrl -and $updatedPublicUrl -ne $publicUrl) {
      $publicUrl = $updatedPublicUrl
      $relayUrl = ($publicUrl -replace "^https://", "wss://") + "/connect"
      [System.IO.File]::WriteAllText($relayConfigFile, "$relayUrl`n", [System.Text.UTF8Encoding]::new($false))
    }
    Start-Sleep -Seconds 10
  }
} finally {
  if ($relay -and -not $relay.HasExited) { Stop-Process -Id $relay.Id -Force -ErrorAction SilentlyContinue }
  if ($relayUrl -and (Test-Path $relayConfigFile)) {
    $storedRelayUrl = (Get-Content $relayConfigFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($storedRelayUrl -eq $relayUrl) { Remove-Item $relayConfigFile -Force -ErrorAction SilentlyContinue }
  }
  if ($StopFile) { Remove-Item $StopFile -Force -ErrorAction SilentlyContinue }
  Pop-Location
}
