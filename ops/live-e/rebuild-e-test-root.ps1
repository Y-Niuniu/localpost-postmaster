#Requires -Version 7.0
# rebuild-e-test-root.ps1 R3 —— 单独重建 canonical 测试根（不启动宿主）；只作用于 canonical 根，没有任何路径/探针参数
#   pwsh -NoProfile -File <本目录>\rebuild-e-test-root.ps1 -ConfirmHostExited
# 全部逻辑在 e-gates.ps1 的 EGate-Rebuild（start-isolated-e.ps1 -RebuildRoot 在同一进程里调用同一函数）。
[CmdletBinding()]
param([switch]$ConfirmHostExited)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'e-gates.ps1')
  EGate-Rebuild -Context (EGate-CanonicalContext) -ConfirmHostExited:$ConfirmHostExited
  exit 0
} catch { Write-Output ('X ' + $_.Exception.Message); exit 1 }
