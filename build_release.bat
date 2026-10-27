@echo off
rem One-click release build: double-click, or run
rem     build_release.bat [--skip-tests] [--allow-dirty] [--proxy URL]
rem Build steps live in scripts\build_release.py; artifacts go to dist\.
setlocal
cd /d "%~dp0"
set "PY=%~dp0.venv\Scripts\python.exe"
set "RC=0"

if not exist "%PY%" (
    echo [ERROR] .venv not found. Create it first:
    echo     python -m venv .venv
    echo     .venv\Scripts\python -m pip install -e .[dev,release]
    set "RC=1"
    goto :end
)

"%PY%" -c "import PyInstaller" 2>nul
if errorlevel 1 (
    echo PyInstaller not found in .venv, installing ...
    "%PY%" -m pip install -e ".[release]"
    if errorlevel 1 (
        echo [ERROR] pip install failed. If offline, retry with HTTPS_PROXY set.
        set "RC=1"
        goto :end
    )
)

"%PY%" scripts\build_release.py %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
    echo Release build OK. Artifacts: "%~dp0dist"
) else (
    echo [ERROR] Release build failed, exit code %RC%. See the log above.
)

:end
rem keep the window open when launched by double-click
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b %RC%
