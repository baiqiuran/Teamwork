@echo off
setlocal
call "%~dp0deploy-ecs.bat" "E:\ridkey\bim-test-2025-ecs-key.pem"
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
