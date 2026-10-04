# e-gates.ps1 R3 —— live E 操作门禁库（被 start-isolated-e.ps1 / rebuild-e-test-root.ps1 dot-source）
# 设计原则：**证明不了就拒绝**（fail closed）。查询错误、身份不可读、候选无法排除 => 一律抛错，不得过滤成空集。
# 结构（R3）：生产入口只能构造 canonical 上下文（EGate-CanonicalContext）并调用 EGate-Start / EGate-Rebuild；
#   夹具测试把隔离路径、进程源、启动器、时钟放进上下文驱动同一组函数。夹具上下文的任何可写目标一旦触及
#   canonical work 目录即拒绝（EGate-ValidateContext），接缝因此不可能作用到真实根。
#   每个做 I/O 的函数都自设 $ErrorActionPreference='Stop' 并给 cmdlet 显式 -ErrorAction Stop：调用方是 Continue 也安全。

$script:EExeDefault = 'C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$script:EAsarDefault = 'C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
$script:ENodeDefault = 'C:\Program Files\nodejs\node.exe'
$script:EProfileDefault = 'C:\Users\16548\.dsh\profiles\desktop\package.json'
$script:ERepoDefault = 'C:\AI_ASSIST\tools\dsh-localpost-postmaster'
$script:ERootDefault = 'C:\AI_ASSIST\work\localpost-e-test'
$script:EWorkDefault = 'C:\AI_ASSIST\work'
$script:EEvidenceDefault = 'C:\AI_ASSIST\work\localpost-six-gates-evidence'
$script:EHash = @{
  exe     = 'df4e91fd91f6f1bee19a1990b0e167bfe06abf8353279d82bbb8e60edb6ba0d3'
  asar    = '983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2'
  node    = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
  profile = '598b9c1d8e7c8cb5658927a99cad0ad444dc05e305be25ce7272dc880fc2ffa7'
  main    = '3684e84e908801f3088ddaad37d3939b4eb3990e'
}
$script:EMarkerName = '.e-acceptance'
$script:ERuntime = '0.2.0-rc.2'
$script:ECtxPaths = @('Root', 'WorkParent', 'EvidenceDir', 'Exe', 'Asar', 'Node', 'Profile', 'Repo')
$script:ECtxSeams = @('ProcessSource', 'Launch', 'Clock')
$script:ECtxHashes = @('exe', 'asar', 'node', 'profile', 'main')

# 生产接缝（单例；夹具上下文若触及 canonical work 目录，必须与它们引用相等，见 EGate-ValidateContext）
$script:EProcessSource = { Get-CimInstance -ClassName Win32_Process -ErrorAction Stop }
$script:ELaunch = {
  param([string]$Exe, [System.Collections.IDictionary]$EnvMap)
  # 仅在启动瞬间写入本进程环境（子进程继承），启动后立即还原：不持久化、不污染调用会话
  $saved = @{}
  try {
    foreach ($k in @($EnvMap.Keys)) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, [string]$EnvMap[$k], 'Process') }
    $p = Start-Process -FilePath $Exe -PassThru -ErrorAction Stop
    return $p.Id
  } finally {
    # 原本不存在的变量必须删除：PowerShell 把 $null 传给 .NET string 参数会变成 ""，.NET 9+ 会留下空值变量，只有 [NullString]::Value 才是真删除
    foreach ($k in @($saved.Keys)) { if ($null -eq $saved[$k]) { [Environment]::SetEnvironmentVariable($k, [NullString]::Value, 'Process') } else { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') } }
  }
}
$script:EClock = { Get-Date }

function EGate-Fail([string]$m) { throw [System.InvalidOperationException]::new($m) }

# ---------- 路径工具 ----------
# 属性；不存在返回 $null；其它错误（权限等）原样抛出 => 调用者 fail closed（不把"读不到"当"不存在"）
function EGate-Attr([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}
function EGate-PathWithin([string]$Path, [string]$Root) {
  $p = [IO.Path]::GetFullPath($Path).TrimEnd('\'); $r = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return ($p -ieq $r) -or $p.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)
}
function EGate-SamePath([string]$A, [string]$B) {
  try { return [IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\') } catch { return $A -ieq $B }
}
# 自身及全部祖先（直到盘符根）不得是重解析点；不存在的末端允许（首跑时根可不存在）
function EGate-AssertNoReparseChain([string]$Path) {
  $p = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrEmpty($p)) {
    $a = EGate-Attr $p
    if ($null -ne $a -and ($a -band [IO.FileAttributes]::ReparsePoint)) { EGate-Fail ('路径链含重解析点：' + $p) }
    $p = [IO.Path]::GetDirectoryName($p)
  }
}
function EGate-ChainHasReparse([string]$Path) { try { EGate-AssertNoReparseChain $Path; return $false } catch { return $true } }
function EGate-AssertRealDir([string]$Path, [string]$Label) {
  $a = EGate-Attr $Path
  if ($null -eq $a) { EGate-Fail ($Label + '不存在：' + $Path) }
  if (-not ($a -band [IO.FileAttributes]::Directory)) { EGate-Fail ($Label + '不是目录：' + $Path) }
  if ($a -band [IO.FileAttributes]::ReparsePoint) { EGate-Fail ($Label + '是重解析点：' + $Path) }
}

# ---------- 上下文 ----------
function EGate-CanonicalContext {
  return @{
    Root = $script:ERootDefault; WorkParent = $script:EWorkDefault; EvidenceDir = $script:EEvidenceDefault
    Exe = $script:EExeDefault; Asar = $script:EAsarDefault; Node = $script:ENodeDefault; Profile = $script:EProfileDefault; Repo = $script:ERepoDefault
    Hash = $script:EHash.Clone(); ProcessSource = $script:EProcessSource; Launch = $script:ELaunch; Clock = $script:EClock
  }
}
function EGate-ValidateContext($Context) {
  if ($Context -isnot [System.Collections.IDictionary] -or $Context.Hash -isnot [System.Collections.IDictionary]) { EGate-Fail '上下文无效（须由 EGate-CanonicalContext 或测试夹具构造）' }
  foreach ($k in $script:ECtxPaths) {
    $v = [string]$Context[$k]
    if ([string]::IsNullOrWhiteSpace($v) -or -not [IO.Path]::IsPathFullyQualified($v) -or [IO.Path]::GetFullPath($v) -cne $v) { EGate-Fail ('上下文路径 ' + $k + ' 必须是规范化绝对路径') }
  }
  foreach ($k in $script:ECtxSeams) { if ($Context[$k] -isnot [scriptblock]) { EGate-Fail ('上下文缺少 ' + $k) } }
  foreach ($k in $script:ECtxHashes) { if ([string]::IsNullOrWhiteSpace([string]$Context.Hash[$k])) { EGate-Fail ('上下文缺少预期哈希 ' + $k) } }
  # 夹具隔离：可写目标与 canonical work 目录有任何包含关系（在其内，或是其祖先——旁移祖先会连带搬走整个 work）时，
  # 整个上下文必须逐项等于生产上下文（真实进程源/启动器/时钟、固定路径与哈希）
  $canon = EGate-CanonicalContext
  $touches = $false
  foreach ($k in 'Root', 'WorkParent', 'EvidenceDir') { if ((EGate-PathWithin $Context[$k] $canon.WorkParent) -or (EGate-PathWithin $canon.WorkParent $Context[$k])) { $touches = $true } }
  if ($touches) {
    $same = $true
    foreach ($k in $script:ECtxPaths) { if ([string]$Context[$k] -cne $canon[$k]) { $same = $false } }
    foreach ($k in $script:ECtxHashes) { if ([string]$Context.Hash[$k] -cne $canon.Hash[$k]) { $same = $false } }
    foreach ($k in $script:ECtxSeams) { if (-not [object]::ReferenceEquals($Context[$k], $canon[$k])) { $same = $false } }
    if (-not $same) { EGate-Fail '夹具上下文触及 canonical work 目录：拒绝（接缝不得作用于真实根）' }
  }
  return $Context
}
# 路径校验（重建与续跑共用，不写任何东西）：根=work 的直接子目录；根/work/证据目录及其全部祖先无重解析点；证据目录不在根内
function EGate-Layout($Context) {
  $ErrorActionPreference = 'Stop'
  $root = [string]$Context.Root; $work = ([string]$Context.WorkParent).TrimEnd('\'); $evd = [string]$Context.EvidenceDir
  foreach ($p in @($root, $work, $evd)) { if ($p -like '*\.mailbox*') { EGate-Fail ('拒绝生产路径：' + $p) } }
  if (-not ([IO.Path]::GetDirectoryName($root) -ieq $work)) { EGate-Fail ('根必须是 work 父目录的直接子目录：' + $root) }
  $leaf = [IO.Path]::GetFileName($root)
  if ([string]::IsNullOrWhiteSpace($leaf)) { EGate-Fail ('根路径无效：' + $root) }
  EGate-AssertNoReparseChain $root
  EGate-AssertRealDir $work 'work 父目录'
  EGate-AssertNoReparseChain $evd
  EGate-AssertRealDir $evd '证据目录'
  if (EGate-PathWithin $evd $root) { EGate-Fail ('证据目录不得位于根内：' + $evd) }
  $ra = EGate-Attr $root
  if ($null -ne $ra -and -not ($ra -band [IO.FileAttributes]::Directory)) { EGate-Fail ('根不是目录：' + $root) }
  return [pscustomobject]@{ Root = $root; Work = $work; Evidence = $evd; Leaf = $leaf; Marker = (Join-Path $root $script:EMarkerName) }
}

# ---------- 预检：hash / 代码基线 ----------
function EGate-FileHash([string]$Path) {
  $ErrorActionPreference = 'Stop'
  $a = EGate-Attr $Path
  if ($null -eq $a) { EGate-Fail ('文件不存在：' + $Path) }
  if ($a -band [IO.FileAttributes]::Directory) { EGate-Fail ('不是文件：' + $Path) }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function EGate-AssertHash([string]$Path, [string]$Expected, [string]$Label) {
  $h = EGate-FileHash $Path
  if ([string]::IsNullOrWhiteSpace($Expected) -or $h -ne $Expected.ToLowerInvariant()) { EGate-Fail ($Label + ' hash 漂移：' + $h) }
  return $h
}
function EGate-AssertBaseline([string]$RepoPath = $script:ERepoDefault, [string]$Expected = $script:EHash.main) {
  $ErrorActionPreference = 'Stop'
  if ($null -eq (EGate-Attr (Join-Path $RepoPath '.git'))) { EGate-Fail ('不是 git 仓库：' + $RepoPath) }
  $top = @(& git -C $RepoPath rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -ne 0 -or $top.Count -ne 1) { EGate-Fail ('git rev-parse --show-toplevel 失败：' + $RepoPath) }
  if (-not (EGate-SamePath $top[0] $RepoPath)) { EGate-Fail ('仓库根不符（' + $top[0] + '）：' + $RepoPath) }
  $sha = @(& git -C $RepoPath rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or $sha.Count -ne 1) { EGate-Fail 'git rev-parse HEAD 失败' }
  if ($sha[0].Trim() -ne $Expected) { EGate-Fail ('代码基线漂移：' + $sha[0].Trim() + ' != ' + $Expected) }
  $dirty = @(& git -C $RepoPath status --porcelain --untracked-files=normal 2>$null)
  if ($LASTEXITCODE -ne 0) { EGate-Fail 'git status 失败' }
  if ($dirty.Count -ne 0) { EGate-Fail '工作区不干净（拒绝在漂移基线上启动）' }
  return $sha[0].Trim()
}

# ---------- 进程门禁：宿主 + 独立 receiver ----------
# 按 Windows 规则粗切命令行（双引号成组、去引号）；只用于找路径与入口，文本兜底见 EGate-TextMentionsRoot
function EGate-SplitCommandLine([string]$CommandLine) {
  $tokens = New-Object System.Collections.Generic.List[string]
  $sb = New-Object System.Text.StringBuilder
  $inQ = $false; $has = $false
  foreach ($ch in $CommandLine.ToCharArray()) {
    if ($ch -eq [char]'"') { $inQ = -not $inQ; $has = $true; continue }
    if (-not $inQ -and [char]::IsWhiteSpace($ch)) { if ($has) { $tokens.Add($sb.ToString()); [void]$sb.Clear(); $has = $false }; continue }
    [void]$sb.Append($ch); $has = $true
  }
  if ($has) { $tokens.Add($sb.ToString()) }
  return $tokens.ToArray()
}
# 从一个参数里取出绝对盘符路径（含 --x=PATH、file:/// URL、\\?\ 前缀），GetFullPath 统一斜杠/点段/尾点并展开已存在的 8.3 短名
function EGate-PathCandidates([string]$Token) {
  $out = New-Object System.Collections.Generic.List[string]
  $parts = @($Token)
  $eq = $Token.IndexOf('=')
  if ($eq -ge 0) { $parts += $Token.Substring($eq + 1) }
  foreach ($p in $parts) {
    $s = $p.Trim().Trim("'")
    if ($s -match '^(?i)file:/+') { $s = [Uri]::UnescapeDataString(($s -replace '^(?i)file:/+', '')) }
    $s = $s -replace '^[\\/]{2}[?.][\\/]', ''
    if ($s -match '^[A-Za-z]:[\\/]') { try { $out.Add([IO.Path]::GetFullPath($s)) } catch { } }
  }
  return $out.ToArray()
}
function EGate-NormText([string]$s) { return (($s.ToLowerInvariant().Replace('\', '/') -replace '["'']', '') -replace '/{2,}', '/') }
# 文本兜底：统一大小写/斜杠/引号后，根后面紧跟非路径名字符（或结束）即视为引用该根（覆盖嵌在代码串等非独立参数里的情形）
function EGate-TextMentionsRoot([string]$Text, [string]$RootPath) {
  $t = EGate-NormText $Text
  $r = (EGate-NormText $RootPath).TrimEnd('/')
  $i = $t.IndexOf($r, [StringComparison]::Ordinal)
  while ($i -ge 0) {
    $j = $i + $r.Length
    if ($j -ge $t.Length -or ([string]$t[$j]) -notmatch '[\p{L}\p{N}_.~$#@+\-]') { return $true }
    $i = $t.IndexOf($r, $i + 1, [StringComparison]::Ordinal)
  }
  return $false
}
# node 候选判定：返回 $null = 可排除；否则返回拒绝原因（只描述原因，绝不带命令行内容）
function EGate-NodeVerdict([string]$CommandLine, [string]$RootPath) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '命令行不可读（可能权限不足），无法排除' }
  $tokens = @(EGate-SplitCommandLine $CommandLine)
  foreach ($tk in $tokens) { foreach ($c in @(EGate-PathCandidates $tk)) { if (EGate-PathWithin $c $RootPath) { return '命令行参数指向该根' } } }
  if (EGate-TextMentionsRoot $CommandLine $RootPath) { return '命令行引用该根' }
  # 真实 receiver 入口 = localpost/receiver-cli.mjs（status|receive --root PATH）；其根必须能从命令行证明不是该根
  $entry = -1
  for ($i = 0; $i -lt $tokens.Count; $i++) { if ((($tokens[$i] -replace '^(?i)file:/+', '').Replace('\', '/')) -match '(^|/)receiver-cli\.mjs$') { $entry = $i; break } }
  if ($entry -lt 0) { return $null }
  $k = [array]::IndexOf($tokens, '--root', $entry + 1)
  if ($k -lt 0 -or $k + 1 -ge $tokens.Count) { return 'receiver 入口未给出 --root，无法排除' }
  $c = @(EGate-PathCandidates $tokens[$k + 1])
  if ($c.Count -eq 0) { return 'receiver 入口 --root 不是绝对路径，无法排除' }
  if (EGate-ChainHasReparse $c[0]) { return 'receiver 入口 --root 路径链含重解析点，无法排除' }
  return $null
}
# 对一次完整枚举的原始记录逐条判定（宿主 / receiver / 无法分类），返回全部拒绝项
function EGate-ScanProcesses($Processes, [string]$ExePath, [string]$RootPath) {
  $found = New-Object System.Collections.Generic.List[object]
  foreach ($p in @($Processes)) {
    if ($null -eq $p) { continue }
    $id = $p.ProcessId; $name = [string]$p.Name; $exe = [string]$p.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($name)) { $found.Add([pscustomobject]@{ Id = $id; Reason = '进程名不可读，无法排除' }); continue }
    if ($name -like 'DeepSeek*' -and [string]::IsNullOrWhiteSpace($exe)) { $found.Add([pscustomobject]@{ Id = $id; Reason = '桌面宿主候选的可执行路径不可读，无法排除' }); continue }
    if (-not [string]::IsNullOrWhiteSpace($exe) -and (EGate-SamePath $exe $ExePath)) { $found.Add([pscustomobject]@{ Id = $id; Reason = '桌面宿主仍在运行（不自动强杀）' }); continue }
    if ($name -like 'node*') {
      $v = EGate-NodeVerdict ([string]$p.CommandLine) $RootPath
      if ($v) { $found.Add([pscustomobject]@{ Id = $id; Reason = $v }) }
    }
  }
  return $found.ToArray()
}
# 停机门禁：显式确认 + 枚举成功且含本进程 + 无宿主 + 无可能作用于该根的 node/receiver
function EGate-AssertHostStopped($Context, [switch]$ConfirmHostExited) {
  $ErrorActionPreference = 'Stop'
  if (-not $ConfirmHostExited) { EGate-Fail '缺少 -ConfirmHostExited（拒绝在未确认宿主退出时操作）' }
  try { $procs = @(& $Context.ProcessSource) } catch { EGate-Fail ('进程枚举失败（fail closed）：' + $_.Exception.Message) }
  if (@($procs | Where-Object { $null -ne $_ -and [string]$_.ProcessId -eq [string]$PID }).Count -eq 0) { EGate-Fail ('进程枚举不含本进程（PID ' + $PID + '）：枚举不可信，fail closed') }
  $f = @(EGate-ScanProcesses -Processes $procs -ExePath $Context.Exe -RootPath $Context.Root)
  if ($f.Count -gt 0) { EGate-Fail ('停机门禁拒绝：' + (($f | ForEach-Object { 'PID ' + $_.Id + ' ' + $_.Reason }) -join '；')) }
  return $true
}

# ---------- 根状态 ----------
# 重建后置条件：根是真实目录，根级恰好只有一个普通文件标记（目录/重解析点同名项都不算），且非递归即可判定
function EGate-AssertRootEmpty([string]$RootPath) {
  $ErrorActionPreference = 'Stop'
  EGate-AssertRealDir $RootPath '根'
  $items = @(Get-ChildItem -LiteralPath $RootPath -Force -ErrorAction Stop)
  $marker = $false
  foreach ($i in $items) {
    if ($i.Name -ieq $script:EMarkerName -and -not $i.PSIsContainer -and -not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $marker = $true; continue }
    EGate-Fail ('根非空：' + $i.FullName)
  }
  if (-not $marker) { EGate-Fail ('根缺少根级普通文件标记 ' + $script:EMarkerName + '：' + $RootPath) }
  return $true
}
function EGate-AssertMarker([string]$RootPath) {
  $m = Join-Path $RootPath $script:EMarkerName
  $a = EGate-Attr $m
  if ($null -eq $a) { EGate-Fail ('续跑要求已标记的验收根（缺 ' + $script:EMarkerName + '）；首次验收请用 -RebuildRoot') }
  if ($a -band [IO.FileAttributes]::Directory) { EGate-Fail ('标记不是普通文件（是目录）：' + $m) }
  if ($a -band [IO.FileAttributes]::ReparsePoint) { EGate-Fail ('标记是重解析点：' + $m) }
}
# 续跑：规范路径（上下文校验）+ 祖先链无重解析点 + 根是真实目录 + 根级普通文件标记 + 根内任何位置无重解析点；不改动根内任何字节
function EGate-AssertContinuable($Context) {
  $ErrorActionPreference = 'Stop'
  $c = EGate-ValidateContext $Context
  $L = EGate-Layout $c
  EGate-AssertRealDir $L.Root '续跑根'
  EGate-AssertMarker $L.Root
  # 根内的 junction/符号链接会把验收写入引到根外（例如生产 .mailbox）：一律拒绝；枚举不完整同样拒绝
  try { $rp = @(Get-ChildItem -LiteralPath $L.Root -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop) } catch { EGate-Fail ('续跑根枚举失败（fail closed）：' + $_.Exception.Message) }
  if ($rp.Count -gt 0) { EGate-Fail ('续跑根内含重解析点：' + $rp[0].FullName) }
  return $true
}

# ---------- 重建 ----------
# 顺序保证可恢复：全部校验 -> 停机门禁 -> 证据完整落盘并回读 -> 同卷改名旁移（失败则原根不动）-> 新建根与标记 -> 后置条件
function EGate-Rebuild($Context, [switch]$ConfirmHostExited) {
  $ErrorActionPreference = 'Stop'
  if (-not $ConfirmHostExited) { EGate-Fail '缺少 -ConfirmHostExited（拒绝在未确认宿主退出时操作）' }
  $c = EGate-ValidateContext $Context
  $L = EGate-Layout $c
  EGate-AssertHostStopped -Context $c -ConfirmHostExited | Out-Null
  $stamp = ([datetime](& $c.Clock)).ToString('yyyyMMdd-HHmmss')
  $backup = Join-Path $L.Work ($L.Leaf + '.bak-' + $stamp)
  $evFile = Join-Path $L.Evidence ('e-test-root-before-rebuild-' + $stamp + '.txt')
  if ($null -ne (EGate-Attr $backup)) { EGate-Fail ('备份目标已存在：' + $backup) }
  if ($null -ne (EGate-Attr $evFile)) { EGate-Fail ('证据目标已存在：' + $evFile) }
  $moved = $false
  if ($null -ne (EGate-Attr $L.Root)) {
    EGate-AssertRealDir $L.Root '根'
    $lines = New-Object System.Collections.Generic.List[string]
    try {
      $items = @(Get-ChildItem -LiteralPath $L.Root -Recurse -Force -ErrorAction Stop)
      $lines.Add('# root=' + $L.Root + ' backup=' + $backup + ' entries=' + $items.Count + ' stamp=' + $stamp)
      foreach ($i in $items) {
        $h = ''; if (-not $i.PSIsContainer) { $h = (Get-FileHash -LiteralPath $i.FullName -Algorithm SHA256 -ErrorAction Stop).Hash }
        $lines.Add($i.FullName + '|' + $i.Length + '|' + $i.LastWriteTime.ToString('o') + '|' + $i.Attributes + '|' + $h)
      }
    } catch { EGate-Fail ('证据枚举失败（原根未动）：' + $_.Exception.Message) }
    try {
      $lines | Out-File -LiteralPath $evFile -Encoding utf8 -NoClobber -ErrorAction Stop
      $back = @(Get-Content -LiteralPath $evFile -ErrorAction Stop)
    } catch { EGate-Fail ('证据写入失败（原根未动）：' + $_.Exception.Message) }
    if ($back.Count -ne $lines.Count) { EGate-Fail ('证据回读条数不符（' + $back.Count + '/' + $lines.Count + '，原根未动）：' + $evFile) }
    'OK 证据：' + $evFile + '（' + $items.Count + ' 条）'
    # 同卷改名：目标已存在或根内有占用句柄即抛错，且不会"移入"已有目录；失败时原根原样
    try { [IO.Directory]::Move($L.Root, $backup) } catch { $e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }; EGate-Fail ('旁移失败（原根未动）：' + $e.Message) }
    $moved = $true
    'OK 旁移 -> ' + $backup
  } else { 'OK 源不存在：无需旁移' }
  try {
    New-Item -ItemType Directory -Path $L.Root -ErrorAction Stop | Out-Null
    New-Item -ItemType File -Path $L.Marker -Value ('localpost e-acceptance; stamp=' + $stamp + '; backup=' + $(if ($moved) { $backup } else { '(none)' })) -ErrorAction Stop | Out-Null
    EGate-AssertRootEmpty $L.Root | Out-Null
  } catch {
    $state = if ($moved) { '原根已完整旁移至 ' + $backup + '（未删除、未改写）' } else { '原根本不存在' }
    EGate-Fail ('重建未完成：' + $_.Exception.Message + '；' + $state + '；未启动。恢复见 live-e-handoff.md「恢复」')
  }
  'OK 重建完成（仅含 ' + $script:EMarkerName + ' 标记）'
}

# ---------- 启动 ----------
function EGate-EnvMap($Context) {
  return [ordered]@{
    DSH_LOCALPOST_E_ENABLED     = '1'
    DSH_LOCALPOST_E_ROOT        = [string]$Context.Root
    DSH_LOCALPOST_E_RUNTIME     = $script:ERuntime
    DSH_LOCALPOST_E_EVIDENCE    = ('precheck:exe ' + $Context.Hash.exe + '; asar ' + $Context.Hash.asar + '; node ' + $Context.Hash.node + '; main ' + $Context.Hash.main)
    DSH_LOCALPOST_E_ALLOW_FROM  = 'codex'
    DSH_LOCALPOST_E_SCAN_MS     = '30000'
    DSH_LOCALPOST_E_DEBOUNCE_MS = '250'
  }
}
# 启动链：模式（互斥、必须显式）-> 上下文/路径 -> 四项预检 -> 停机门禁 -> 重建（同进程函数，命名开关）或续跑校验 -> 外层独立复核 -> 启动
# 任何一步抛错即终止本函数：不构造/不传递 E 变量，不调用启动器。
function EGate-Start($Context, [switch]$RebuildRoot, [switch]$ContinueAcceptance) {
  $ErrorActionPreference = 'Stop'
  if ($RebuildRoot -and $ContinueAcceptance) { EGate-Fail '-RebuildRoot 与 -ContinueAcceptance 互斥：首次验收只用 -RebuildRoot，续跑只用 -ContinueAcceptance' }
  if (-not $RebuildRoot -and -not $ContinueAcceptance) { EGate-Fail '必须显式选择 -RebuildRoot（首次）或 -ContinueAcceptance（续跑）' }
  $c = EGate-ValidateContext $Context
  $L = EGate-Layout $c
  EGate-AssertHash $c.Exe $c.Hash.exe 'exe' | Out-Null
  EGate-AssertHash $c.Asar $c.Hash.asar 'app.asar' | Out-Null
  EGate-AssertHash $c.Node $c.Hash.node 'node' | Out-Null
  EGate-AssertHash $c.Profile $c.Hash.profile 'profile package.json' | Out-Null
  EGate-AssertBaseline $c.Repo $c.Hash.main | Out-Null
  'OK 预检通过（exe/asar/node/profile/main）'
  EGate-AssertHostStopped -Context $c -ConfirmHostExited | Out-Null
  'OK 停机门禁通过'
  if ($RebuildRoot) {
    EGate-Rebuild -Context $c -ConfirmHostExited
    EGate-AssertRootEmpty $L.Root | Out-Null
    'OK 重建后置条件通过'
  } else {
    EGate-AssertContinuable $c | Out-Null
    'OK 续跑同一验收（不重建、不动既有队列）'
  }
  $launched = & $c.Launch $c.Exe (EGate-EnvMap $c)
  'OK 已启动，PID=' + $launched
}
