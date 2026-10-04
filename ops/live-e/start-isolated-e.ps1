#Requires -Version 7.0
# start-isolated-e.ps1 R3 —— 隔离 live E 生产入口：只作用于 canonical 测试根（没有任何路径/探针/启动器参数）
#   首次验收（重建测试根 + 启动）：pwsh -NoProfile -File <本目录>\start-isolated-e.ps1 -RebuildRoot
#   续跑同一验收（不重建、保留队列）：pwsh -NoProfile -File <本目录>\start-isolated-e.ps1 -ContinueAcceptance
# 全部逻辑在 e-gates.ps1 的 EGate-Start（夹具测试驱动的就是同一个函数）；本文件只构造 canonical 上下文并转成退出码。
[CmdletBinding()]
param([switch]$RebuildRoot, [switch]$ContinueAcceptance)
$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'e-gates.ps1')
  EGate-Start -Context (EGate-CanonicalContext) -RebuildRoot:$RebuildRoot -ContinueAcceptance:$ContinueAcceptance
  exit 0
} catch { Write-Output ('X ' + $_.Exception.Message); exit 1 }
