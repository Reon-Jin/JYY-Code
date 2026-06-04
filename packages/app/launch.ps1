$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  JYYCode Desktop App" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check bun
if (-not (Get-Command "bun" -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] bun is not installed. Install from https://bun.sh" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Install deps if needed
if (-not (Test-Path "node_modules\solid-js")) {
    Write-Host "[1/3] Installing dependencies..." -ForegroundColor Yellow
    bun install
    if ($LASTEXITCODE -ne 0) { throw "Install failed" }
} else {
    Write-Host "[1/3] Dependencies already installed." -ForegroundColor Green
}

# Compile Electron TS
Write-Host "[2/3] Compiling Electron main process..." -ForegroundColor Yellow
bun run build:electron-ts
if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed" }
Write-Host "       Compiled to dist/main/" -ForegroundColor Green

# Start Vite dev server
Write-Host "[3/3] Starting JYYCode App..." -ForegroundColor Yellow
$viteJob = Start-Job -Name "JYYCode-Vite" -ScriptBlock {
    Set-Location $using:PSScriptRoot
    bun run dev 2>&1 | Out-Null
}

# Wait for Vite
Write-Host "       Waiting for dev server..." -ForegroundColor Gray
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 1 -UseBasicParsing
        $ready = $true
        break
    } catch { Start-Sleep 1 }
}

if (-not $ready) {
    Write-Host "[ERROR] Vite dev server failed to start" -ForegroundColor Red
    Stop-Job -Name "JYYCode-Vite" -ErrorAction SilentlyContinue
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "       Dev server ready on http://localhost:5173" -ForegroundColor Green
Write-Host ""

# Launch Electron
$env:NODE_ENV = "development"
bun x electron .

# Cleanup
Stop-Job -Name "JYYCode-Vite" -ErrorAction SilentlyContinue
Remove-Job -Name "JYYCode-Vite" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "JYYCode App closed." -ForegroundColor Gray
