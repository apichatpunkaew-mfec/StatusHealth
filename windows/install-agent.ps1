param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "agent.config.json"),
  [string]$Endpoint = "https://pc-health-dashboard.apichat-p-1989.workers.dev/api/health",
  [int]$IntervalSeconds = 10,
  [string]$DisplayName = "",
  [string]$DeviceId = "",
  [string]$TaskName = "PC Health Dashboard Agent",
  [string]$ServiceName = "PCHealthAgent",
  [string]$ServiceDisplayName = "PC Health Dashboard Agent",
  [switch]$Force,
  [switch]$NoStart,
  [switch]$SkipVerify,
  [switch]$Uninstall,
  [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "health-lib.ps1")

$adminPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Administrator privileges are required to install/uninstall the Windows service. Right-click PowerShell and choose Run as Administrator."
}

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

function Get-CscPath {
  foreach ($framework in @("Framework64", "Framework")) {
    $path = Join-Path $env:WINDIR "Microsoft.NET\$framework\v4.0.30319\csc.exe"
    if (Test-Path $path) { return $path }
  }
  return $null
}

function New-ServiceExecutable {
  param([string]$Source, [string]$Output)

  $csc = Get-CscPath
  if ($csc) {
    & $csc /nologo /target:winexe "/out:$Output" /r:System.dll /r:System.ServiceProcess.dll $Source
    if ($LASTEXITCODE -eq 0 -and (Test-Path $Output)) { return $Output }
  }

  try {
    Add-Type -TypeDefinition (Get-Content -Path $Source -Raw) `
      -OutputAssembly $Output `
      -OutputType WindowsApplication `
      -ReferencedAssemblies @("System.dll", "System.ServiceProcess.dll") -ErrorAction Stop
    if (Test-Path $Output) { return $Output }
  } catch {
    throw "Cannot compile service executable: $($_.Exception.Message)"
  }

  throw "Cannot compile service executable. Install .NET Framework 4.x or run from a Visual Studio Developer Command Prompt."
}

function Remove-AgentService {
  param([string]$Name)

  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { return }

  if ($service.Status.ToString() -ne "Stopped") {
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  $result = & sc.exe delete $Name 2>&1
  Start-Sleep -Seconds 2
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    throw "Cannot remove existing service '$Name'. $result"
  }
  Write-Host "Removed old service: $Name"
}

function Remove-LegacyTask {
  param([string]$Name)

  try {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -eq $task) { return }
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed legacy scheduled task: $Name"
  } catch {
    Write-Host "Could not remove legacy scheduled task '$Name': $($_.Exception.Message)"
  }
}

if ($Uninstall) {
  Remove-AgentService -Name $ServiceName
  Remove-LegacyTask -Name $TaskName

  if ($RemoveFiles) {
    Remove-Item -Path $ConfigPath -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $PSScriptRoot -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed agent files in $PSScriptRoot"
  } else {
    Write-Host "Kept files in $PSScriptRoot (use -RemoveFiles to delete them)"
  }

  Write-Host "Uninstalled PC Health Agent service: $ServiceName"
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

if (-not $SkipVerify) {
  Write-Host "Verifying token by sending one test sample..."
  try {
    $probe = Send-HealthOnce `
      -Endpoint $Endpoint `
      -Token $token `
      -DeviceId $DeviceId `
      -DisplayName $DisplayName
    Write-Host "Verified: id=$($probe.id) status=$($probe.status)"
  } catch {
    $detail = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
    throw "Verification failed (check HEALTH_TOKEN / network): $detail"
  }
}

$agentPath = Join-Path $PSScriptRoot "agent.ps1"
$logPath = Join-Path $PSScriptRoot "agent.log"
$sourcePath = Join-Path $PSScriptRoot "PCHealthAgent.Service.cs"
$exePath = Join-Path $PSScriptRoot "PCHealthAgent.Service.exe"

if (-not (Test-Path $sourcePath)) {
  throw "Service source not found: $sourcePath"
}

Write-Host "Compiling Windows service wrapper..."
$exePath = New-ServiceExecutable -Source $sourcePath -Output $exePath
Write-Host "Compiled: $exePath"

Remove-LegacyTask -Name $TaskName
Remove-AgentService -Name $ServiceName

New-Service `
  -Name $ServiceName `
  -DisplayName $ServiceDisplayName `
  -BinaryPathName "`"$exePath`"" `
  -StartupType Automatic `
  -Description "Sends this PC's health metrics to the Cloudflare dashboard every $IntervalSeconds seconds." | Out-Null

& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe descr $ServiceName "Sends this PC's health metrics to the Cloudflare dashboard every $IntervalSeconds seconds." | Out-Null

if (-not $NoStart) {
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 3
}

$service = Get-Service -Name $ServiceName

Write-Host ""
Write-Host "Installed Windows service: $ServiceDisplayName ($ServiceName)"
Write-Host "Agent : $agentPath"
Write-Host "Log   : $logPath"
Write-Host "Service log: $(Join-Path $PSScriptRoot 'service.log')"
Write-Host "Status: $($service.Status)"
if (Test-Path $logPath) {
  Write-Host ""
  Write-Host "--- agent.log (last 10 lines) ---"
  Get-Content -Path $logPath -Tail 10
}
Write-Host ""
Write-Host "Dashboard: https://pc-health-dashboard.apichat-p-1989.workers.dev"
