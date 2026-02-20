@echo off
setlocal
chcp 65001 >NUL

set "WSL_DISTRO=Ubuntu"
set "MODE=keepalive"
if /I "%~1"=="--once" set "MODE=once"

echo [Postiz] Starting services...
echo [Postiz] Distro: %WSL_DISTRO%

if /I "%MODE%"=="once" goto once

wsl -d %WSL_DISTRO% -u root -- bash -lc "set -e; POSTIZ_WORKDIR=/mnt/f/postiz-app bash /mnt/f/postiz-app/scripts/wsl/ensure-postiz-systemd.sh; systemctl restart postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service; systemctl is-active postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service; echo '[Postiz] Services are up. Keep this window open to keep WSL alive.'; echo '[Postiz] Frontend: http://localhost:4200/auth'; echo '[Postiz] Backend: http://localhost:3000'; echo '[Postiz] MediaCrawler: http://localhost:8081/docs'; exec tail -f /dev/null"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto fail
goto done

:once
wsl -d %WSL_DISTRO% -u root -- bash -lc "set -e; POSTIZ_WORKDIR=/mnt/f/postiz-app bash /mnt/f/postiz-app/scripts/wsl/ensure-postiz-systemd.sh; systemctl restart postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service; systemctl is-active postiz-dev-temporal.service postiz-dev-backend.service postiz-dev-orchestrator.service postiz-dev-frontend.service postiz-dev-mediacrawler.service"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto fail
echo [Postiz] Started (once mode).
goto done

:fail
echo [Postiz] Start failed, code: %RC%
pause
exit /b %RC%

:done
endlocal
exit /b 0
