@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: setup_python.bat — create a venv and install Python dependencies.
::
:: Usage (run from the repository root):
::   scripts\setup_python.bat
::
:: The script:
::   1. Creates a virtual environment at python\.venv (if it does not exist).
::   2. Installs every package listed in python\requirements.txt into the venv,
::      using wheels found in H:\Models-D1\wheels first (or WHEELS_DIR if set),
::      falling back to PyPI for any package not present locally.
::
:: To install *only* from local wheels (no internet required), pass --no-index:
::   scripts\setup_python.bat --no-index
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

set REPO_ROOT=%~dp0..
set VENV_DIR=%REPO_ROOT%\python\.venv
if not defined WHEELS_DIR set WHEELS_DIR=H:\Models-D1\wheels
set REQUIREMENTS=%REPO_ROOT%\python\requirements.txt
set PIP_INI=%REPO_ROOT%\python\pip.ini

:: ─── Create venv if needed ───────────────────────────────────────────────────
if not exist "%VENV_DIR%" (
    echo [setup_python] Creating virtual environment at %VENV_DIR% ...
    python -m venv "%VENV_DIR%"
    if !ERRORLEVEL! neq 0 (
        echo [setup_python] ERROR: Failed to create virtual environment.
        exit /b !ERRORLEVEL!
    )
) else (
    echo [setup_python] Virtual environment already exists — skipping creation.
)

set VENV_PYTHON=%VENV_DIR%\Scripts\python.exe

:: ─── Resolve wheel directory ─────────────────────────────────────────────────
if not exist "%WHEELS_DIR%" (
    echo [setup_python] WARNING: Wheel directory not found: %WHEELS_DIR%
    echo [setup_python] Falling back to PyPI only.
    set WHEELS_DIR=
)

:: Allow caller to pass --no-index to disable PyPI fallback
set EXTRA_FLAGS=
if "%1"=="--no-index" set EXTRA_FLAGS=--no-index

echo [setup_python] Installing requirements from %REQUIREMENTS%
if defined WHEELS_DIR (
    echo [setup_python] Using local wheels: %WHEELS_DIR%
)

set PIP_CONFIG_FILE=%PIP_INI%
if defined WHEELS_DIR (
    "%VENV_PYTHON%" -m pip install --find-links "%WHEELS_DIR%" %EXTRA_FLAGS% -r "%REQUIREMENTS%"
) else (
    "%VENV_PYTHON%" -m pip install -r "%REQUIREMENTS%"
)

if %ERRORLEVEL% neq 0 (
    echo [setup_python] ERROR: pip install failed (exit code %ERRORLEVEL%).
    exit /b %ERRORLEVEL%
)

echo [setup_python] Done. Venv Python: %VENV_PYTHON%
endlocal
