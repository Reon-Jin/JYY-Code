[CmdletBinding()]
param(
  [string]$ReleaseRoot
)

$ErrorActionPreference = "Stop"
if (-not $ReleaseRoot) {
  $ReleaseRoot = Join-Path $PSScriptRoot "../src-tauri/target/x86_64-pc-windows-msvc/release"
}
$release = (Resolve-Path -LiteralPath $ReleaseRoot).Path
$rawExe = Join-Path $release "jyycode-desktop.exe"
$rawSidecar = Join-Path $release "jyycode-sidecar.exe"
$msiFiles = @(Get-ChildItem -LiteralPath (Join-Path $release "bundle/msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue)
$nsisFiles = @(Get-ChildItem -LiteralPath (Join-Path $release "bundle/nsis") -Filter "*.exe" -File -ErrorAction SilentlyContinue)

function Assert-OneArtifact([System.IO.FileInfo[]]$Files, [string]$Label) {
  if ($Files.Count -ne 1) {
    throw "Expected exactly one $Label artifact, found $($Files.Count)."
  }
  if ($Files[0].Length -le 0) {
    throw "$Label artifact is empty: $($Files[0].FullName)"
  }
  return $Files[0]
}

if (-not (Test-Path -LiteralPath $rawExe -PathType Leaf)) {
  throw "Raw desktop executable does not exist: $rawExe"
}
$raw = Get-Item -LiteralPath $rawExe
if ($raw.Length -le 0) { throw "Raw desktop executable is empty: $rawExe" }
if (-not (Test-Path -LiteralPath $rawSidecar -PathType Leaf)) {
  throw "Raw desktop sidecar does not exist: $rawSidecar"
}
$sidecar = Get-Item -LiteralPath $rawSidecar
if ($sidecar.Length -le 0) { throw "Raw desktop sidecar is empty: $rawSidecar" }
$msi = Assert-OneArtifact $msiFiles "MSI"
$nsis = Assert-OneArtifact $nsisFiles "NSIS"

$artifactRoot = Join-Path $release "desktop-artifacts"
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
Get-ChildItem -LiteralPath $artifactRoot -File | Remove-Item -Force
$portable = Join-Path $artifactRoot "JYYCode-portable-x64.exe"
$portableSidecar = Join-Path $artifactRoot $sidecar.Name
Copy-Item -LiteralPath $raw.FullName -Destination $portable -Force
Copy-Item -LiteralPath $sidecar.FullName -Destination $portableSidecar -Force
Copy-Item -LiteralPath $msi.FullName -Destination (Join-Path $artifactRoot $msi.Name) -Force
Copy-Item -LiteralPath $nsis.FullName -Destination (Join-Path $artifactRoot $nsis.Name) -Force
$packaged = @(Get-ChildItem -LiteralPath $artifactRoot -File | Where-Object Name -ne "SHA256SUMS.txt")
$checksumPath = Join-Path $artifactRoot "SHA256SUMS.txt"
$checksums = $packaged | Sort-Object Name | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash *$($_.Name)"
}
Set-Content -LiteralPath $checksumPath -Value $checksums -Encoding ascii

$desktop = $null
$ownedSidecarIds = @()
try {
  $desktop = Start-Process -FilePath $raw.FullName -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($desktop.Id)" |
      Where-Object { $_.Name -ieq "jyycode-sidecar.exe" })
    if ($children.Count -gt 1) {
      $ownedSidecarIds = @($children.ProcessId)
      throw "Desktop process $($desktop.Id) started more than one sidecar: $($ownedSidecarIds -join ', ')."
    }
    if ($children.Count -eq 1) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline -and -not $desktop.HasExited)

  if ($children.Count -ne 1) {
    throw "Desktop process $($desktop.Id) did not start exactly one sidecar within 20 seconds."
  }
  $ownedSidecarIds = @($children[0].ProcessId)

  if (-not $desktop.CloseMainWindow()) {
    Stop-Process -Id $desktop.Id
  }
  if (-not $desktop.WaitForExit(5000)) {
    Stop-Process -Id $desktop.Id
    $desktop.WaitForExit(5000) | Out-Null
  }

  $sidecarDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $remaining = @($ownedSidecarIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $sidecarDeadline)
  if ($remaining.Count -ne 0) {
    throw "Owned sidecar remained after desktop exit: $($remaining -join ', ')."
  }
}
finally {
  if ($desktop -and -not $desktop.HasExited) {
    Stop-Process -Id $desktop.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($processId in $ownedSidecarIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Windows desktop smoke test passed."
foreach ($artifact in @($raw, $msi, $nsis) + @(Get-Item -LiteralPath $portable, $portableSidecar, $checksumPath)) {
  Write-Host ("{0} ({1} bytes)" -f $artifact.FullName, $artifact.Length)
}
