<#
  Free, temporary Safari remote access for a development/demo machine.
  Requires Bun and Cloudflare's cloudflared executable.  It deliberately keeps
  the tunnel and local relay alive only while this PowerShell window stays open.
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$LaunchDesktop,
  [switch]$ForceTryCloudflareIPv4
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cloudflaredPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflaredPath) {
  $installedPath = "${env:ProgramFiles(x86)}\\cloudflared\\cloudflared.exe"
  if (Test-Path $installedPath) { $cloudflaredPath = $installedPath }
}
if (-not $cloudflaredPath) {
  Write-Host "未找到 cloudflared。请先在管理员 PowerShell 执行：" -ForegroundColor Yellow
  Write-Host "  winget install --id Cloudflare.cloudflared --exact" -ForegroundColor Cyan
  Write-Host "安装后重新运行本脚本。Cloudflare Quick Tunnel 会创建临时 trycloudflare.com 地址。"
  exit 1
}

$bunShim = (Get-Command bun.cmd -ErrorAction SilentlyContinue).Source
$bunPath = if ($bunShim) { Join-Path (Split-Path -Parent $bunShim) "node_modules\\bun\\bin\\bun.exe" }
if (-not $bunPath -or -not (Test-Path $bunPath)) { $bunPath = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source }
if (-not $bunPath) { $bunPath = (Get-Command bun -ErrorAction SilentlyContinue).Source }
if (-not $bunPath) {
  throw "未找到 Bun，无法启动本地中继。"
}

Push-Location $root
$relay = $null
$tunnel = $null
$stdout = Join-Path $env:TEMP "jyycode-cloudflared-${PID}.out.log"
$stderr = Join-Path $env:TEMP "jyycode-cloudflared-${PID}.err.log"
$previousRelayUrl = [Environment]::GetEnvironmentVariable("JYYCODE_MOBILE_RELAY_URL", "User")
$relayConfigFile = Join-Path $env:LOCALAPPDATA "JYYCode\\mobile-relay-url.txt"
$relayUrl = $null
$hostsOverrideAdded = $false

try {
  if ($ForceTryCloudflareIPv4) {
    $apiIPv4 = (Resolve-DnsName api.trycloudflare.com -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1 -ExpandProperty IPAddress)
    if (-not $apiIPv4) { throw "未能解析 api.trycloudflare.com 的 IPv4 地址。" }
    $helper = Join-Path $PSScriptRoot "set-trycloudflare-api-hosts.ps1"
    Write-Host "需要确认一次管理员提示，以临时将 TryCloudflare API 固定到 IPv4。" -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper, "-Mode", "add", "-IPv4", $apiIPv4)
    $hostsOverrideAdded = $true
  }

  Write-Host "正在构建 Safari 网页…" -ForegroundColor Cyan
  & $bunPath run --cwd packages/mobile-web build
  if ($LASTEXITCODE -ne 0) { throw "Safari 网页构建失败。" }

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
  if (-not $healthy) { throw "本地中继未能在端口 $Port 启动。" }

  Write-Host "正在创建免费的临时 HTTPS/WSS 隧道…" -ForegroundColor Cyan
  # Some home networks advertise IPv6 but reset the TryCloudflare request and
  # block QUIC/UDP 7844. Use the IPv4 edge over TCP HTTP/2 instead.
  $tunnel = Start-Process -FilePath $cloudflaredPath -ArgumentList @("--edge-ip-version", "4", "--edge-bind-address", "0.0.0.0", "--protocol", "http2", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow

  $publicUrl = $null
  for ($attempt = 0; $attempt -lt 90 -and -not $tunnel.HasExited; $attempt++) {
    $text = ""
    foreach ($file in @($stdout, $stderr)) {
      if (Test-Path $file) { $text += Get-Content $file -Raw -ErrorAction SilentlyContinue }
    }
    $match = [regex]::Match($text, "https://[a-z0-9-]+\.trycloudflare\.com", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) { $publicUrl = $match.Value.TrimEnd('/'); break }
    Start-Sleep -Seconds 1
    $tunnel.Refresh()
  }
  if (-not $publicUrl) {
    $diagnostics = ""
    foreach ($file in @($stdout, $stderr)) {
      if (Test-Path $file) { $diagnostics += Get-Content $file -Raw -ErrorAction SilentlyContinue }
    }
    throw "Cloudflare 未返回临时地址。诊断信息：$diagnostics"
  }

  $relayUrl = $publicUrl -replace "^https://", "wss://"
  $relayUrl += "/connect"
  [Environment]::SetEnvironmentVariable("JYYCODE_MOBILE_RELAY_URL", $relayUrl, "User")
  New-Item -ItemType Directory -Path (Split-Path -Parent $relayConfigFile) -Force | Out-Null
  [System.IO.File]::WriteAllText($relayConfigFile, "$relayUrl`n", [System.Text.UTF8Encoding]::new($false))

  Write-Host "`n临时 Safari 地址：$publicUrl" -ForegroundColor Green
  Write-Host "桌面端中继地址已设为：$relayUrl" -ForegroundColor Green
  Write-Host "请完全退出后重新打开 JYYCode，再到“设置 → 移动网页版”展示二维码。" -ForegroundColor Yellow
  Write-Host "iPhone 用 Safari 打开上面的地址后扫描二维码。请勿分享二维码。" -ForegroundColor Yellow
  Write-Host "`n此窗口必须保持打开；关闭后临时地址会立即失效，下一次启动会生成新地址。" -ForegroundColor Yellow

  if ($LaunchDesktop) {
    $desktop = Join-Path $root ".build/desktop-safari/JYYCode.exe"
    if (Test-Path $desktop) { Start-Process -FilePath $desktop }
  }

  Wait-Process -Id $tunnel.Id
} finally {
  if ($relay -and -not $relay.HasExited) { Stop-Process -Id $relay.Id -Force -ErrorAction SilentlyContinue }
  if ($relayUrl -and (Test-Path $relayConfigFile)) {
    $storedRelayUrl = (Get-Content $relayConfigFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($storedRelayUrl -eq $relayUrl) { Remove-Item $relayConfigFile -Force -ErrorAction SilentlyContinue }
  }
  if ($hostsOverrideAdded) {
    $helper = Join-Path $PSScriptRoot "set-trycloudflare-api-hosts.ps1"
    Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper, "-Mode", "remove")
  }
  [Environment]::SetEnvironmentVariable("JYYCODE_MOBILE_RELAY_URL", $previousRelayUrl, "User")
  Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
  Pop-Location
}
