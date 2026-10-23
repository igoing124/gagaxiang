@echo off
setlocal
rem Workaround: native binaries (esbuild.exe / workerd.exe) fail with OS Error 5
rem (ACCESS_DENIED) when they live under a non-ASCII path such as D:\ai\油炸小程序.
rem Point them at copies placed in an ASCII directory.
set "BIN_DIR=%USERPROFILE%\.esbuild-bin"
set "ESBUILD_BINARY_PATH=%BIN_DIR%\esbuild.exe"
set "MINIFLARE_WORKERD_PATH=%BIN_DIR%\workerd.exe"

if not exist "%ESBUILD_BINARY_PATH%" (
  echo [setup] copying esbuild.exe to %BIN_DIR%
  if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
  copy /Y "%~dp0node_modules\@esbuild\win32-x64\esbuild.exe" "%ESBUILD_BINARY_PATH%" >nul
)
if not exist "%MINIFLARE_WORKERD_PATH%" (
  echo [setup] copying workerd.exe to %BIN_DIR%
  if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
  copy /Y "%~dp0node_modules\@cloudflare\workerd-windows-64\bin\workerd.exe" "%MINIFLARE_WORKERD_PATH%" >nul
)

cd /d "%~dp0"
npx wrangler deploy %*
endlocal
