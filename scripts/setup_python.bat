@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: setup_python.bat — install Python dependencies from local wheel files.
::
:: Usage (run from the repository root):
::   scripts\setup_python.bat
::
:: The script installs every package listed in python\requirements.txt using
:: wheels found in H:\Models-D1\wheels first, falling back to PyPI for any
:: package not present locally.
::
:: To install *only* from local wheels (no internet required), pass --no-index:
::   scripts\setup_python.bat --no-index
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

set WHEELS_DIR=H:\Models-D1\wheels
set REQUIREMENTS=%~dp0..\python\requirements.txt
set PIP_INI=%~dp0..\python\pip.ini

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
    python -m pip install --find-links "%WHEELS_DIR%" %EXTRA_FLAGS% -r "%REQUIREMENTS%"
) else (
    python -m pip install -r "%REQUIREMENTS%"
)

if %ERRORLEVEL% neq 0 (
    echo [setup_python] ERROR: pip install failed (exit code %ERRORLEVEL%).
    exit /b %ERRORLEVEL%
)

echo [setup_python] Done.
endlocal
