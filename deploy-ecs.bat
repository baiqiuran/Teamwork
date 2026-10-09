@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Usage: deploy-ecs.bat [private-key.pem]   or   deploy-ecs.bat --package-only
set "SSH_TARGET=ecs-user@120.25.176.6"
set "SSH_PORT=22"
set "SSH_KEY=%USERPROFILE%\.ssh\bim-test-2025-ecs-key.pem"
if not "%~1"=="" if not "%~1"=="--package-only" set "SSH_KEY=%~f1"
set "PACKAGE_ONLY=0"
if "%~1"=="--package-only" set "PACKAGE_ONLY=1"
set "APP_DIR=%~dp0"
set "PACKAGE_DIR=%TEMP%\new-chat-package-%RANDOM%-%RANDOM%"
set "REMOTE_UPLOAD="

pushd "%APP_DIR%" || exit /b 1
for %%T in (node.exe npm.cmd tar.exe git.exe ssh.exe scp.exe) do (
  where %%T >nul 2>&1
  if errorlevel 1 (
    echo [ERROR] Missing command: %%T
    goto :failed
  )
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a!==24||b<15)process.exit(1)"
if errorlevel 1 (
  echo [ERROR] Node.js 24.15.0 or newer 24.x is required.
  goto :failed
)
if "%PACKAGE_ONLY%"=="0" if not exist "%SSH_KEY%" (
  echo [ERROR] Private key not found. Pass its absolute path as the first argument.
  goto :failed
)

echo [1/4] Installing dependencies and building frontend and server...
node.exe "%APP_DIR%scripts\ecs-release.mjs" capture "%PACKAGE_DIR%"
if errorlevel 1 goto :failed
cd /d "%PACKAGE_DIR%\source" || goto :failed
call npm.cmd ci
if not "%errorlevel%"=="0" goto :failed
call npm.cmd run build
if not "%errorlevel%"=="0" goto :failed
node.exe "%PACKAGE_DIR%\source\scripts\ecs-release.mjs" seal "%PACKAGE_DIR%"
if errorlevel 1 goto :failed
echo Package: %PACKAGE_DIR%\application.tar.gz
if "%PACKAGE_ONLY%"=="1" goto :done

echo [2/4] Creating a unique upload directory...
for /f "delims=" %%D in ('ssh.exe -p %SSH_PORT% -i "%SSH_KEY%" %SSH_TARGET% "mktemp -d /tmp/new-chat-upload.XXXXXXXX"') do set "REMOTE_UPLOAD=%%D"
if not defined REMOTE_UPLOAD goto :failed
echo [3/4] Uploading the application and release script...
scp.exe -P %SSH_PORT% -i "%SSH_KEY%" "%PACKAGE_DIR%\application.tar.gz" "%PACKAGE_DIR%\receipt.json" "%PACKAGE_DIR%\source\scripts\deploy-ecs.sh" "%PACKAGE_DIR%\source\scripts\ecs-release.mjs" %SSH_TARGET%:%REMOTE_UPLOAD%/
if errorlevel 1 goto :failed
echo [4/4] Installing release and restarting new-chat.service...
ssh.exe -p %SSH_PORT% -i "%SSH_KEY%" %SSH_TARGET% "sudo -n bash '%REMOTE_UPLOAD%/deploy-ecs.sh' '%REMOTE_UPLOAD%/application.tar.gz'"
if errorlevel 1 goto :failed
scp.exe -P %SSH_PORT% -i "%SSH_KEY%" %SSH_TARGET%:%REMOTE_UPLOAD%/release-record.json "%PACKAGE_DIR%\release-record.json"
if errorlevel 1 goto :failed
ssh.exe -p %SSH_PORT% -i "%SSH_KEY%" %SSH_TARGET% "sudo -n journalctl -u new-chat.service -n 60 --no-pager"
if errorlevel 1 goto :failed
echo Release completed. Local package retained at %PACKAGE_DIR%
:done
popd
exit /b 0

:failed
if defined REMOTE_UPLOAD scp.exe -P %SSH_PORT% -i "%SSH_KEY%" %SSH_TARGET%:%REMOTE_UPLOAD%/release-record.json "%PACKAGE_DIR%\release-record.json" >nul 2>&1
if exist "%PACKAGE_DIR%\receipt.json" if not exist "%PACKAGE_DIR%\release-record.json" node.exe "%PACKAGE_DIR%\source\scripts\ecs-release.mjs" record "%PACKAGE_DIR%" unconfirmed - - "unknown" >nul 2>&1
echo [ERROR] Command failed. Release was not confirmed successful.
echo Keep the package and inspect: sudo journalctl -u new-chat.service -n 100 --no-pager
if defined REMOTE_UPLOAD echo Remote upload retained at %REMOTE_UPLOAD%
popd
exit /b 1
