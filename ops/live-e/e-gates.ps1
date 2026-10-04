# e-gates.ps1 —— live E 操作门禁库（被 rebuild/start 两个脚本 dot-source）
# 设计原则：**证明不了就拒绝**（fail closed）。查询错误、身份不可读、候选无法排除 => 一律拒绝，不得过滤成空集。

$script:EExeDefault = 'C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$script:EAsarDefault = 'C:\Users\16548\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
$script:ENodeDefault = 'C:\Program Files\nodejs\node.exe'
$script:EProfileDefault = 'C:\Users\16548\.dsh\profiles\desktop\package.json'
$script:ERepoDefault = 'C:\AI_ASSIST\tools\dsh-localpost-postmaster'
$script:ERootDefault = 'C:\AI_ASSIST\work\localpost-e-test'
$script:EHash = @{
  exe     = 'df4e91fd91f6f1bee19a1990b0e167bfe06abf8353279d82bbb8e60edb6ba0d3'
  asar    = '983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2'
  node    = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
  profile = '598b9c1d8e7c8cb5658927a99cad0ad444dc05e305be25ce7272dc880fc2ffa7'
  main    = '864b19612ad4da0d86209612b73d6cf758c15d66'
}

function EGate-Fail([string]$m) { throw [System.InvalidOperationException]::new($m) }

# 候选身份核对：路径不可读/为空的候选视为【无法排除】，直接拒绝（绝不过滤成空集）。
function EGate-ResolveCandidates($Candidates, [string]$ExePath = $script:EExeDefault) {
  $hits = @()
  foreach ($c in @($Candidates)) {
    if ($null -eq $c) { continue }
    $p = $c.ExecutablePath; if (-not $p) { $p = $c.Path }
    $id = $c.ProcessId; if (-not $id) { $id = $c.Id }
    if ([string]::IsNullOrWhiteSpace([string]$p)) { EGate-Fail ('候选进程 ' + $id + ' 的可执行路径不可读：无法排除，fail closed') }
    if ($p -eq $ExePath) { $hits += [pscustomobject]@{ Id = $id; Path = $p } }
  }
  return $hits
}

# 完整枚举 + 身份核对。任何查询错误或路径不可读 => 抛错（调用者据此拒绝），绝不返回空集冒充『无进程』。
function EGate-DshProcesses([string]$ExePath = $script:EExeDefault, [scriptblock]$Probe) {
  if ($Probe) { return @(& $Probe $ExePath) }
  $all = Get-CimInstance Win32_Process -ErrorAction Stop   # 枚举失败必须抛出，不得静默
  $cands = @($all | Where-Object { $_.Name -like 'DeepSeek*' })
  return EGate-ResolveCandidates -Candidates $cands -ExePath $ExePath
}

# 独立 receiver 检查：识别真正指向 canonical 根的 receiver 入口进程（node 运行 receiver*.mjs 且命令行含该根）。
function EGate-ReceiverProcesses([string]$RootPath = $script:ERootDefault, [scriptblock]$Probe) {
  if ($Probe) { return @(& $Probe $RootPath) }
  $all = Get-CimInstance Win32_Process -ErrorAction Stop
  $cands = @($all | Where-Object { $_.Name -like 'node*' })
  $hits = @()
  foreach ($c in $cands) {
    $cl = $c.CommandLine
    if ([string]::IsNullOrWhiteSpace($cl)) { continue }   # 非 node 运行器/短命令行：无法据此判定，跳过不算排除
    if ($cl -match 'receiver' -and $cl.Replace('\\','/') -match [regex]::Escape(($RootPath -replace '\\','/'))) {
      $hits += [pscustomobject]@{ Id = $c.ProcessId; Reason = 'receiver+canonical-root' }
    }
  }
  return $hits
}

function EGate-FileHash([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { EGate-Fail ('文件不存在：' + $Path) } return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() }
function EGate-AssertHash([string]$Path, [string]$Expected, [string]$Label) { $h = EGate-FileHash $Path; if ($h -ne $Expected.ToLower()) { EGate-Fail ($Label + ' hash 漂移：' + $h) } return $h }
function EGate-AssertBaseline([string]$RepoPath = $script:ERepoDefault) {
  $ok = Test-Path -LiteralPath (Join-Path $RepoPath '.git')
  if (-not $ok) { EGate-Fail ('不是 git 仓库：' + $RepoPath) }
  $sha = (& git -C $RepoPath rev-parse HEAD 2>$null); if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { EGate-Fail 'git rev-parse 失败' }
  if ($sha.Trim() -ne $script:EHash.main) { EGate-Fail ('代码基线漂移：' + $sha.Trim() + ' != ' + $script:EHash.main) }
  $dirty = (& git -C $RepoPath status --porcelain 2>$null); if ($LASTEXITCODE -ne 0) { EGate-Fail 'git status 失败' }
  if (-not [string]::IsNullOrWhiteSpace(($dirty -join ''))) { EGate-Fail '工作区不干净（拒绝在漂移基线上启动）' }
  return $sha.Trim()
}
# 停机门禁：显式确认 + 枚举成功 + 无宿主 + 无指向该根的 receiver。
function EGate-AssertHostStopped([switch]$ConfirmHostExited, [string]$ExePath = $script:EExeDefault, [string]$RootPath = $script:ERootDefault, [scriptblock]$HostProbe, [scriptblock]$ReceiverProbe) {
  if (-not $ConfirmHostExited) { EGate-Fail '缺少 -ConfirmHostExited（拒绝在未确认宿主退出时操作）' }
  $host_ = @(EGate-DshProcesses -ExePath $ExePath -Probe $HostProbe)
  if ($host_.Count -gt 0) { EGate-Fail ('桌面宿主仍在运行（PID ' + ($host_.Id -join ',') + '），不自动强杀') }
  $rec = @(EGate-ReceiverProcesses -RootPath $RootPath -Probe $ReceiverProbe)
  if ($rec.Count -gt 0) { EGate-Fail ('存在指向该根的独立 receiver（PID ' + ($rec.Id -join ',') + '），拒绝操作') }
  return $true
}
# 子脚本调用：任何非零退出码/未捕获异常都必须阻断外层。
function EGate-InvokeChild([string]$ScriptPath, [string[]]$ChildArgs) {
  if (-not (Test-Path -LiteralPath $ScriptPath)) { EGate-Fail ('找不到子脚本：' + $ScriptPath) }
  $global:LASTEXITCODE = 0
  & $ScriptPath @ChildArgs
  if (-not $?) { EGate-Fail ('子脚本失败：' + (Split-Path $ScriptPath -Leaf)) }
  if ($LASTEXITCODE -ne 0) { EGate-Fail ('子脚本退出码 ' + $LASTEXITCODE + '：' + (Split-Path $ScriptPath -Leaf)) }
  return $true
}
# 后置条件：根存在且整根为空（不凭子脚本打印判断）。
function EGate-AssertRootEmpty([string]$RootPath = $script:ERootDefault) {
  if (-not (Test-Path -LiteralPath $RootPath)) { EGate-Fail ('根不存在：' + $RootPath) }
  $left = @(Get-ChildItem -LiteralPath $RootPath -Recurse -Force)
  $left = @($left | Where-Object { $_.Name -ne '.e-acceptance' })
  if ($left.Count -ne 0) { EGate-Fail ('根非空：' + ($left.FullName -join ', ')) }
  return $true
}