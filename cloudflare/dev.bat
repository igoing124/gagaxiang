@echo off
setlocal
rem Same ASCII-path workaround as deploy.bat - see README "Windows 中文路径构建失败"
set "BIN_DIR=%USERPROFILE%\.esbuild-bin"
set "ESBUILD_BINARY_PATH=%BIN_DIR%\esbuild.exe"
set "MINIFLARE_WORKERD_PATH=%BIN_DIR%\workerd.exe"

if not exist "%ESBUILD_BINARY_PATH%" (
  if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
  copy /Y "%~dp0node_modules\@esbuild\win32-x64\esbuild.exe" "%ESBUILD_BINARY_PATH%" >nul
)
if not exist "%MINIFLARE_WORKERD_PATH%" (
  if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
  copy /Y "%~dp0node_modules\@cloudflare\workerd-windows-64\bin\workerd.exe" "%MINIFLARE_WORKERD_PATH%" >nul
)

cd /d "%~dp0"
npx wrangler dev %*
endlocal
