@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   JYYCode Desktop App
echo ==========================================
echo.

:: ---- Check bun ----
where bun >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] bun is required. Install from https://bun.sh
    pause
    exit /b 1
)

:: ---- Install dependencies ----
if not exist "node_modules\solid-js" (
    echo [1/4] Installing dependencies...
    call bun install
    if %ERRORLEVEL% neq 0 ( pause & exit /b 1 )
) else (
    echo [1/4] Dependencies ready.
)

:: ---- Compile Electron TypeScript ----
echo [2/4] Compiling Electron...
call bun run build:electron-ts
if %ERRORLEVEL% neq 0 ( pause & exit /b 1 )

:: ---- Verify Electron binary ----
echo [3/4] Checking Electron binary...

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
    echo [WARN] Electron binary not found. Downloading via mirror...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    node node_modules\electron\install.js
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to download Electron binary.
        echo.
        echo   Try manually:
        echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo     node node_modules\electron\install.js
        echo.
        pause
        exit /b 1
    )
    if not exist "%ELECTRON_EXE%" (
        echo [ERROR] Download completed but binary still missing at %ELECTRON_EXE%.
        pause
        exit /b 1
    )
)

:: Pre-flight check: verify binary actually works
"%ELECTRON_EXE%" --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Electron binary exists but fails to execute.
    echo   Path: %ELECTRON_EXE%
    echo   This may be a corrupted download. Try removing and reinstalling:
    echo     rmdir /s /q node_modules\electron
    echo     bun install
    echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    echo     node node_modules\electron\install.js
    pause
    exit /b 1
)
echo   Electron binary OK.

:: ---- Start Vite dev server ----
echo [4/4] Launching...
start "JYYCode-Vite" /min cmd /c "bun run dev"

:: ---- Wait for Vite dev server ----
echo Waiting for Vite dev server at http://localhost:5173 ...
:wait_loop
powershell -Command "try { $null = Invoke-WebRequest http://localhost:5173 -TimeoutSec 1 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    timeout /t 2 /nobreak >nul
    goto wait_loop
)

echo Vite server ready. Starting Electron...

:: ---- Launch Electron (direct binary, all output visible) ----
set NODE_ENV=development
"%ELECTRON_EXE%" . 2>&1

echo.
echo App exited.
endlocal
