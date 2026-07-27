# Requires elevation. Adds or removes only the marked, temporary JYYCode
# mapping used to force the TryCloudflare provisioning request over IPv4.
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("add", "remove")]
  [string]$Mode,
  [string]$IPv4
)

$ErrorActionPreference = "Stop"
$hostsPath = Join-Path $env:SystemRoot "System32\\drivers\\etc\\hosts"
$marker = "# JYYCode temporary TryCloudflare IPv4"
$existing = if (Test-Path $hostsPath) { Get-Content $hostsPath -Encoding ascii } else { @() }
$clean = @($existing | Where-Object { $_ -notmatch "JYYCode temporary TryCloudflare IPv4" })

if ($Mode -eq "add") {
  if (-not $IPv4 -or $IPv4 -notmatch "^(?:\d{1,3}\.){3}\d{1,3}$") { throw "需要有效的 IPv4 地址。" }
  $clean += "$IPv4 api.trycloudflare.com $marker"
}

[System.IO.File]::WriteAllText($hostsPath, (($clean -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.Encoding]::ASCII)
