@echo off
title NAPM Package Tool

:: Switch to project root (works no matter where you double-click from)
cd /d "%~dp0.."

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js first:
    echo         https://nodejs.org/
    pause
    exit /b 1
)

echo.
echo ============================================
echo   NAPM Upgrade Package Tool - Starting...
echo ============================================
echo.
echo   Local URL: http://localhost:18901
echo   Press Ctrl+C to stop
echo ============================================
echo.

:: Start server (auto-opens browser)
node tools\package-gui.js

:: If node exits unexpectedly
echo.
echo Server stopped. Press any key to close...
pause >nul
