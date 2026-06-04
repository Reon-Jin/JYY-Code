@echo off
chcp 65001 >nul
title JYY Code

:: JYY Code TUI Launcher
:: Double-click this file to start the TUI

cd /d "%~dp0"

:: Check if bun is installed
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] bun is not installed. Please install bun first: https://bun.sh
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    bun install
    if %errorlevel% neq 0 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)

echo [JYY Code] Starting TUI...
echo.

bun run dev

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] TUI exited with an error.
    pause
)
