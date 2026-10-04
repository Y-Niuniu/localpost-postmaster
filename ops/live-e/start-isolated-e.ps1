# start-isolated-e.ps1 R2 —— 隔离启动（四项预检 + 停机门禁 + 子脚本失败阻断 + 重启路径显式区分）
[CmdletBinding()]
param([switch]$RebuildRoot, [switch]$ContinueAcceptance, [string]$RootPath, [string]$ExePath, [string]$RepoPath, [scriptblock]$HostProbe, [scriptblock]$ReceiverProbe, [scriptblock]$LaunchOverride)
. (Join-Path $PSScriptRoot 'e-gates.ps1')
$root = if ($PSBoundParameters.ContainsKey('RootPath')) { $RootPath } else { $script:ERootDefault }
$exe  = if ($PSBoundParameters.ContainsKey('ExePath')) { $ExePath } else { $script:EExeDefault }
$repo = if ($PSBoundParameters.ContainsKey('RepoPath')) { $RepoPath } else { $script:ERepoDefault }
try {
  # 1) 四项预检：exe / asar / Node / profile / 代码基线（漂移即在任何写入与启动之前拒绝）
  EGate-AssertHash $exe $script:EHash.exe 'exe' | Out-Null
  EGate-AssertHash $script:EAsarDefault $script:EHash.asar 'app.asar' | Out-Null
  EGate-AssertHash $script:ENodeDefault $script:EHash.node 'node' | Out-Null
  EGate-AssertHash $script:EProfileDefault $script:EHash.profile 'profile package.json' | Out-Null
  EGate-AssertBaseline $repo | Out-Null
  Write-Output 'OK 预检通过（exe/asar/node/profile/main）'
  # 2) 停机门禁（含独立 receiver 检查）
  EGate-AssertHostStopped -ConfirmHostExited -ExePath $exe -RootPath $root -HostProbe $HostProbe -ReceiverProbe $ReceiverProbe | Out-Null
  Write-Output 'OK 停机门禁通过'
  # 3) 重建或显式续跑（两者必须区分，不得默默沿用旧 R3 根）
  if ($RebuildRoot) {
    EGate-InvokeChild (Join-Path $PSScriptRoot 'rebuild-e-test-root.ps1') @('-ConfirmHostExited') | Out-Null
    EGate-AssertRootEmpty $root | Out-Null
    Write-Output 'OK 重建后置条件通过'
  } elseif ($ContinueAcceptance) {
    if (-not (Test-Path -LiteralPath (Join-Path $root '.e-acceptance'))) { EGate-Fail '续跑路径要求已标记的验收根；首次验收请用 -RebuildRoot' }
    Write-Output 'OK 续跑同一验收（不重建、不动既有队列）'
  } else { EGate-Fail '必须显式选择 -RebuildRoot（首次）或 -ContinueAcceptance（续跑）' }
  # 4) 仅在本进程注入 7 个变量，然后启动
  $env:DSH_LOCALPOST_E_ENABLED='1'
$env:DSH_LOCALPOST_E_ROOT=$root
$env:DSH_LOCALPOST_E_RUNTIME='0.2.0-rc.2'
  $env:DSH_LOCALPOST_E_EVIDENCE=('precheck:exe ' + $script:EHash.exe + '; asar ' + $script:EHash.asar + '; node ' + $script:EHash.node + '; main ' + $script:EHash.main)
  $env:DSH_LOCALPOST_E_ALLOW_FROM='codex'
$env:DSH_LOCALPOST_E_SCAN_MS='30000'
$env:DSH_LOCALPOST_E_DEBOUNCE_MS='250'
  if ($LaunchOverride) { & $LaunchOverride $exe } else { $p = Start-Process -FilePath $exe -PassThru; Write-Output ('OK 已启动，PID=' + $p.Id) }
  exit 0
} catch { Write-Output ('X ' + $_.Exception.Message); exit 1 }