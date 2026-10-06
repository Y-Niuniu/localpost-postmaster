@echo off
REM LocalPost Stop hook wrapper. ASCII ONLY (cmd.exe decodes this file with the system codepage).
REM Step 1: leave a launch beacon so we can tell "hook never invoked" from "invoked but node failed".
REM Step 2: run the checker; stdout must pass through untouched because Codex expects JSON there.
echo launched %DATE% %TIME% >> "%~dp0hook-launched.log"
"C:\Program Files\nodejs\node.exe" "%~dp0codex-check.mjs"
