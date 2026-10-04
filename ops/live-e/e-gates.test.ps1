# e-gates.test.ps1 —— 门禁回归（全部用临时根与 mock 探针；不碰真实根、不启动真 launcher）
. (Join-Path $PSScriptRoot 'e-gates.ps1')
$pass = 0; $fail = 0
function T([string]$name, [scriptblock]$body, [switch]$ExpectFail) {
  $threw = $false; try { & $body } catch { $threw = $true }
  if ($threw -eq [bool]$ExpectFail) { $script:pass++; Write-Output ('PASS ' + $name) } else { $script:fail++; Write-Output ('FAIL ' + $name + ' (threw=' + $threw + ')') }
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('e-gates-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$fixtureChildFail = Join-Path $tmp 'child-fail.ps1'; 'exit 1' | Out-File -Encoding utf8 $fixtureChildFail
$fixtureChildOk = Join-Path $tmp 'child-ok.ps1'; 'exit 0' | Out-File -Encoding utf8 $fixtureChildOk
# 1) 子脚本失败必须阻断调用者
T '1a 子脚本 exit 1 阻断外层' { EGate-InvokeChild $fixtureChildFail @() } -ExpectFail
T '1b 子脚本找不到阻断外层' { EGate-InvokeChild (Join-Path $tmp 'nope.ps1') @() } -ExpectFail
T '1c 子脚本 exit 0 放行' { EGate-InvokeChild $fixtureChildOk @() | Out-Null }
# 2) 枚举/身份不可读 => 拒绝（不得当 0 进程）
T '2a 枚举抛错 => 拒绝' { EGate-AssertHostStopped -ConfirmHostExited -HostProbe { throw 'enum exploded' } } -ExpectFail
T '2b 候选路径不可读 => 拒绝' { EGate-ResolveCandidates -Candidates @([pscustomobject]@{ ProcessId = 123; ExecutablePath = '' }) } -ExpectFail
T '2c 宿主存在 => 拒绝' { EGate-AssertHostStopped -ConfirmHostExited -HostProbe { @([pscustomobject]@{ Id = 111; Path = 'x' }) } } -ExpectFail
T '2d 无宿主无 receiver => 放行' { EGate-AssertHostStopped -ConfirmHostExited -HostProbe { @() } -ReceiverProbe { @() } | Out-Null }
# 3) 独立 receiver 指向该根 => 拒绝
T '3a receiver 指向根 => 拒绝' { EGate-AssertHostStopped -ConfirmHostExited -HostProbe { @() } -ReceiverProbe { @([pscustomobject]@{ Id = 222; Reason = 'receiver+root' }) } } -ExpectFail
# 4) 漂移 => 在任何写入/启动前拒绝
T '4a exe hash 漂移 => 拒绝' { EGate-AssertHash 'C:\Windows\notepad.exe' 'deadbeef' 'exe' } -ExpectFail
T '4b 文件不存在 => 拒绝' { EGate-AssertHash (Join-Path $tmp 'nope.exe') 'x' 'exe' } -ExpectFail
T '4c 非 git 目录 => 基线拒绝' { EGate-AssertBaseline $tmp } -ExpectFail
T '4d 正确 hash => 放行' { EGate-AssertHash 'C:\Windows\notepad.exe' ((Get-FileHash 'C:\Windows\notepad.exe' -Algorithm SHA256).Hash.ToLower()) 'exe' | Out-Null }
# 5) 后置条件与续跑区分
$root5 = Join-Path $tmp 'root5'; New-Item -ItemType Directory -Path $root5 -Force | Out-Null; New-Item -ItemType File -Path (Join-Path $root5 '.e-acceptance') -Force | Out-Null
T '5a 空根（仅标记）=> 放行' { EGate-AssertRootEmpty $root5 | Out-Null }
T '5b 根有其它内容 => 拒绝' { New-Item -ItemType File -Path (Join-Path $root5 'leftover.json') -Force | Out-Null; EGate-AssertRootEmpty $root5 | Out-Null } -ExpectFail
Remove-Item -LiteralPath $tmp -Recurse -Force
Write-Output ('RESULT pass=' + $pass + ' fail=' + $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }