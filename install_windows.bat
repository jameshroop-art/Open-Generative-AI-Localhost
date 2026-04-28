@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: install_windows.bat — One-step installer for Open Generative AI on Windows 11
::
:: What this script does:
::   1. Verifies Python 3.8+ and Node.js 18+ are available on PATH
::   2. Installs Node dependencies and builds the studio package
::   3. Creates a Python virtual environment at python\.venv
::   4. Installs python\requirements.txt into that venv
::
:: Usage (run from the repository root, e.g. double-click or in a terminal):
::   install_windows.bat
::
:: Optional — install Python deps from a local wheel directory instead of PyPI:
::   set WHEELS_DIR=H:\Models-D1\wheels
::   install_windows.bat
::
:: Optional — disable PyPI fallback (local wheels only):
::   set WHEELS_NO_INDEX=1
::   install_windows.bat
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

set REPO_ROOT=%~dp0
:: Strip trailing backslash so paths compose cleanly
if "%REPO_ROOT:~-1%"=="\" set REPO_ROOT=%REPO_ROOT:~0,-1%

set VENV_DIR=%REPO_ROOT%\python\.venv
set REQUIREMENTS=%REPO_ROOT%\python\requirements.txt
set PIP_INI=%REPO_ROOT%\python\pip.ini

echo.
echo ============================================================
echo   Open Generative AI — Windows 11 Installer
echo ============================================================
echo.

:: ─── 1. Check Python ─────────────────────────────────────────────────────────
echo [1/4] Checking Python...
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Python was not found on PATH.
    echo  Please install Python 3.8 or later from https://www.python.org/downloads/
    echo  Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)
for /f "tokens=2 delims= " %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo  Found Python %PY_VER%

:: ─── 2. Check Node.js ────────────────────────────────────────────────────────
echo [2/4] Checking Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: Node.js was not found on PATH.
    echo  Please install Node.js 18 or later from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f %%v in ('node --version 2^>^&1') do set NODE_VER=%%v
echo  Found Node.js %NODE_VER%

:: ─── 3. Install Node dependencies and build ──────────────────────────────────
echo.
echo [3/4] Installing Node.js dependencies...
cd /d "%REPO_ROOT%"
call npm install
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: npm install failed (exit code %ERRORLEVEL%).
    pause
    exit /b %ERRORLEVEL%
)

echo  Building studio package...
call npm run build:studio
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: npm run build:studio failed (exit code %ERRORLEVEL%).
    pause
    exit /b %ERRORLEVEL%
)

:: ─── 4. Create venv and install Python deps ──────────────────────────────────
echo.
echo [4/4] Setting up Python virtual environment at python\.venv ...

if not exist "%VENV_DIR%" (
    python -m venv "%VENV_DIR%"
    if %ERRORLEVEL% neq 0 (
        echo.
        echo  ERROR: Failed to create virtual environment (exit code %ERRORLEVEL%).
        pause
        exit /b %ERRORLEVEL%
    )
    echo  Virtual environment created.
) else (
    echo  Virtual environment already exists — skipping creation.
)

set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe

echo  Upgrading pip inside venv...
"%VENV_PYTHON%" -m pip install --upgrade pip --quiet
if %ERRORLEVEL% neq 0 (
    echo  WARNING: pip upgrade failed — continuing with existing version.
)

:: Build pip flags — respect optional WHEELS_DIR and WHEELS_NO_INDEX
set PIP_FLAGS=
if defined WHEELS_DIR (
    if exist "%WHEELS_DIR%" (
        echo  Using local wheels: %WHEELS_DIR%
        set PIP_FLAGS=--find-links "%WHEELS_DIR%"
    ) else (
        echo  WARNING: WHEELS_DIR not found: %WHEELS_DIR% — falling back to PyPI.
    )
)
if defined WHEELS_NO_INDEX (
    set PIP_FLAGS=%PIP_FLAGS% --no-index
)

echo  Installing python\requirements.txt into venv...
set PIP_CONFIG_FILE=%PIP_INI%
if defined PIP_FLAGS (
    "%VENV_PYTHON%" -m pip install %PIP_FLAGS% -r "%REQUIREMENTS%"
) else (
    "%VENV_PYTHON%" -m pip install -r "%REQUIREMENTS%"
)
if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: pip install failed (exit code %ERRORLEVEL%).
    pause
    exit /b %ERRORLEVEL%
)

:: ─── Done ────────────────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   Installation complete!
echo ============================================================
echo.
echo  To run the app in development mode:
echo    npm run electron:dev
echo.
echo  To build a Windows installer:
echo    npm run electron:build:win
echo.
echo  The Python venv is at:
echo    %VENV_DIR%
echo  It will be used automatically by the Electron app.
echo.
pause
endlocal
