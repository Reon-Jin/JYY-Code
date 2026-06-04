# JYY Code TUI Launcher
# Right-click "Run with PowerShell", or run: .\start.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Check if bun is installed
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] bun is not installed. Install from: https://bun.sh" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Installing dependencies..." -ForegroundColor Cyan
    bun install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Install failed." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

Write-Host "[JYY Code] Starting TUI..." -ForegroundColor Green
Write-Host ""

bun run dev

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] TUI exited with an error." -ForegroundColor Red
    Read-Host "Press Enter to exit"
}
