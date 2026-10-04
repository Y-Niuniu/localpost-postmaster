# rebuild-e-test-root.ps1 R2 —— 受控重建（改用 e-gates 门禁库；失败以终止异常+exit 1 阻断调用者）
[CmdletBinding()]
param([switch]$ConfirmHostExited, [string]$RootPath, [string]$ExePath, [scriptblock]$HostProbe, [scriptblock]$ReceiverProbe, [string]$WorkParent, [string]$EvidenceDir)
. (Join-Path $PSScriptRoot 'e-gates.ps1')
$root = if ($PSBoundParameters.ContainsKey('RootPath')) { $RootPath } else { $script:ERootDefault }
$exe  = if ($PSBoundParameters.ContainsKey('ExePath')) { $ExePath } else { $script:EExeDefault }
$work = if ($PSBoundParameters.ContainsKey('WorkParent')) { $WorkParent } else { 'C:\AI_ASSIST\work' }
$evd  = if ($PSBoundParameters.ContainsKey('EvidenceDir')) { $EvidenceDir } else { 'C:\AI_ASSIST\work\localpost-six-gates-evidence' }
try {
  $rootFull = [IO.Path]::GetFullPath($root)
  if ($rootFull -notlike ($work.TrimEnd('\') + '\*')) { EGate-Fail ('源不在指定 work 父目录下：' + $rootFull) }
  if ($rootFull -like '*\.mailbox*') { EGate-Fail '拒绝生产路径' }
  foreach ($p in @($rootFull, (Split-Path $rootFull -Parent), (Split-Path (Split-Path $rootFull -Parent) -Parent))) {
    if ((Test-Path -LiteralPath $p) -and ([bool]((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { EGate-Fail ('父链重解析点：' + $p) }
  }
  EGate-AssertHostStopped -ConfirmHostExited:$ConfirmHostExited -ExePath $exe -RootPath $rootFull -HostProbe $HostProbe -ReceiverProbe $ReceiverProbe | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $work ([IO.Path]::GetFileName($rootFull) + '.bak-' + $stamp)
  if (Test-Path -LiteralPath $backup) { EGate-Fail ('备份目标已存在：' + $backup) }
  if (Test-Path -LiteralPath $rootFull) {
    $evFile = Join-Path $evd ('e-test-root-before-rebuild-' + $stamp + '.txt')
    $lines = Get-ChildItem -LiteralPath $rootFull -Recurse -Force | ForEach-Object { $h=''; if (-not $_.PSIsContainer) { $h=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }; $_.FullName + '|' + $_.Length + '|' + $_.LastWriteTime.ToString('o') + '|' + $_.Attributes + '|' + $h }
    $lines | Out-File -Encoding utf8 $evFile
    Write-Output ('OK 证据：' + $evFile + '（' + $lines.Count + ' 条）')
    Move-Item -LiteralPath $rootFull -Destination $backup
    Write-Output ('OK 旁移 -> ' + $backup)
  } else { Write-Output 'OK 源不存在：无需旁移' }
  New-Item -ItemType Directory -Path $rootFull -Force | Out-Null
  New-Item -ItemType File -Path (Join-Path $rootFull '.e-acceptance') -Force | Out-Null   # 标记：本根已用于同一次验收
  Get-ChildItem -LiteralPath $rootFull -Recurse -Force | Where-Object { $_.Name -ne '.e-acceptance' } | ForEach-Object { EGate-Fail ('重建后根非空：' + $_.FullName) }
  Write-Output 'OK 重建完成（仅含 .e-acceptance 标记）'
  exit 0
} catch { Write-Output ('X ' + $_.Exception.Message); exit 1 }