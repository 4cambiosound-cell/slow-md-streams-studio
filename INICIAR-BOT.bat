@echo off
chcp 65001 > nul
title BOT TIKTOK LIVE - SLOW MD
cls
echo =======================================================
echo          SLOW MD - BOT DE TIKTOK LIVE
echo =======================================================
echo.
echo [1/2] Abriendo Panel de Control en tu navegador...
start http://localhost:3000/?view=panel
echo [2/2] Iniciando el servidor local de TikTok Live...
echo.
echo Presiona Ctrl+C o cierra esta ventana cuando termines tu stream.
echo =======================================================
echo.
node server.js
pause
