@echo off
title OTDO Server
cd /d "%~dp0"
python "%~dp0server.py" --open
echo.
echo [OTDO] Server exited.
pause
