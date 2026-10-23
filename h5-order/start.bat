@echo off
rem One-click launcher for the H5 order system
cd /d "%~dp0"

rem Start server if not already running
curl -s -o nul --max-time 2 http://localhost:3000
if errorlevel 1 (
    echo Starting server...
    start "h5-order-server" /min cmd /c "node server.js"
    timeout /t 2 /nobreak >nul
)

rem Open both pages in default browser
start "" http://localhost:3000
start "" http://localhost:3000/admin.html
