@echo off
setlocal DisableDelayedExpansion
"%~dp0agentown-desktop.exe" %*
exit /b %errorlevel%
