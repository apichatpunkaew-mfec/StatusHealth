param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "agent.config.json"),
  [string]$Endpoint = "https://pc-health-dashboard.apichat-p-1989.workers.dev/api/health",
  [int]$IntervalSeconds = 10,
  [string]$DisplayName = "",
  [string]$DeviceId = "",
  [string]$TaskName = "PC Health Dashboard Agent",
  [switch]$Force,
  [switch]$NoStart,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "health-lib.ps1")

function Read-SecretToken {
  $secure = Read-Host "HEALTH_TOKEN (from Cloudflare secret)" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Protect-ConfigFile {
  param([string]$Path)

  try {
    $acl = Get-Acl -Path $Path
    $acl.SetAccessRuleProtection($true, $false)
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -Path $Path -AclObject $acl
  } catch {
    Write-Warning "Could not tighten ACL on config file: $($_.Exception.Message)"
  }
}

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task: $TaskName"
  exit 0
}

if ((Test-Path $ConfigPath) -and -not $Force) {
  throw "Config already exists: $ConfigPath. Use -Force to overwrite it."
}

Test-HealthEndpoint -Endpoint $Endpoint
$token = Read-SecretToken

if ([string]::IsNullOrWhiteSpace($token) -or $token -eq "CHANGE_ME") {
  throw "HEALTH_TOKEN cannot be empty."
}

if ($IntervalSeconds -lt 2) { $IntervalSeconds = 2 }
if ($IntervalSeconds -gt 3600) { $IntervalSeconds = 3600 }

$config = [ordered]@{
  endpoint        = $Endpoint
  token           = $token
  intervalSeconds = $IntervalSeconds
  displayName     = $DisplayName
  deviceId        = $DeviceId
}

Set-Content -Path $ConfigPath -Value ($config | ConvertTo-Json -Depth 4) -Encoding UTF8
Protect-ConfigFile -Path $ConfigPath
Write-Host "Wrote config: $ConfigPath"

$agentPath = Join-Path $PSScriptRoot "agent.ps1"
$logPath = Join-Path $PSScriptRoot "agent.log"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f $agentPath, $ConfigPath)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Sends this PC's health metrics to the Cloudflare dashboard every $IntervalSeconds seconds." `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host ""
Write-Host "Installed and started scheduled task: $TaskName"
Write-Host "Agent : $agentPath"
Write-Host "Log   : $logPath"
Write-Host "Task  : $((Get-ScheduledTask -TaskName $TaskName).State)"
Write-Host ""
Write-Host "Dashboard: https://pc-health-dashboard.apichat-p-1989.workers.dev"
