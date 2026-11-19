param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "agent.config.json"),
  [string]$TaskName = "PC Health Dashboard Agent",
  [string]$ServiceName = "PCHealthAgent"
)

. (Join-Path $PSScriptRoot "health-lib.ps1")
$ErrorActionPreference = "Continue"

$folder = $PSScriptRoot
$logPath = Join-Path $folder "agent.log"

function Show-Heading {
  param([string]$Text)
  Write-Host ""
  Write-Host "=== $Text ==="
}

function Get-Prop {
  param($Object, [string]$Name, $Default)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

Show-Heading "Agent files"
Write-Host "Folder: $folder"
foreach ($file in @("health-lib.ps1", "agent.ps1", "install-agent.ps1", "PCHealthAgent.Service.cs", "PCHealthAgent.Service.exe", "agent.config.json")) {
  Write-Host ("{0}: {1}" -f $file, (Test-Path (Join-Path $folder $file)))
}

Show-Heading "Windows service"
try {
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  Write-Host ("Name: {0}" -f $service.Name)
  Write-Host ("DisplayName: {0}" -f $service.DisplayName)
  Write-Host ("Status: {0}" -f $service.Status)
  Write-Host ("StartMode: {0}" -f $wmi.StartMode)
  Write-Host ("PathName: {0}" -f $wmi.PathName)
} catch {
  Write-Host ("Service check failed: {0}" -f $_.Exception.Message)
}

Show-Heading "Legacy scheduled task"
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-Host "Not found (this is fine after upgrading to service)"
  } else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ("State: {0}" -f $task.State)
    Write-Host ("LastRunTime: {0}" -f $info.LastRunTime)
    Write-Host ("LastTaskResult: {0}" -f $info.LastTaskResult)
  }
} catch {
  Write-Host ("Legacy task check failed: {0}" -f $_.Exception.Message)
}

Show-Heading "Config (token is masked)"
$config = $null
if (-not (Test-Path $ConfigPath)) {
  Write-Host "Config missing: $ConfigPath"
} else {
  try {
    $config = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $token = [string](Get-Prop $config "token" "")
    if ([string]::IsNullOrWhiteSpace($token)) {
      $tokenInfo = "EMPTY"
    } elseif ($token -eq "CHANGE_ME") {
      $tokenInfo = "CHANGE_ME"
    } else {
      $tokenInfo = "set (length $($token.Length))"
    }

    Write-Host ("endpoint: {0}" -f (Get-Prop $config "endpoint" ""))
    Write-Host ("intervalSeconds: {0}" -f (Get-Prop $config "intervalSeconds" ""))
    Write-Host ("displayName: {0}" -f (Get-Prop $config "displayName" ""))
    Write-Host ("deviceId: {0}" -f (Get-Prop $config "deviceId" ""))
    Write-Host ("token: {0}" -f $tokenInfo)
  } catch {
    Write-Host ("Config read failed: {0}" -f $_.Exception.Message)
  }
}

Show-Heading "agent.log (last 30 lines)"
if (Test-Path $logPath) {
  Get-Content -Path $logPath -Tail 30
} else {
  Write-Host "No log file yet."
}

Show-Heading "service.log (last 20 lines)"
$serviceLog = Join-Path $folder "service.log"
if (Test-Path $serviceLog) {
  Get-Content -Path $serviceLog -Tail 20
} else {
  Write-Host "No service log yet."
}

Show-Heading "Test send"
if ($null -eq $config) {
  Write-Host "Skipped: config unavailable."
} else {
  try {
    $endpoint = [string](Get-Prop $config "endpoint" "")
    $token = [string](Get-Prop $config "token" "")
    $response = Send-HealthOnce `
      -Endpoint $endpoint `
      -Token $token `
      -DeviceId ([string](Get-Prop $config "deviceId" "")) `
      -DisplayName ([string](Get-Prop $config "displayName" ""))
    Write-Host ("OK id={0} status={1}" -f $response.id, $response.status)
  } catch {
    $detail = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
    Write-Host ("FAILED: {0}" -f $detail)
  }
}
