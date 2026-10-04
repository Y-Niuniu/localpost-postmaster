# e-gates.test.ps1 R3 —— 门禁 + 启动链回归
# 全部写操作只发生在 -TempBase 下的一次性夹具目录；进程枚举 / 启动器 / 时钟由夹具上下文提供（原始进程记录喂给真实过滤函数），
# hash 与 git 是在夹具文件 / 夹具仓库上的真实操作。canonical 根只读快照、前后比对；不启动任何真实 launcher：
# 生产入口脚本只以"同目录桩库"副本在子 pwsh 里运行，用来验证参数面与开关绑定。
# 用法：pwsh -NoProfile -File e-gates.test.ps1 [-TempBase <目录>]      # 在 worktree 里跑请传 <worktree>\.localpost-tmp
param([string]$TempBase = [IO.Path]::GetTempPath())
$ErrorActionPreference = 'Continue'   # 故意保持调用方默认值：被测库必须自己 fail closed
. (Join-Path $PSScriptRoot 'e-gates.ps1')

$script:pass = 0; $script:fail = 0
function Assert([bool]$Cond, [string]$Msg) { if (-not $Cond) { throw ('ASSERT ' + $Msg) } }
# 期望被拒绝：必须抛错，且原因匹配 $Pattern（不接受"随便什么异常"）
function Refused([scriptblock]$Action, [string]$Pattern) {
  $msg = $null
  try { & $Action | Out-Null } catch { $msg = $_.Exception.Message }
  if ($null -eq $msg) { throw 'ASSERT 期望拒绝，实际放行' }
  if ($msg -notmatch $Pattern) { throw ('ASSERT 拒绝原因不符（期望 /' + $Pattern + '/）：' + $msg) }
  return $msg
}
function T([string]$Name, [scriptblock]$Body) {
  try { & $Body | Out-Null; $script:pass++; Write-Output ('PASS ' + $Name) }
  catch { $script:fail++; Write-Output ('FAIL ' + $Name + ' :: ' + $_.Exception.Message) }
}

# ---------- 夹具基础 ----------
$TempBase = [IO.Path]::GetFullPath($TempBase)
if (EGate-PathWithin $TempBase $script:EWorkDefault) { Write-Output 'X -TempBase 不得位于 canonical work 目录内'; exit 1 }
$script:Tmp = Join-Path $TempBase ('e-gates-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $script:Tmp -Force -ErrorAction Stop | Out-Null
$script:Me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$script:Pwsh = (Get-Process -Id $PID).Path
$script:Self = [pscustomobject]@{ ProcessId = $PID; Name = 'pwsh.exe'; ExecutablePath = $script:Pwsh; CommandLine = 'pwsh -NoProfile -File e-gates.test.ps1' }
$script:Cli = 'C:\AI_ASSIST\tools\dsh-localpost-postmaster\localpost\receiver-cli.mjs'

function Deny([string]$Path, [string]$Spec) { icacls $Path /deny ($script:Me + ':' + $Spec) | Out-Null; if ($LASTEXITCODE -ne 0) { throw ('icacls deny 失败：' + $Path) } }
function Undeny([string]$Path) { icacls $Path /remove:d $script:Me | Out-Null }
function New-Repo([string]$Name, [switch]$Dirty) {
  $ErrorActionPreference = 'Stop'
  $r = Join-Path $script:Tmp $Name; $hooks = Join-Path $script:Tmp 'no-hooks'
  New-Item -ItemType Directory -Path $r, $hooks -Force | Out-Null
  & git -C $r init -q 2>$null; if ($LASTEXITCODE) { throw 'git init 失败' }
  'fixture' | Out-File -Encoding utf8 -LiteralPath (Join-Path $r 'f.txt')
  & git -C $r add f.txt 2>$null
  & git -C $r -c user.name=fixture -c user.email=fixture@localhost -c commit.gpgsign=false -c ('core.hooksPath=' + $hooks) commit -q -m fixture 2>$null
  if ($LASTEXITCODE) { throw 'git commit 失败' }
  if ($Dirty) { 'untracked' | Out-File -Encoding utf8 -LiteralPath (Join-Path $r 'new.txt') }
  return $r
}
$script:Repo = New-Repo 'repo'
$script:RepoHead = (& git -C $script:Repo rev-parse HEAD).Trim()
$script:RepoDirty = New-Repo 'repo-dirty' -Dirty
$script:RepoDirtyHead = (& git -C $script:RepoDirty rev-parse HEAD).Trim()

# 一个夹具 = 独立的 work/根/证据目录 + 夹具二进制（真实 hash）+ 夹具仓库 + 记录型进程源与启动器 + 固定时钟
function New-Fx([string]$Name, [switch]$NoRoot, [switch]$Marker) {
  $ErrorActionPreference = 'Stop'
  $d = Join-Path $script:Tmp $Name
  $fx = [pscustomobject]@{ Dir = $d; Work = (Join-Path $d 'work'); Root = (Join-Path $d 'work\localpost-e-test'); Evidence = (Join-Path $d 'evidence'); Bin = (Join-Path $d 'bin')
    Procs = (New-Object System.Collections.Generic.List[object]); Launches = (New-Object System.Collections.Generic.List[object]); ProbeCalls = 0; ProbeThrows = $false; Ctx = $null }
  New-Item -ItemType Directory -Path $fx.Work, $fx.Evidence, $fx.Bin -Force | Out-Null
  $files = [ordered]@{ exe = 'DeepSeek Harness.exe'; asar = 'app.asar'; node = 'node.exe'; profile = 'package.json' }
  $hash = @{ main = $script:RepoHead }; $paths = @{}
  foreach ($k in $files.Keys) { $p = Join-Path $fx.Bin $files[$k]; ('fixture ' + $k + ' ' + $Name) | Out-File -Encoding utf8 -LiteralPath $p; $paths[$k] = $p; $hash[$k] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
  if (-not $NoRoot) {
    New-Item -ItemType Directory -Path (Join-Path $fx.Root 'agents\dsh\inbox'), (Join-Path $fx.Root 'runtime\queues') -Force | Out-Null
    '{"agent":"dsh","seq":7,"pending":["codex-1"]}' | Out-File -Encoding utf8 -LiteralPath (Join-Path $fx.Root 'runtime\queues\dsh.json')
    if ($Marker) { 'localpost e-acceptance; fixture' | Out-File -Encoding utf8 -LiteralPath (Join-Path $fx.Root $script:EMarkerName) }
  }
  $self = $script:Self
  $fx.Ctx = @{
    Root = $fx.Root; WorkParent = $fx.Work; EvidenceDir = $fx.Evidence
    Exe = $paths.exe; Asar = $paths.asar; Node = $paths.node; Profile = $paths.profile; Repo = $script:Repo; Hash = $hash
    ProcessSource = { $fx.ProbeCalls++; if ($fx.ProbeThrows) { throw 'fixture enumeration exploded' }; $self; foreach ($p in $fx.Procs) { $p } }.GetNewClosure()
    Launch = { param($Exe, $EnvMap) $fx.Launches.Add([pscustomobject]@{ Exe = $Exe; Env = $EnvMap }); 4242 }.GetNewClosure()
    Clock = { [datetime]'2026-10-04T12:00:00' }
  }
  foreach ($k in 'Root', 'WorkParent', 'EvidenceDir') { if (-not (EGate-PathWithin $fx.Ctx[$k] $script:Tmp)) { throw ('夹具越界：' + $k) } }
  return $fx
}
function Node([int]$Id, $Cmd) { [pscustomobject]@{ ProcessId = $Id; Name = 'node.exe'; ExecutablePath = 'C:\Program Files\nodejs\node.exe'; CommandLine = $Cmd } }
# 目录快照：相对路径 + 文件内容 hash 与修改时间（可跨"旁移"比较字节是否完整）。目录只记结构：NTFS 父索引里的目录时间戳是延迟更新的，记了会抖动
function Snap([string]$Path) {
  $ErrorActionPreference = 'Stop'
  if ($null -eq (EGate-Attr $Path)) { return '<absent>' }
  $rows = foreach ($i in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop | Sort-Object FullName)) {
    $h = if ($i.PSIsContainer) { 'D' } else { (Get-FileHash -LiteralPath $i.FullName -Algorithm SHA256 -ErrorAction Stop).Hash + '|' + $i.LastWriteTimeUtc.Ticks }
    $i.FullName.Substring($Path.Length) + '|' + $h
  }
  return (@($rows) -join "`n")
}
function Backups($fx) { @(Get-ChildItem -LiteralPath $fx.Work -Force -Filter 'localpost-e-test.bak-*' -ErrorAction Stop) }
function EvidenceFiles($fx) { @(Get-ChildItem -LiteralPath $fx.Evidence -Force -ErrorAction Stop) }
function Assert-NoEEnv { Assert (@(Get-ChildItem Env: | Where-Object { $_.Name -like 'DSH_LOCALPOST_E_*' }).Count -eq 0) '测试进程出现了 DSH_LOCALPOST_E_* 环境变量' }
function Assert-Untouched($fx, [string]$Before, [int]$Probes) {
  Assert ($fx.Launches.Count -eq 0) ('launch 次数=' + $fx.Launches.Count)
  Assert-NoEEnv
  Assert ((Snap $fx.Root) -ceq $Before) '旧根字节/目录被改动'
  Assert ((Backups $fx).Count -eq 0) '出现了备份目录'
  Assert ($fx.ProbeCalls -eq $Probes) ('进程探测次数=' + $fx.ProbeCalls + '，期望 ' + $Probes)
}
# 生产入口副本在子 pwsh 里运行（同目录放桩库，绝不可能触达真实逻辑）
function Run-Wrapper([string]$Script, [string[]]$ArgList, [hashtable]$EnvSet) {
  $saved = @{}
  foreach ($k in $EnvSet.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, [string]$EnvSet[$k], 'Process') }
  try { $out = & $script:Pwsh -NoProfile -NonInteractive -File $Script @ArgList 2>&1; $code = $LASTEXITCODE }
  finally { foreach ($k in $saved.Keys) { if ($null -eq $saved[$k]) { [Environment]::SetEnvironmentVariable($k, [NullString]::Value, 'Process') } else { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } } }
  return [pscustomobject]@{ Code = $code; Out = (@($out) -join "`n") }
}
# canonical 根只读快照：根内全部条目（hash/大小/mtime/属性）+ work 下 localpost-e-test* 名 + 证据目录里的重建证据名
function Snap-Canonical {
  $ErrorActionPreference = 'Stop'
  $rows = New-Object System.Collections.Generic.List[string]
  $root = $script:ERootDefault
  $a = EGate-Attr $root
  $rows.Add('root|' + $a)
  if ($null -ne $a) {
    $rows.Add('rootmtime|' + (Get-Item -LiteralPath $root -Force -ErrorAction Stop).LastWriteTimeUtc.Ticks)
    foreach ($i in @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop | Sort-Object FullName)) {
      $h = if ($i.PSIsContainer) { 'D' } else { [string]$i.Length + ':' + (Get-FileHash -LiteralPath $i.FullName -Algorithm SHA256 -ErrorAction Stop).Hash }
      $rows.Add($i.FullName.Substring($root.Length) + '|' + $h + '|' + $i.LastWriteTimeUtc.Ticks + '|' + $i.Attributes)
    }
  }
  foreach ($i in @(Get-ChildItem -LiteralPath $script:EWorkDefault -Force -Filter 'localpost-e-test*' -ErrorAction Stop | Sort-Object Name)) { $rows.Add('work|' + $i.Name) }
  foreach ($i in @(Get-ChildItem -LiteralPath $script:EEvidenceDefault -Force -Filter 'e-test-root-before-rebuild-*' -ErrorAction Stop | Sort-Object Name)) { $rows.Add('evidence|' + $i.Name) }
  return ($rows -join "`n")
}
function Digest([string]$s) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($s))).ToLowerInvariant() }

$script:CanonBefore = Snap-Canonical
Write-Output ('CANONICAL-BEFORE lines=' + ($script:CanonBefore -split "`n").Count + ' sha256=' + (Digest $script:CanonBefore))

T '0 前置：测试进程没有 DSH_LOCALPOST_E_* 变量' { Assert-NoEEnv }

# ===================== 原 14 项（编号保留；断言具体原因。1a–1c 改测函数化后的真实 start→rebuild 串接与入口） =====================
T '1a rebuild 子步骤失败（队列文件被独占，无法取证）=> start 拒绝、launch=0、未注入环境、旧根原样' {
  $fx = New-Fx '1a'; $before = Snap $fx.Root
  $fs = [IO.File]::Open((Join-Path $fx.Root 'runtime\queues\dsh.json'), 'Open', 'Read', 'None')
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据枚举失败（原根未动）' | Out-Null } finally { $fs.Dispose() }
  Assert-Untouched $fx $before 2
  Assert ((EvidenceFiles $fx).Count -eq 0) '不应写出证据'
}
T '1b 生产入口找不到门禁库 => 非零退出（什么都没做）' {
  $d = Join-Path $script:Tmp 'wrap-nolib'; New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-isolated-e.ps1') -Destination $d -ErrorAction Stop
  $r = Run-Wrapper (Join-Path $d 'start-isolated-e.ps1') @('-RebuildRoot') @{}
  Assert ($r.Code -eq 1) ('exit=' + $r.Code)
  Assert ($r.Out -match '(?m)^X .*e-gates\.ps1') ('输出：' + $r.Out)
}
T '1c 首跑成功：真实 start→真实 rebuild；launch=1、7 项环境、旧根整体旁移且字节不变、证据完整、新根只剩标记' {
  $fx = New-Fx '1c'; $before = Snap $fx.Root
  $out = @(EGate-Start -Context $fx.Ctx -RebuildRoot)
  Assert ($fx.Launches.Count -eq 1) ('launch=' + $fx.Launches.Count)
  $l = $fx.Launches[0]; $e = $l.Env
  Assert ($l.Exe -ceq $fx.Ctx.Exe) 'launch exe 不符'
  Assert (@($e.Keys).Count -eq 7) ('环境变量个数=' + @($e.Keys).Count)
  Assert ($e.DSH_LOCALPOST_E_ENABLED -ceq '1' -and $e.DSH_LOCALPOST_E_ROOT -ceq $fx.Root -and $e.DSH_LOCALPOST_E_RUNTIME -ceq '0.2.0-rc.2' -and $e.DSH_LOCALPOST_E_ALLOW_FROM -ceq 'codex' -and $e.DSH_LOCALPOST_E_SCAN_MS -ceq '30000' -and $e.DSH_LOCALPOST_E_DEBOUNCE_MS -ceq '250') '环境变量值不符'
  Assert ($e.DSH_LOCALPOST_E_EVIDENCE -ceq ('precheck:exe ' + $fx.Ctx.Hash.exe + '; asar ' + $fx.Ctx.Hash.asar + '; node ' + $fx.Ctx.Hash.node + '; main ' + $script:RepoHead)) 'EVIDENCE 不符'
  Assert-NoEEnv
  $bak = Join-Path $fx.Work 'localpost-e-test.bak-20261004-120000'
  Assert ((Snap $bak) -ceq $before) '备份与旧根字节/目录不一致'
  $evl = @(Get-Content -LiteralPath (Join-Path $fx.Evidence 'e-test-root-before-rebuild-20261004-120000.txt') -ErrorAction Stop)
  $n = @(Get-ChildItem -LiteralPath $bak -Recurse -Force -ErrorAction Stop).Count
  Assert ($n -eq 6 -and $evl.Count -eq $n + 1 -and $evl[0] -match 'entries=6') ('证据行=' + $evl.Count + ' 条目=' + $n)
  $qh = (Get-FileHash -LiteralPath (Join-Path $bak 'runtime\queues\dsh.json') -Algorithm SHA256).Hash
  Assert ((@($evl) -join "`n").Contains($qh)) '证据缺队列文件 hash'
  $left = @(Get-ChildItem -LiteralPath $fx.Root -Force -ErrorAction Stop)
  Assert ($left.Count -eq 1 -and $left[0].Name -ceq '.e-acceptance' -and -not $left[0].PSIsContainer) '新根不是只含普通文件标记'
  Assert ($fx.ProbeCalls -eq 2) ('进程探测次数=' + $fx.ProbeCalls + '（start 与 rebuild 各一次）')
  Assert (($out -join "`n") -match 'OK 已启动，PID=4242') ('输出：' + ($out -join ' | '))
}
T '2a 进程枚举抛错 => 拒绝' { $fx = New-Fx '2a' -NoRoot; $fx.ProbeThrows = $true; Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } '^进程枚举失败（fail closed）：fixture enumeration exploded' | Out-Null }
T '2b 宿主候选路径不可读 => 拒绝，只报 PID 不带命令行' {
  $fx = New-Fx '2b' -NoRoot; $fx.Procs.Add([pscustomobject]@{ ProcessId = 123; Name = 'DeepSeek Harness.exe'; ExecutablePath = ''; CommandLine = 'SECRET-2b' })
  $m = Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } 'PID 123 桌面宿主候选的可执行路径不可读'
  Assert (-not $m.Contains('SECRET')) '错误信息泄露了命令行'
}
T '2c 宿主存在 => 拒绝' {
  $fx = New-Fx '2c' -NoRoot; $fx.Procs.Add([pscustomobject]@{ ProcessId = 111; Name = 'DeepSeek Harness.exe'; ExecutablePath = $fx.Ctx.Exe; CommandLine = 'x' })
  Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } 'PID 111 桌面宿主仍在运行' | Out-Null
}
T '2d 无宿主无 receiver（有无关 node）=> 放行' {
  $fx = New-Fx '2d' -NoRoot; $fx.Procs.Add((Node 4001 'node C:\tools\server.mjs --port 3000'))
  Assert ((EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited) -eq $true) '应放行'
  Assert ($fx.ProbeCalls -eq 1) '应恰好枚举一次'
}
T '2e 枚举结果不含本进程（被过滤/残缺）=> 拒绝' { $fx = New-Fx '2e' -NoRoot; $fx.Ctx.ProcessSource = { @() }; Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } '^进程枚举不含本进程' | Out-Null }
T '2f 进程名不可读 => 拒绝' { $fx = New-Fx '2f' -NoRoot; $fx.Procs.Add([pscustomobject]@{ ProcessId = 77; Name = $null }); Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } 'PID 77 进程名不可读' | Out-Null }
T '2g 重建未给 -ConfirmHostExited => 在任何探测/写入前拒绝' { $fx = New-Fx '2g'; $before = Snap $fx.Root; Refused { EGate-Rebuild -Context $fx.Ctx } '^缺少 -ConfirmHostExited' | Out-Null; Assert-Untouched $fx $before 0 }
T '3a receiver 指向根 => 拒绝' {
  $fx = New-Fx '3a'; $fx.Procs.Add((Node 222 ('node ' + $script:Cli.Replace('\', '/') + ' receive --root ' + $fx.Root.Replace('\', '/') + ' --agent dsh')))
  Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } 'PID 222 命令行参数指向该根' | Out-Null
}
T '4a exe hash 漂移 => 拒绝' { Refused { EGate-AssertHash 'C:\Windows\notepad.exe' 'deadbeef' 'exe' } '^exe hash 漂移：[0-9a-f]{64}$' | Out-Null }
T '4b 文件不存在 => 拒绝' { Refused { EGate-AssertHash (Join-Path $script:Tmp 'nope.exe') 'x' 'exe' } '^文件不存在：' | Out-Null }
T '4c 非 git 目录（即使位于别的仓库之内）=> 基线拒绝' { $d = Join-Path $script:Tmp '4c'; New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null; Refused { EGate-AssertBaseline $d $script:RepoHead } '^不是 git 仓库：' | Out-Null }
T '4d 正确 hash => 放行' { $h = (Get-FileHash 'C:\Windows\notepad.exe' -Algorithm SHA256).Hash.ToLowerInvariant(); Assert ((EGate-AssertHash 'C:\Windows\notepad.exe' $h 'exe') -ceq $h) '应返回同一 hash' }
T '4e 外层真仓库 + 内含空 .git 的子目录 => 基线拒绝（仓库根不符）' {
  # 不依赖 TempBase 恰好位于某个仓库里：这里自己造一个真正的外层仓库，
  # 再在其中放一个只有空 .git 的子目录，先断言 git 确实把它归到外层仓库，再断言门禁因根不符而拒绝。
  $outer = Join-Path $script:Tmp '4e-outer'; New-Item -ItemType Directory -Path $outer -Force -ErrorAction Stop | Out-Null
  & git -C $outer init --quiet 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('夹具：无法初始化外层仓库：' + $outer) }
  $inner = Join-Path $outer 'inner'; New-Item -ItemType Directory -Path (Join-Path $inner '.git') -Force -ErrorAction Stop | Out-Null
  $top = (& git -C $inner rev-parse --show-toplevel 2>$null)
  if ([string]::IsNullOrWhiteSpace($top)) { throw '夹具：git 未把子目录归到外层仓库' }
  Assert (([IO.Path]::GetFullPath($top).TrimEnd('\')) -eq ([IO.Path]::GetFullPath($outer).TrimEnd('\'))) '夹具应解析到外层仓库'
  Refused { EGate-AssertBaseline $inner $script:RepoHead } '^仓库根不符' | Out-Null
}
T '4f 夹具仓库干净且 HEAD 一致 => 放行（返回 HEAD）' { Assert ((EGate-AssertBaseline $script:Repo $script:RepoHead) -ceq $script:RepoHead) '应返回 HEAD' }
T '5a 根只含普通文件标记 => 放行' {
  $r = Join-Path $script:Tmp '5a'; New-Item -ItemType Directory -Path $r -ErrorAction Stop | Out-Null; 'm' | Out-File -LiteralPath (Join-Path $r '.e-acceptance')
  Assert ((EGate-AssertRootEmpty $r) -eq $true) '应放行'
}
T '5b 根有其它内容 => 拒绝' {
  $r = Join-Path $script:Tmp '5b'; New-Item -ItemType Directory -Path $r -ErrorAction Stop | Out-Null; 'm' | Out-File -LiteralPath (Join-Path $r '.e-acceptance'); '{}' | Out-File -LiteralPath (Join-Path $r 'leftover.json')
  Refused { EGate-AssertRootEmpty $r } '^根非空：.*leftover\.json' | Out-Null
}

# ===================== 空根判定只认根级普通文件标记 =====================
T '5c 根级同名"标记"是目录 => 拒绝' { $r = Join-Path $script:Tmp '5c'; New-Item -ItemType Directory -Path (Join-Path $r '.e-acceptance') -Force -ErrorAction Stop | Out-Null; Refused { EGate-AssertRootEmpty $r } '^根非空：.*\.e-acceptance' | Out-Null }
T '5d 根级同名"标记"是 junction => 拒绝' {
  $r = Join-Path $script:Tmp '5d'; $tgt = Join-Path $script:Tmp '5d-target'; New-Item -ItemType Directory -Path $r, $tgt -ErrorAction Stop | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $r '.e-acceptance') -Target $tgt -ErrorAction Stop | Out-Null
  Refused { EGate-AssertRootEmpty $r } '^根非空：.*\.e-acceptance' | Out-Null
}
T '5e 空根缺标记 => 拒绝' { $r = Join-Path $script:Tmp '5e'; New-Item -ItemType Directory -Path $r -ErrorAction Stop | Out-Null; Refused { EGate-AssertRootEmpty $r } '^根缺少根级普通文件标记' | Out-Null }
T '5f 根本身不可列（真实 ACL）=> 拒绝，不当空根' {
  $r = Join-Path $script:Tmp '5f'; New-Item -ItemType Directory -Path $r -ErrorAction Stop | Out-Null; 'm' | Out-File -LiteralPath (Join-Path $r '.e-acceptance'); '{}' | Out-File -LiteralPath (Join-Path $r 'queue.json')
  Deny $r '(RD)'
  try { Refused { EGate-AssertRootEmpty $r } 'denied|拒绝' | Out-Null } finally { Undeny $r }
}
T '5g 枚举只报非终止错误（遮蔽 Get-ChildItem 注入 Write-Error，复现 codex 用例）=> 拒绝' {
  $r = Join-Path $script:Tmp '5g'; New-Item -ItemType Directory -Path $r -ErrorAction Stop | Out-Null
  function Get-ChildItem { [CmdletBinding()] param([string]$LiteralPath, [switch]$Force, [switch]$Recurse) Write-Error 'fixture enumeration denied' }
  Refused { EGate-AssertRootEmpty $r } 'fixture enumeration denied' | Out-Null
}

# ===================== 启动链集成（真实 start→真实 rebuild；只 mock 进程源/启动器/时钟） =====================
T '6a 证据写入失败（证据目录拒写）=> 拒绝、launch=0、旧根原样、无备份' {
  $fx = New-Fx '6a'; $before = Snap $fx.Root
  Deny $fx.Evidence '(WD)'
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据写入失败（原根未动）' | Out-Null } finally { Undeny $fx.Evidence }
  Assert-Untouched $fx $before 2
}
T '6b 旁移失败（work 父目录拒绝新增子目录）=> 拒绝、launch=0、旧根原样且未被写入标记' {
  $fx = New-Fx '6b'; $before = Snap $fx.Root
  Deny $fx.Work '(AD)'
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^旁移失败（原根未动）' | Out-Null } finally { Undeny $fx.Work }
  Assert-Untouched $fx $before 2
  Assert ($null -eq (EGate-Attr (Join-Path $fx.Root '.e-acceptance'))) '旧根被写入了标记'
  Assert ((EvidenceFiles $fx).Count -eq 1) '旁移前应已落证据'
}
T '6c 旁移后新建失败（新根写不进标记）=> 拒绝、launch=0、备份字节完整、报错给出备份路径（可恢复）' {
  $fx = New-Fx '6c'; $before = Snap $fx.Root
  Deny $fx.Work '(OI)(CI)(IO)(WD)'
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^重建未完成：.*原根已完整旁移至 .*localpost-e-test\.bak-20261004-120000' | Out-Null } finally { Undeny $fx.Work }
  Assert ($fx.Launches.Count -eq 0) 'launch'
  Assert-NoEEnv
  Assert ((Snap (Join-Path $fx.Work 'localpost-e-test.bak-20261004-120000')) -ceq $before) '备份与旧根字节/目录不一致'
  Assert ($null -eq (EGate-Attr (Join-Path $fx.Root '.e-acceptance'))) '不应出现标记'
}
T '6d 文件系统枚举失败（根内子目录不可列）=> 拒绝、launch=0、未写证据、未旁移' {
  $fx = New-Fx '6d'; $locked = Join-Path $fx.Root 'agents\locked'
  New-Item -ItemType Directory -Path $locked -ErrorAction Stop | Out-Null; 'held' | Out-File -LiteralPath (Join-Path $locked 'held.json')
  $before = Snap $fx.Root
  Deny $locked '(RD)'
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据枚举失败（原根未动）' | Out-Null } finally { Undeny $locked }
  Assert-Untouched $fx $before 2
  Assert ((EvidenceFiles $fx).Count -eq 0) '不应写出证据'
}
T '6e 调用方 ErrorActionPreference 与 PSDefaultParameterValues 都设 SilentlyContinue，枚举失败仍阻断' {
  $fx = New-Fx '6e'; $locked = Join-Path $fx.Root 'agents\locked'
  New-Item -ItemType Directory -Path $locked -ErrorAction Stop | Out-Null; 'held' | Out-File -LiteralPath (Join-Path $locked 'held.json')
  $before = Snap $fx.Root
  Deny $locked '(RD)'
  $ErrorActionPreference = 'SilentlyContinue'; $PSDefaultParameterValues = @{ '*:ErrorAction' = 'SilentlyContinue' }
  try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据枚举失败（原根未动）' | Out-Null }
  finally { $ErrorActionPreference = 'Continue'; $PSDefaultParameterValues = @{}; Undeny $locked }
  Assert-Untouched $fx $before 2
}
T '6f 首跑时根不存在 => 新建根与标记、不旁移、不写证据、launch=1' {
  $fx = New-Fx '6f' -NoRoot
  @(EGate-Start -Context $fx.Ctx -RebuildRoot) | Out-Null
  Assert ($fx.Launches.Count -eq 1) 'launch'
  Assert ((Backups $fx).Count -eq 0 -and (EvidenceFiles $fx).Count -eq 0) '不应旁移/写证据'
  Assert ((EGate-AssertRootEmpty $fx.Root) -eq $true) '新根应只含标记'
}
T '6g 续跑：launch=1、根内字节不变（队列保留）、不旁移不写证据' {
  $fx = New-Fx '6g' -Marker; $before = Snap $fx.Root
  @(EGate-Start -Context $fx.Ctx -ContinueAcceptance) | Out-Null
  Assert ($fx.Launches.Count -eq 1 -and $fx.Launches[0].Env.DSH_LOCALPOST_E_ROOT -ceq $fx.Root) 'launch'
  Assert ((Snap $fx.Root) -ceq $before) '续跑改动了根内字节'
  Assert ((Backups $fx).Count -eq 0 -and (EvidenceFiles $fx).Count -eq 0) '续跑不应旁移/写证据'
  Assert-NoEEnv
}
T '6h 两个开关同时给 => 在任何探测/写入前拒绝' { $fx = New-Fx '6h' -Marker; $before = Snap $fx.Root; Refused { EGate-Start -Context $fx.Ctx -RebuildRoot -ContinueAcceptance } '互斥' | Out-Null; Assert-Untouched $fx $before 0; Assert ((EvidenceFiles $fx).Count -eq 0) '证据' }
T '6i 一个开关都不给 => 拒绝' { $fx = New-Fx '6i' -Marker; $before = Snap $fx.Root; Refused { EGate-Start -Context $fx.Ctx } '^必须显式选择' | Out-Null; Assert-Untouched $fx $before 0 }
T '6j1 续跑：缺标记 => 拒绝' { $fx = New-Fx '6j1'; $before = Snap $fx.Root; Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '缺 \.e-acceptance' | Out-Null; Assert-Untouched $fx $before 1 }
T '6j2 续跑：标记是目录 => 拒绝' { $fx = New-Fx '6j2'; New-Item -ItemType Directory -Path (Join-Path $fx.Root '.e-acceptance') -ErrorAction Stop | Out-Null; $before = Snap $fx.Root; Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '^标记不是普通文件' | Out-Null; Assert-Untouched $fx $before 1 }
T '6j3 续跑：标记是 junction => 拒绝' {
  $fx = New-Fx '6j3'; $tgt = Join-Path $fx.Dir 'elsewhere'; New-Item -ItemType Directory -Path $tgt -ErrorAction Stop | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $fx.Root '.e-acceptance') -Target $tgt -ErrorAction Stop | Out-Null
  Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '^标记' | Out-Null
  Assert ($fx.Launches.Count -eq 0) 'launch'
}
T '6j4 续跑：根本身是 junction（带合法标记）=> 拒绝' {
  $fx = New-Fx '6j4' -NoRoot; $real = Join-Path $fx.Dir 'real-root'; New-Item -ItemType Directory -Path $real -ErrorAction Stop | Out-Null; 'm' | Out-File -LiteralPath (Join-Path $real '.e-acceptance')
  New-Item -ItemType Junction -Path $fx.Root -Target $real -ErrorAction Stop | Out-Null
  Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '^路径链含重解析点：.*localpost-e-test$' | Out-Null
  Assert ($fx.Launches.Count -eq 0 -and $fx.ProbeCalls -eq 0) 'launch/探测'
}
T '6j5 续跑：work 父目录经 junction 到达 => 拒绝' {
  $fx = New-Fx '6j5' -Marker; $j = Join-Path $fx.Dir 'jwork'; New-Item -ItemType Junction -Path $j -Target $fx.Work -ErrorAction Stop | Out-Null
  $fx.Ctx.WorkParent = $j; $fx.Ctx.Root = Join-Path $j 'localpost-e-test'
  Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '^路径链含重解析点：.*jwork$' | Out-Null
  Assert ($fx.Launches.Count -eq 0 -and $fx.ProbeCalls -eq 0) 'launch/探测'
}
T '6j6 续跑：根内子目录是 junction（会把验收写入引到根外）=> 拒绝、根内不动' {
  $fx = New-Fx '6j6' -Marker; $outside = Join-Path $fx.Dir 'outside'; New-Item -ItemType Directory -Path $outside -ErrorAction Stop | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $fx.Root 'runtime\escape') -Target $outside -ErrorAction Stop | Out-Null
  $before = Snap $fx.Root
  Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } '^续跑根内含重解析点：.*escape$' | Out-Null
  Assert-Untouched $fx $before 1
}
T '6k1 重建：根本身是 junction => 拒绝，junction 与其目标都不动' {
  $fx = New-Fx '6k1' -NoRoot; $real = Join-Path $fx.Dir 'real-root'; New-Item -ItemType Directory -Path (Join-Path $real 'runtime') -Force -ErrorAction Stop | Out-Null; 'q' | Out-File -LiteralPath (Join-Path $real 'runtime\q.json')
  New-Item -ItemType Junction -Path $fx.Root -Target $real -ErrorAction Stop | Out-Null
  $before = Snap $real
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^路径链含重解析点：.*localpost-e-test$' | Out-Null
  Assert ((Snap $real) -ceq $before) 'junction 目标被改动'
  Assert ((EGate-Attr $fx.Root) -band [IO.FileAttributes]::ReparsePoint) 'junction 被移走'
  Assert ($fx.Launches.Count -eq 0 -and $fx.ProbeCalls -eq 0 -and (Backups $fx).Count -eq 0) 'launch/探测/备份'
}
T '6k2 重建：work 父目录经 junction 到达 => 拒绝（零写入）' {
  $fx = New-Fx '6k2'; $before = Snap $fx.Root; $j = Join-Path $fx.Dir 'jwork'; New-Item -ItemType Junction -Path $j -Target $fx.Work -ErrorAction Stop | Out-Null
  $fx.Ctx.WorkParent = $j; $fx.Ctx.Root = Join-Path $j 'localpost-e-test'
  Refused { EGate-Rebuild -Context $fx.Ctx -ConfirmHostExited } '^路径链含重解析点：.*jwork$' | Out-Null
  Assert-Untouched $fx $before 0
}
T '6l 备份目标已存在 => 拒绝（零写入）' {
  $fx = New-Fx '6l'; New-Item -ItemType Directory -Path (Join-Path $fx.Work 'localpost-e-test.bak-20261004-120000') -ErrorAction Stop | Out-Null; $before = Snap $fx.Root
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^备份目标已存在' | Out-Null
  Assert ($fx.Launches.Count -eq 0 -and (Snap $fx.Root) -ceq $before -and (EvidenceFiles $fx).Count -eq 0) 'launch/根/证据'
}
T '6m 证据目标已存在 => 拒绝（零写入）' {
  $fx = New-Fx '6m'; 'old' | Out-File -LiteralPath (Join-Path $fx.Evidence 'e-test-root-before-rebuild-20261004-120000.txt'); $before = Snap $fx.Root
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据目标已存在' | Out-Null
  Assert-Untouched $fx $before 2
}
T '6n 预检漂移（asar/node/profile/main/工作区脏）=> 在任何探测/写入前拒绝' {
  $cases = [ordered]@{
    'app.asar hash 漂移' = { param($fx) 'tamper' | Out-File -Append -LiteralPath $fx.Ctx.Asar }
    'node hash 漂移' = { param($fx) 'tamper' | Out-File -Append -LiteralPath $fx.Ctx.Node }
    'profile package.json hash 漂移' = { param($fx) 'tamper' | Out-File -Append -LiteralPath $fx.Ctx.Profile }
    '代码基线漂移' = { param($fx) $fx.Ctx.Hash.main = '0000000000000000000000000000000000000000' }
    '工作区不干净' = { param($fx) $fx.Ctx.Repo = $script:RepoDirty; $fx.Ctx.Hash.main = $script:RepoDirtyHead }
  }
  $i = 0
  foreach ($k in $cases.Keys) {
    $i++; $fx = New-Fx ('6n' + $i); $before = Snap $fx.Root; & $cases[$k] $fx
    try { Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } ('^' + [regex]::Escape($k)) | Out-Null; Assert-Untouched $fx $before 0 } catch { throw ($k + '：' + $_.Exception.Message) }
  }
}
T '6o 路径校验：根不是 work 的直接子目录 / 证据目录在根内 / .mailbox 路径 => 拒绝（零探测）' {
  $fx = New-Fx '6o1'; $fx.Ctx.Root = Join-Path $fx.Work 'nested\localpost-e-test'; Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^根必须是 work 父目录的直接子目录' | Out-Null
  $fx2 = New-Fx '6o2'; $fx2.Ctx.EvidenceDir = Join-Path $fx2.Root 'agents'; Refused { EGate-Start -Context $fx2.Ctx -RebuildRoot } '^证据目录不得位于根内' | Out-Null
  $fx3 = New-Fx '6o3'; $mb = Join-Path $fx3.Dir '.mailbox'; New-Item -ItemType Directory -Path $mb -ErrorAction Stop | Out-Null; $fx3.Ctx.WorkParent = $mb; $fx3.Ctx.Root = Join-Path $mb 'localpost-e-test'
  Refused { EGate-Start -Context $fx3.Ctx -RebuildRoot } '^拒绝生产路径' | Out-Null
  Assert (($fx.ProbeCalls + $fx2.ProbeCalls + $fx3.ProbeCalls) -eq 0 -and ($fx.Launches.Count + $fx2.Launches.Count + $fx3.Launches.Count) -eq 0) '探测/launch'
}

T '6p 证据回读条数不符（遮蔽 Get-Content 模拟落盘不完整）=> 拒绝、未旁移' {
  $fx = New-Fx '6p'; $before = Snap $fx.Root
  function Get-Content { [CmdletBinding()] param([string]$LiteralPath) 'only-one-line' }
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } '^证据回读条数不符' | Out-Null
  Assert-Untouched $fx $before 2
}
T '6q 启动器抛错 => start 抛出（不吞）；重建结果完整，可用 -ContinueAcceptance 续跑' {
  $fx = New-Fx '6q'; $fx.Ctx.Launch = { param($Exe, $EnvMap) throw 'fixture launch failed' }
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } 'fixture launch failed' | Out-Null
  Assert ((EGate-AssertRootEmpty $fx.Root) -eq $true) '重建结果应完整'
  Assert ((EGate-AssertContinuable $fx.Ctx) -eq $true) '应可续跑'
  Assert-NoEEnv
}
T '6r 续跑时宿主仍在运行 => 拒绝（续跑同样过停机门禁）' {
  $fx = New-Fx '6r' -Marker; $before = Snap $fx.Root
  $fx.Procs.Add([pscustomobject]@{ ProcessId = 6060; Name = 'DeepSeek Harness.exe'; ExecutablePath = $fx.Ctx.Exe; CommandLine = 'x' })
  Refused { EGate-Start -Context $fx.Ctx -ContinueAcceptance } 'PID 6060 桌面宿主仍在运行' | Out-Null
  Assert-Untouched $fx $before 1
}

# ===================== receiver 识别（原始进程记录 -> 真实过滤函数） =====================
T '7a 各种写法的命令行指向根 => 全部拒绝，且不泄露命令行' {
  $fx = New-Fx '7a'; $r = $fx.Root; $rf = $r.Replace('\', '/'); $cli = $script:Cli
  $cases = [ordered]@{
    'backslash'      = 'node.exe ' + $cli + ' receive --root ' + $r + ' --agent dsh SECRET-7a'
    'forward-slash'  = 'node ' + $cli.Replace('\', '/') + ' receive --root ' + $rf + ' --agent dsh SECRET-7a'
    'quoted-upper'   = '"C:\Program Files\nodejs\node.exe" "' + $cli.ToUpper() + '" receive --root "' + $r.ToUpper() + '" --agent dsh SECRET-7a'
    'trailing-sep'   = 'node ' + $cli + ' receive --root "' + $r + '\" --agent dsh SECRET-7a'
    'long-prefix'    = 'node ' + $cli + ' receive --root \\?\' + $r + ' --agent dsh SECRET-7a'
    'dot-segment'    = 'node ' + $cli + ' receive --root ' + $fx.Work + '\.\localpost-e-test --agent dsh SECRET-7a'
    'parent-segment' = 'node ' + $cli + ' receive --root ' + $fx.Work + '\..\work\localpost-e-test --agent dsh SECRET-7a'
    'equals-form'    = 'node C:\x\audit.mjs --root=' + $r + ' SECRET-7a'
    'file-url'       = 'node --import file:///' + $rf + '/hook.mjs C:\x\app.mjs SECRET-7a'
    'embedded-code'  = 'node -e "require(''fs'').writeFileSync(''' + $rf + '/runtime/x.json'',1)" SECRET-7a'
  }
  $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($r).ShortPath
  if ($short -ine $r) { $cases['short-8.3'] = 'node ' + $cli + ' receive --root ' + $short + ' --agent dsh SECRET-7a' } else { Write-Host 'NOTE 本卷未生成 8.3 短名，short-8.3 子例跳过' }
  foreach ($k in $cases.Keys) {
    $fx.Procs.Clear(); $fx.Procs.Add((Node 4000 $cases[$k]))
    try { $m = Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } 'PID 4000 (命令行参数指向该根|命令行引用该根)'; Assert (-not $m.Contains('SECRET')) '泄露命令行' } catch { throw ($k + '：' + $_.Exception.Message) }
  }
}
T '7b 命令行不可读（null/空/空白）=> 拒绝，只报 PID' {
  $fx = New-Fx '7b' -NoRoot
  foreach ($v in @($null, '', '   ')) { $fx.Procs.Clear(); $fx.Procs.Add((Node 4100 $v)); Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } '^停机门禁拒绝：PID 4100 命令行不可读（可能权限不足），无法排除$' | Out-Null }
}
T '7c receiver 入口无法证明根不同 => 拒绝（缺 --root / 相对 --root / --root 经 junction）' {
  $fx = New-Fx '7c'; $alias = Join-Path $fx.Dir 'alias'; New-Item -ItemType Junction -Path $alias -Target $fx.Root -ErrorAction Stop | Out-Null
  $cases = [ordered]@{
    'receiver 入口未给出 --root' = 'node ' + $script:Cli + ' receive --agent dsh --allow-from codex --enable'
    'receiver 入口 --root 不是绝对路径' = 'node ' + $script:Cli + ' receive --root . --agent dsh'
    'receiver 入口 --root 路径链含重解析点' = 'node ' + $script:Cli + ' receive --root ' + $alias + ' --agent dsh'
  }
  foreach ($k in $cases.Keys) { $fx.Procs.Clear(); $fx.Procs.Add((Node 4200 $cases[$k])); try { Refused { EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited } ('PID 4200 ' + [regex]::Escape($k)) | Out-Null } catch { throw ($k + '：' + $_.Exception.Message) } }
}
T '7d 可排除的 node 不误报：无关进程 / receiver 测试文件 / 指向其它根的 receiver / 前缀相似的兄弟目录' {
  $fx = New-Fx '7d'; $other = Join-Path $fx.Dir 'other-root'; New-Item -ItemType Directory -Path $other -ErrorAction Stop | Out-Null
  $cases = @(
    'node C:\tools\server.mjs --port 3000',
    'node --test C:\x\localpost\receiver.test.mjs',
    ('node ' + $script:Cli + ' receive --root ' + $other + ' --agent dsh --allow-from codex --enable'),
    ('node C:\x\tool.mjs ' + $fx.Root + '.bak-20261004-120000'),
    ('node C:\x\tool.mjs ' + $fx.Root + '2\file.json')
  )
  foreach ($c in $cases) { $fx.Procs.Clear(); $fx.Procs.Add((Node 4300 $c)); try { Assert ((EGate-AssertHostStopped -Context $fx.Ctx -ConfirmHostExited) -eq $true) '应放行' } catch { throw ($c + '：' + $_.Exception.Message) } }
}
T '7e 真实 start 链：反斜杠 receiver 在场 => 拒绝、launch=0、零写入' {
  $fx = New-Fx '7e'; $before = Snap $fx.Root; $fx.Procs.Add((Node 4400 ('node.exe ' + $script:Cli + ' receive --root ' + $fx.Root + ' --agent dsh')))
  Refused { EGate-Start -Context $fx.Ctx -RebuildRoot } 'PID 4400 命令行参数指向该根' | Out-Null
  Assert-Untouched $fx $before 1
}

# ===================== 隔离与生产入口 =====================
T '8a 夹具上下文触及 canonical work 目录（根/work/证据任一在其内，或是其祖先）=> 在任何探测/写入前拒绝' {
  $fx = New-Fx '8a' -NoRoot; $fx.ProbeThrows = $true   # 双保险：护栏若失效，进程门禁也会在任何写入前抛错（且被本用例判失败）
  $variants = @(
    @{ Root = $script:ERootDefault },
    @{ Root = $script:ERootDefault; WorkParent = $script:EWorkDefault },
    @{ EvidenceDir = $script:EEvidenceDefault },
    @{ EvidenceDir = 'C:\AI_ASSIST' },                # 祖先：证据会写进共享根（2026-09-13 同类事故）
    @{ Root = 'C:\AI_ASSIST'; WorkParent = 'C:\' }   # 祖先：旁移它会连带搬走整个 canonical work
  )
  foreach ($v in $variants) {
    $ctx = $fx.Ctx.Clone(); foreach ($k in $v.Keys) { $ctx[$k] = $v[$k] }
    Refused { EGate-Start -Context $ctx -RebuildRoot } '^夹具上下文触及 canonical work 目录' | Out-Null
    Refused { EGate-Rebuild -Context $ctx -ConfirmHostExited } '^夹具上下文触及 canonical work 目录' | Out-Null
    Refused { EGate-AssertContinuable $ctx } '^夹具上下文触及 canonical work 目录' | Out-Null
  }
  Assert ($fx.ProbeCalls -eq 0 -and $fx.Launches.Count -eq 0) ('探测=' + $fx.ProbeCalls + ' launch=' + $fx.Launches.Count)
}
T '8b 生产入口：只有规定开关；开关按命名开关原样交给库；库抛错 => exit 1（桩库副本，子进程）' {
  $d = Join-Path $script:Tmp 'wrap'; New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-isolated-e.ps1'), (Join-Path $PSScriptRoot 'rebuild-e-test-root.ps1') -Destination $d -ErrorAction Stop
  @'
function EGate-CanonicalContext { @{ Kind = 'stub-canonical' } }
function Stub-Log($o) { ($o | ConvertTo-Json -Compress) | Out-File -LiteralPath $env:EGATE_STUB_LOG -Append -Encoding utf8 }
function EGate-Start($Context, [switch]$RebuildRoot, [switch]$ContinueAcceptance) { Stub-Log ([ordered]@{ fn = 'start'; ctx = $Context.Kind; rebuild = [bool]$RebuildRoot; cont = [bool]$ContinueAcceptance; eap = [string]$ErrorActionPreference }); if ($env:EGATE_STUB_THROW) { throw 'stub failure' }; 'OK stub' }
function EGate-Rebuild($Context, [switch]$ConfirmHostExited) { Stub-Log ([ordered]@{ fn = 'rebuild'; ctx = $Context.Kind; confirm = [bool]$ConfirmHostExited; eap = [string]$ErrorActionPreference }); if ($env:EGATE_STUB_THROW) { throw 'stub failure' }; 'OK stub' }
'@ | Out-File -Encoding utf8 -LiteralPath (Join-Path $d 'e-gates.ps1')
  $log = Join-Path $d 'stub.log'
  $run = {
    param([string]$Script, [string[]]$ArgList, [hashtable]$Extra)
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -ErrorAction Stop }
    $set = @{ EGATE_STUB_LOG = $log }; if ($Extra) { foreach ($k in $Extra.Keys) { $set[$k] = $Extra[$k] } }
    $r = Run-Wrapper (Join-Path $d $Script) $ArgList $set
    $entries = if (Test-Path -LiteralPath $log) { @(Get-Content -LiteralPath $log | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() }
    [pscustomobject]@{ Code = $r.Code; Out = $r.Out; Log = $entries }
  }
  $a = & $run 'start-isolated-e.ps1' @('-RebuildRoot')
  Assert ($a.Code -eq 0 -and $a.Log.Count -eq 1 -and $a.Log[0].fn -eq 'start' -and $a.Log[0].ctx -eq 'stub-canonical' -and $a.Log[0].rebuild -eq $true -and $a.Log[0].cont -eq $false -and $a.Log[0].eap -eq 'Stop') ('start -RebuildRoot：' + ($a | ConvertTo-Json -Compress -Depth 4))
  $b = & $run 'start-isolated-e.ps1' @('-ContinueAcceptance')
  Assert ($b.Code -eq 0 -and $b.Log[0].rebuild -eq $false -and $b.Log[0].cont -eq $true) ('start -ContinueAcceptance：' + ($b | ConvertTo-Json -Compress -Depth 4))
  $c = & $run 'start-isolated-e.ps1' @('-RebuildRoot', '-ContinueAcceptance')
  Assert ($c.Log[0].rebuild -eq $true -and $c.Log[0].cont -eq $true) '双开关应原样交给库（由 EGate-Start 拒绝，见 6h）'
  foreach ($bad in @(@('-RebuildRoot', '-RootPath', 'C:\x'), @('-RebuildRoot', '-LaunchOverride', 'x'), @('-RebuildRoot', '-HostProbe', 'x'))) {
    $x = & $run 'start-isolated-e.ps1' $bad
    Assert ($x.Code -ne 0 -and $x.Log.Count -eq 0) ('start 接受了夹具参数 ' + $bad[1] + '：exit=' + $x.Code)
  }
  $f = & $run 'start-isolated-e.ps1' @('-RebuildRoot') @{ EGATE_STUB_THROW = '1' }
  Assert ($f.Code -eq 1 -and $f.Out -match '(?m)^X stub failure') ('库抛错应 exit 1：' + $f.Code + ' ' + $f.Out)
  $g = & $run 'rebuild-e-test-root.ps1' @('-ConfirmHostExited')
  Assert ($g.Code -eq 0 -and $g.Log[0].fn -eq 'rebuild' -and $g.Log[0].ctx -eq 'stub-canonical' -and $g.Log[0].confirm -eq $true -and $g.Log[0].eap -eq 'Stop') ('rebuild -ConfirmHostExited：' + ($g | ConvertTo-Json -Compress -Depth 4))
  $h = & $run 'rebuild-e-test-root.ps1' @()
  Assert ($h.Log[0].confirm -eq $false) '未给开关时 confirm 应为 false（由 EGate-Rebuild 拒绝，见 2g）'
  $w = & $run 'rebuild-e-test-root.ps1' @('-ConfirmHostExited', '-WorkParent', 'C:\x')
  Assert ($w.Code -ne 0 -and $w.Log.Count -eq 0) ('rebuild 接受了夹具参数 -WorkParent：exit=' + $w.Code)
}
T '8c canonical 上下文：路径与 R2 固定哈希不变；能通过护栏；生产进程源返回含本进程的原始记录（只读枚举）' {
  $c = EGate-CanonicalContext
  Assert ($c.Root -ceq 'C:\AI_ASSIST\work\localpost-e-test' -and $c.WorkParent -ceq 'C:\AI_ASSIST\work' -and $c.EvidenceDir -ceq 'C:\AI_ASSIST\work\localpost-six-gates-evidence') 'canonical 路径'
  Assert ($c.Hash.main -ceq '864b19612ad4da0d86209612b73d6cf758c15d66' -and $c.Hash.exe -ceq 'df4e91fd91f6f1bee19a1990b0e167bfe06abf8353279d82bbb8e60edb6ba0d3' -and $c.Hash.asar -ceq '983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2' -and $c.Hash.node -ceq '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5' -and $c.Hash.profile -ceq '598b9c1d8e7c8cb5658927a99cad0ad444dc05e305be25ce7272dc880fc2ffa7') '固定哈希被改'
  Assert ([object]::ReferenceEquals((EGate-ValidateContext $c), $c)) '生产上下文应通过护栏'
  $self = @(@(& $c.ProcessSource) | Where-Object { [string]$_.ProcessId -eq [string]$PID })
  Assert ($self.Count -eq 1 -and $self[0].Name -and $self[0].ExecutablePath -and $self[0].CommandLine) '生产进程源记录缺 Name/ExecutablePath/CommandLine'
}
T '8d 生产启动器：启动失败时也还原本进程环境（原有值复原、E 变量不残留；目标为不存在的路径，不启动任何进程）' {
  $missing = Join-Path $script:Tmp 'no-such-dir\no-such.exe'
  [Environment]::SetEnvironmentVariable('DSH_LOCALPOST_E_SCAN_MS', '999', 'Process')
  try {
    $c = EGate-CanonicalContext
    Refused { & $c.Launch $missing (EGate-EnvMap $c) } '.+' | Out-Null   # 判据是下面的环境状态，不是异常本身
    Assert ([Environment]::GetEnvironmentVariable('DSH_LOCALPOST_E_SCAN_MS', 'Process') -ceq '999') '原有值未还原'
    Assert ($null -eq [Environment]::GetEnvironmentVariable('DSH_LOCALPOST_E_ROOT', 'Process')) '残留 E 变量'
  } finally { [Environment]::SetEnvironmentVariable('DSH_LOCALPOST_E_SCAN_MS', [NullString]::Value, 'Process') }
  Assert-NoEEnv
}

T '9a canonical 根、其备份名、证据名前后完全一致（本轮未触碰真实根）' {
  $after = Snap-Canonical
  Write-Host ('CANONICAL-AFTER  lines=' + ($after -split "`n").Count + ' sha256=' + (Digest $after))
  Assert ($after -ceq $script:CanonBefore) 'canonical 状态变化'
}
Write-Output ('CANONICAL-AFTER  sha256=' + (Digest (Snap-Canonical)))

# ---------- 清理：撤销全部 deny ACE（含随目录移动的）、先拆 junction 再删目录 ----------
icacls $script:Tmp /remove:d $script:Me /T /C /Q 2>$null | Out-Null
Get-ChildItem -LiteralPath $script:Tmp -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { [IO.Directory]::Delete($_.FullName) }
Remove-Item -LiteralPath $script:Tmp -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $script:Tmp) { Write-Output ('WARN 临时目录未清净：' + $script:Tmp) }
Write-Output ('RESULT pass=' + $script:pass + ' fail=' + $script:fail)
if ($script:fail -gt 0) { exit 1 } else { exit 0 }