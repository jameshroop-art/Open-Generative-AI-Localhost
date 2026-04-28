@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: start_localhost_localfiles.bat
::
:: Full parallel install + launch for Open Generative AI on Windows in
:: LOCALHOST-ONLY / LOCAL-FILES-ONLY / auto_approve=NO_DENIAL mode.
::
:: ── What this script does (zero user prompts, fully automated) ────────────────
::
::  [CHECK]  Verify Python 3.8+ and Node.js 18+ are on PATH.
::
::  [PHASE A — PARALLEL]
::    A1  npm install --prefer-offline        (background, logs to logs\npm.log)
::    A2  python -m venv python\.venv         (foreground, fast)
::
::  [PHASE B — PARALLEL, starts after A1/A2 complete]
::    B1  npm run build:studio                (background, logs to logs\studio.log)
::    B2  pip install --no-index requirements (foreground, local wheels only)
::
::  [PHASE C — after B1 completes]
::    C1  npm run vite:build                  (foreground, builds dist/)
::
::  [LAUNCH — PARALLEL]
::    L1  Vite dev server on 127.0.0.1:5173  (new console window, localhost-only)
::    L2  Electron desktop app               (new console window, localhost-only)
::        └─ Electron auto-starts the Python sidecar on 127.0.0.1:7861
::
:: ── LOCALHOST-ONLY guarantees ─────────────────────────────────────────────────
::   • Vite dev server binds to 127.0.0.1 only (vite.config.mjs host:127.0.0.1)
::   • Python sidecar binds to 127.0.0.1 only (hard-coded in python/server.py)
::   • PIP_NO_INDEX=1 / WHEELS_NO_INDEX=1 prevent pip from reaching PyPI
::   • npm --prefer-offline uses the local npm cache first
::   • No external API key required; all inference uses the local sd.cpp binary
::     and the Python sidecar running on this machine
::
:: ── LOCAL-FILES-ONLY guarantees ───────────────────────────────────────────────
::   • pip uses WHEELS_DIR exclusively (--no-index --find-links)
::   • npm uses the local cache first (--prefer-offline)
::   • MODELS_ROOT, LORA_DIR, COGVIDEOX_DIR all point to on-disk paths
::   • Vite build output uses only relative paths (base: './')
::
:: ── Configurable env vars (set before running this script) ───────────────────
::   WHEELS_DIR      Local .whl directory.  Default: <repo-root>\wheels
::   MODELS_ROOT     Root of all local AI model files. Default: <repo-root>\models
::   LORA_DIR        LoRA .safetensors directory.  Default: <repo-root>\lora
::   COGVIDEOX_DIR   CogVideoX model sub-folder root. Default: MODELS_ROOT\CogVideoX
::   PYTHON_PORT     Python sidecar port. Default: 7861
::   VITE_PORT       Vite dev server port. Default: 5173
::
:: ── Usage ─────────────────────────────────────────────────────────────────────
::   start_localhost_localfiles.bat          (run from repo root or double-click)
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

:: ─── Resolve repo root (strip trailing backslash) ────────────────────────────
set REPO_ROOT=%~dp0
if "%REPO_ROOT:~-1%"=="\" set REPO_ROOT=%REPO_ROOT:~0,-1%

:: ─── Configurable paths — caller may pre-set any of these ────────────────────
if not defined WHEELS_DIR    set WHEELS_DIR=%REPO_ROOT%\wheels
if not defined MODELS_ROOT   set MODELS_ROOT=%REPO_ROOT%\models
if not defined LORA_DIR      set LORA_DIR=%REPO_ROOT%\lora
if not defined PYTHON_PORT   set PYTHON_PORT=7861
if not defined VITE_PORT     set VITE_PORT=5173
:: COGVIDEOX_DIR depends on MODELS_ROOT — must be set after it
if not defined COGVIDEOX_DIR set COGVIDEOX_DIR=%MODELS_ROOT%\CogVideoX

:: ─── Internal paths ───────────────────────────────────────────────────────────
set VENV_DIR=%REPO_ROOT%\python\.venv
set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe
set REQUIREMENTS=%REPO_ROOT%\python\requirements.txt
set PIP_INI=%REPO_ROOT%\python\pip.ini
set LOGS_DIR=%REPO_ROOT%\logs\setup

:: Signal files live in a unique temp sub-folder to avoid collisions
set SIG_DIR=%TEMP%\ogai_%RANDOM%_%RANDOM%

:: ─── Prepare directories ──────────────────────────────────────────────────────
mkdir "%LOGS_DIR%" >nul 2>&1
mkdir "%SIG_DIR%"  >nul 2>&1

:: ─── Banner ───────────────────────────────────────────────────────────────────
echo.
echo ================================================================
echo   Open Generative AI  ^|  localhost-only / local-files-only
echo   parallel setup  ^|  auto_approve=NO_DENIAL
echo ================================================================
echo.
echo  REPO_ROOT   : %REPO_ROOT%
echo  MODELS_ROOT : %MODELS_ROOT%
echo  WHEELS_DIR  : %WHEELS_DIR%
echo  LORA_DIR    : %LORA_DIR%
echo  COGVIDEOX   : %COGVIDEOX_DIR%
echo  PYTHON_PORT : %PYTHON_PORT%
echo  VITE_PORT   : %VITE_PORT%
echo  LOGS        : %LOGS_DIR%
echo.

:: ─── Prerequisite checks ─────────────────────────────────────────────────────
echo [check] Python...
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Python not found on PATH.
    echo  Install Python 3.8+ from https://www.python.org/downloads/ ^(tick "Add to PATH"^).
    call :cleanup
    exit /b 1
)
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo  Python %PY_VER%  OK

echo [check] Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Node.js not found on PATH.
    echo  Install Node.js 18+ from https://nodejs.org/
    call :cleanup
    exit /b 1
)
for /f %%v in ('node --version 2^>^&1') do set NODE_VER=%%v
echo  Node.js %NODE_VER%  OK

echo [check] WHEELS_DIR...
if not exist "%WHEELS_DIR%" (
    echo  ERROR: WHEELS_DIR not found: %WHEELS_DIR%
    echo  local-files-only mode requires a local wheel cache.
    echo  Create the directory and copy the required .whl files into it,
    echo  or set WHEELS_DIR to an existing wheel cache before running this script.
    call :cleanup
    exit /b 1
)
echo  %WHEELS_DIR%  OK
echo.

cd /d "%REPO_ROOT%"

:: ═══════════════════════════════════════════════════════════════════════════════
:: PHASE A — PARALLEL: npm install  +  python -m venv
:: ═══════════════════════════════════════════════════════════════════════════════
echo [Phase A] Starting npm install and venv creation in parallel...

:: Write a tiny helper script for the background npm install so we avoid
:: fragile nested quoting inside the `start /B cmd /c "..."` string.
set NPM_HELPER=%SIG_DIR%\run_npm_install.bat
(
    echo @echo off
    echo cd /d "%REPO_ROOT%"
    echo npm install --prefer-offline ^>"%LOGS_DIR%\npm_install.log" 2^>^&1
    echo if %%ERRORLEVEL%% neq 0 ^(echo FAIL ^>"%SIG_DIR%\npm_install.sig"^) else ^(echo OK ^>"%SIG_DIR%\npm_install.sig"^)
) > "%NPM_HELPER%"

:: A1 — npm install in background via helper script
start /B cmd /c "%NPM_HELPER%"

:: A2 — venv creation in foreground (typically ~5 s, much faster than npm install)
if not exist "%VENV_DIR%" (
    echo [A2] Creating Python venv...
    python -m venv "%VENV_DIR%"
    if !ERRORLEVEL! neq 0 (
        echo  ERROR: Failed to create Python venv.
        call :wait_and_fail
    )
    echo [A2] Venv created.
) else (
    echo [A2] Venv already exists — skipping creation.
)

:: Wait for A1 (npm install) to finish
echo [A1] Waiting for npm install to complete...
:wait_A1
if not exist "%SIG_DIR%\npm_install.sig" (
    timeout /t 3 /nobreak >nul
    goto wait_A1
)
findstr /c:"FAIL" "%SIG_DIR%\npm_install.sig" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo  ERROR: npm install failed. See %LOGS_DIR%\npm_install.log
    type "%LOGS_DIR%\npm_install.log"
    call :cleanup
    exit /b 1
)
echo [A1] npm install  OK
echo.

:: ═══════════════════════════════════════════════════════════════════════════════
:: PHASE B — PARALLEL: build:studio  +  pip install
:: ═══════════════════════════════════════════════════════════════════════════════
echo [Phase B] Starting build:studio and pip install in parallel...

:: Write a helper script for the background build:studio
set STUDIO_HELPER=%SIG_DIR%\run_build_studio.bat
(
    echo @echo off
    echo cd /d "%REPO_ROOT%"
    echo npm run build:studio ^>"%LOGS_DIR%\build_studio.log" 2^>^&1
    echo if %%ERRORLEVEL%% neq 0 ^(echo FAIL ^>"%SIG_DIR%\build_studio.sig"^) else ^(echo OK ^>"%SIG_DIR%\build_studio.sig"^)
) > "%STUDIO_HELPER%"

:: B1 — build:studio in background via helper script
start /B cmd /c "%STUDIO_HELPER%"

:: B2 — pip install in foreground (depends on venv from A2)
echo [B2] Installing python\requirements.txt from local wheels...
set PIP_CONFIG_FILE=%PIP_INI%
set PIP_NO_INDEX=1
set WHEELS_NO_INDEX=1
"%VENV_PYTHON%" -m pip install ^
    --no-index ^
    --find-links "%WHEELS_DIR%" ^
    -r "%REQUIREMENTS%"
if %ERRORLEVEL% neq 0 (
    echo  ERROR: pip install failed.
    echo  Ensure all required .whl files are present in: %WHEELS_DIR%
    call :wait_and_fail
)
echo [B2] pip install  OK

:: Wait for B1 (build:studio) to finish
echo [B1] Waiting for build:studio to complete...
:wait_B1
if not exist "%SIG_DIR%\build_studio.sig" (
    timeout /t 3 /nobreak >nul
    goto wait_B1
)
findstr /c:"FAIL" "%SIG_DIR%\build_studio.sig" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo  ERROR: build:studio failed. See %LOGS_DIR%\build_studio.log
    type "%LOGS_DIR%\build_studio.log"
    call :cleanup
    exit /b 1
)
echo [B1] build:studio  OK
echo.

:: ═══════════════════════════════════════════════════════════════════════════════
:: PHASE C — Vite build (sequential; depends on B1)
:: ═══════════════════════════════════════════════════════════════════════════════
echo [Phase C] Building Vite frontend bundle (localhost-only, local-files-only)...
call npm run vite:build
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Vite build failed.
    call :cleanup
    exit /b %ERRORLEVEL%
)
echo [Phase C] Vite build  OK
echo.

:: ─── Ensure model + LoRA directories exist ───────────────────────────────────
if not exist "%MODELS_ROOT%"   mkdir "%MODELS_ROOT%"
if not exist "%LORA_DIR%"      mkdir "%LORA_DIR%"
if not exist "%COGVIDEOX_DIR%" mkdir "%COGVIDEOX_DIR%"

:: ─── Export all runtime env vars ─────────────────────────────────────────────
:: Read by:  electron/lib/pythonServer.js   — WHEELS_NO_INDEX, WHEELS_DIR,
::                                            PIP_NO_INDEX, PIP_CONFIG_FILE,
::                                            PYTHON_SERVER_PORT
::           electron/lib/localInference.js — MODELS_DIR, LORA_DIR
::           python/server.py               — MODELS_ROOT, COGVIDEOX_DIR,
::                                            PYTHON_SERVER_PORT
::           app/api/cogvideox/route.js     — COGVIDEOX_DIR (Next.js dev only)
::           app/api/loras/route.js         — LORA_DIR     (Next.js dev only)

set MODELS_DIR=%MODELS_ROOT%
set ESRGAN_MODELS_DIR=%MODELS_ROOT%\esrgan_models
set GFPGAN_WEIGHTS_DIR=%MODELS_ROOT%\gfpgan
set INSIGHTFACE_MODELS_DIR=%MODELS_ROOT%\extensions\insightface\models
set COGVIDEOX_MODEL_PATH=%COGVIDEOX_DIR%\CogVideoX-5b
set PYTHON_SERVER_PORT=%PYTHON_PORT%
set PIP_CONFIG_FILE=%PIP_INI%
set PIP_NO_INDEX=1
set WHEELS_NO_INDEX=1

:: ═══════════════════════════════════════════════════════════════════════════════
:: LAUNCH — PARALLEL: Vite dev server  +  Electron
:: Both windows inherit all env vars set above.
:: Helper scripts are written to SIG_DIR so all paths with spaces are safe.
:: ═══════════════════════════════════════════════════════════════════════════════
echo ================================================================
echo   Launching in parallel — localhost-only / local-files-only
echo ================================================================
echo.
echo   L1  Vite dev server  ->  http://127.0.0.1:%VITE_PORT%
echo   L2  Electron desktop app (loads dist\index.html)
echo       Python sidecar auto-starts on 127.0.0.1:%PYTHON_PORT%
echo.

:: Write launch helper scripts so we never have to nest quotes inside `start`.

set VITE_LAUNCHER=%SIG_DIR%\launch_vite.bat
(
    echo @echo off
    echo title Vite Dev Server [localhost:%VITE_PORT%]
    echo cd /d "%REPO_ROOT%"
    echo npx vite --host 127.0.0.1 --port %VITE_PORT% --strictPort
) > "%VITE_LAUNCHER%"

set ELECTRON_LAUNCHER=%SIG_DIR%\launch_electron.bat
(
    echo @echo off
    echo title Open Generative AI ^| Electron
    echo cd /d "%REPO_ROOT%"
    echo npx electron .
) > "%ELECTRON_LAUNCHER%"

:: L1 — Vite dev server in its own console window (localhost-only)
::      CLI flags enforce 127.0.0.1 binding regardless of vite.config.mjs overrides.
start "Vite Dev [localhost:%VITE_PORT%]" cmd /k "%VITE_LAUNCHER%"

:: L2 — Electron in its own console window (auto-starts Python sidecar)
start "Electron [localhost-only]" cmd /k "%ELECTRON_LAUNCHER%"

echo  Both services launched in separate windows.
echo  Close those windows (or press Ctrl+C inside them) to stop the app.
echo.

call :cleanup
endlocal
exit /b 0

:: ─── Subroutines ─────────────────────────────────────────────────────────────

:cleanup
:: Remove the per-run signal directory (ignore errors)
if defined SIG_DIR if exist "%SIG_DIR%" rmdir /s /q "%SIG_DIR%" >nul 2>&1
exit /b 0

:wait_and_fail
:: Wait for any still-running background job signal files to appear (best effort),
:: then clean up and exit with an error.
echo  Waiting briefly for background jobs before exit...
timeout /t 5 /nobreak >nul
call :cleanup
exit /b 1

