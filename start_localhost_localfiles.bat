@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: start_localhost_localfiles.bat
::
:: Full install + launch for Open Generative AI on Windows in
:: LOCALHOST-ONLY / LOCAL-FILES-ONLY mode.
::
:: What this script does (fully automated, no user prompts):
::   1.  Verify Python 3.8+ and Node.js 18+ are on PATH.
::   2.  Install Node.js dependencies          (npm install --prefer-offline)
::   3.  Build the studio package              (npm run build:studio)
::   4.  Create Python venv at python\.venv    (skipped if already present)
::   5.  Upgrade pip inside the venv           (local-only, no PyPI)
::   6.  Install python\requirements.txt       (local wheels only, no PyPI)
::   7.  Build the Vite frontend bundle        (npm run vite:build)
::   8.  Launch the Electron app with every localhost / local-files env var set.
::
:: LOCALHOST-ONLY guarantees:
::   - Python sidecar binds to 127.0.0.1 only  (already hard-coded in server.py)
::   - PIP_NO_INDEX=1 / WHEELS_NO_INDEX=1 prevent pip from reaching PyPI
::   - No external API key is required; all inference uses the local sd.cpp binary
::     and the Python sidecar running on the same machine.
::
:: LOCAL-FILES-ONLY guarantees:
::   - pip uses WHEELS_DIR exclusively (--no-index --find-links).
::   - npm uses the local cache first  (--prefer-offline).
::   - Model downloads are resolved from MODELS_ROOT on disk.
::   - LORA_DIR and COGVIDEOX_DIR are pinned to local sub-directories.
::
:: Configurable via environment variables (set before running this script):
::   WHEELS_DIR      Path to a directory of .whl files.
::                   Default: H:\Models-D1\wheels
::   MODELS_ROOT     Root directory that contains all local AI model files.
::                   Default: <repo-root>\models
::   LORA_DIR        Directory of LoRA .safetensors files.
::                   Default: <repo-root>\lora
::   COGVIDEOX_DIR   Directory that contains CogVideoX model sub-folders.
::                   Default: MODELS_ROOT\CogVideoX
::   PYTHON_PORT     Port for the Python sidecar.
::                   Default: 7861
::
:: Usage (run from the repository root or double-click):
::   start_localhost_localfiles.bat
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

:: ─── Resolve repo root ───────────────────────────────────────────────────────
set REPO_ROOT=%~dp0
if "%REPO_ROOT:~-1%"=="\" set REPO_ROOT=%REPO_ROOT:~0,-1%

:: ─── Resolve configurable paths (caller may pre-set any of these) ────────────
if not defined WHEELS_DIR       set WHEELS_DIR=%REPO_ROOT%\wheels
if not defined LORA_DIR         set LORA_DIR=%REPO_ROOT%\lora
if not defined COGVIDEOX_DIR    set COGVIDEOX_DIR=%MODELS_ROOT%\CogVideoX
if not defined PYTHON_PORT      set PYTHON_PORT=7861

:: Derived internal paths
set VENV_DIR=%REPO_ROOT%\python\.venv
set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe
set REQUIREMENTS=%REPO_ROOT%\python\requirements.txt
set PIP_INI=%REPO_ROOT%\python\pip.ini

echo.
echo ================================================================
echo   Open Generative AI  ^|  localhost-only / local-files-only
echo ================================================================
echo.
echo  REPO_ROOT   : %REPO_ROOT%
echo  MODELS_ROOT : %MODELS_ROOT%
echo  WHEELS_DIR  : %WHEELS_DIR%
echo  LORA_DIR    : %LORA_DIR%
echo  COGVIDEOX   : %COGVIDEOX_DIR%
echo  PYTHON_PORT : %PYTHON_PORT%
echo.

:: ─── Step 1 / 7 — Check Python ───────────────────────────────────────────────
echo [1/7] Checking Python...
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Python was not found on PATH.
    echo  Install Python 3.8+ from https://www.python.org/downloads/
    echo  and tick "Add Python to PATH" during setup.
    echo.
    exit /b 1
)
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo  Found Python %PY_VER%

:: ─── Step 2 / 7 — Check Node.js ──────────────────────────────────────────────
echo [2/7] Checking Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Node.js was not found on PATH.
    echo  Install Node.js 18+ from https://nodejs.org/
    echo.
    exit /b 1
)
for /f %%v in ('node --version 2^>^&1') do set NODE_VER=%%v
echo  Found Node.js %NODE_VER%

:: ─── Step 3 / 7 — Install Node dependencies (prefer local cache) ─────────────
echo.
echo [3/7] Installing Node.js dependencies (--prefer-offline)...
cd /d "%REPO_ROOT%"
call npm install --prefer-offline
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: npm install failed (exit code %ERRORLEVEL%).
    exit /b %ERRORLEVEL%
)

echo  Building studio package...
call npm run build:studio
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: npm run build:studio failed (exit code %ERRORLEVEL%).
    exit /b %ERRORLEVEL%
)

:: ─── Step 4 / 7 — Create Python venv ─────────────────────────────────────────
echo.
echo [4/7] Setting up Python venv at python\.venv...
if not exist "%VENV_DIR%" (
    python -m venv "%VENV_DIR%"
    if !ERRORLEVEL! neq 0 (
        echo.
        echo  ERROR: Failed to create virtual environment.
        exit /b 1
    )
    echo  Venv created.
) else (
    echo  Venv already exists — skipping creation.
)

:: ─── Step 5 / 7 — Upgrade pip (offline only) ─────────────────────────────────
echo.
echo [5/7] Upgrading pip (no-index)...
"%VENV_PYTHON%" -m pip install --upgrade pip --no-index >nul 2>&1
:: Pip upgrade may fail if no local wheel is available — that is non-fatal.
echo  Pip upgrade attempted (warnings above are non-fatal).

:: ─── Step 6 / 7 — Install Python requirements (local wheels only) ────────────
echo.
echo [6/7] Installing python\requirements.txt (local wheels only)...

:: Validate that WHEELS_DIR exists — abort with a clear message if missing,
:: because local_files_only mode must not fall back to PyPI.
if not exist "%WHEELS_DIR%" (
    echo.
    echo  ERROR: WHEELS_DIR not found: %WHEELS_DIR%
    echo  local_files_only mode requires a local wheel cache.
    echo  Either:
    echo    a) Copy the required .whl files into %WHEELS_DIR%
    echo    b) Set WHEELS_DIR to an existing directory before running this script.
    echo.
    exit /b 1
)

set PIP_CONFIG_FILE=%PIP_INI%
set PIP_NO_INDEX=1
set WHEELS_NO_INDEX=1
"%VENV_PYTHON%" -m pip install ^
    --no-index ^
    --find-links "%WHEELS_DIR%" ^
    -r "%REQUIREMENTS%"
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: pip install failed (exit code %ERRORLEVEL%).
    echo  Make sure all required .whl files are present in: %WHEELS_DIR%
    echo.
    exit /b %ERRORLEVEL%
)
echo  Python requirements installed from local wheels.

:: ─── Step 7 / 7 — Build Vite frontend ────────────────────────────────────────
echo.
echo [7/7] Building Vite frontend bundle...
call npm run vite:build
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Vite build failed (exit code %ERRORLEVEL%).
    exit /b %ERRORLEVEL%
)
echo  Vite build complete.

:: ─── Launch Electron (localhost-only / local-files-only) ──────────────────────
echo.
echo ================================================================
echo   Launching Open Generative AI — localhost / local-files mode
echo ================================================================
echo.

:: Ensure model directories exist so the app never tries to create them over
:: the network or hits a missing-directory error on first run.
if not exist "%MODELS_ROOT%"   mkdir "%MODELS_ROOT%"
if not exist "%LORA_DIR%"      mkdir "%LORA_DIR%"
if not exist "%COGVIDEOX_DIR%" mkdir "%COGVIDEOX_DIR%"

:: Export all runtime env vars for this process and its children.
:: These are read by:
::   electron/lib/pythonServer.js   — WHEELS_NO_INDEX, WHEELS_DIR, PIP_NO_INDEX,
::                                    PIP_CONFIG_FILE, PYTHON_SERVER_PORT
::   electron/lib/localInference.js — MODELS_DIR, LORA_DIR
::   python/server.py               — MODELS_ROOT, COGVIDEOX_DIR, PYTHON_SERVER_PORT
::   app/api/cogvideox/route.js     — COGVIDEOX_DIR, MODELS_ROOT (Next.js dev only)
::   app/api/loras/route.js         — LORA_DIR (Next.js dev only)

set MODELS_DIR=%MODELS_ROOT%
set ESRGAN_MODELS_DIR=%MODELS_ROOT%\esrgan_models
set GFPGAN_WEIGHTS_DIR=%MODELS_ROOT%\gfpgan
set INSIGHTFACE_MODELS_DIR=%MODELS_ROOT%\extensions\insightface\models
set COGVIDEOX_MODEL_PATH=%COGVIDEOX_DIR%\CogVideoX-5b
set PYTHON_SERVER_PORT=%PYTHON_PORT%
set PIP_CONFIG_FILE=%PIP_INI%
set PIP_NO_INDEX=1
set WHEELS_NO_INDEX=1

:: Start the Electron app — inherits all env vars set above.
npx electron .
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% neq 0 (
    echo.
    echo  Electron exited with code %EXIT_CODE%.
    exit /b %EXIT_CODE%
)

endlocal
