# LocalPost postmaster - Windows desktop toast channel.
# Called by the dsh plugin as:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File toast.ps1 -Title "..." -Body "..."
# Prints TOAST_OK on success or TOAST_FAIL: <reason> on failure (exit code stays 0,
# so the caller judges by the marker and always gets the reason in stdout).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI, so any
# non-ASCII literal here would be mojibake. All user text arrives through arguments.

param(
  [string]$Title = 'LocalPost',
  [string]$Body = ''
)

$ErrorActionPreference = 'Stop'

function Esc([string]$s) {
  if ($null -eq $s) { return '' }
  return [System.Security.SecurityElement]::Escape($s)
}

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $xmlText = '<toast scenario="reminder"><visual><binding template="ToastGeneric">' +
    '<text>' + (Esc $Title) + '</text>' +
    '<text>' + (Esc $Body) + '</text>' +
    '</binding></visual></toast>'

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml

  # Windows PowerShell's registered AUMID: no extra module or app install needed.
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Write-Output 'TOAST_OK'
} catch {
  Write-Output ('TOAST_FAIL: ' + $_.Exception.Message)
}
