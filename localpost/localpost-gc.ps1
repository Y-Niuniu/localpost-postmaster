# Safe LocalPost GC: preview by default; deletion requires explicit -Apply.
param(
  [ValidateRange(30, 36500)][int]$Days = 30,
  [string]$Root = 'C:/AI_ASSIST/.mailbox',
  [switch]$Apply,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
if ($Apply -and $WhatIf) { throw '-Apply and -WhatIf are mutually exclusive' }
$gcScript = Join-Path $PSScriptRoot 'gc.mjs'
if (-not (Test-Path -LiteralPath $gcScript -PathType Leaf)) { throw 'gc.mjs must be deployed beside this wrapper' }
$gcArguments = @($gcScript, '--root', [IO.Path]::GetFullPath($Root), '--days', "$Days")
if ($Apply) { $gcArguments += '--apply' }
& node @gcArguments
exit $LASTEXITCODE
