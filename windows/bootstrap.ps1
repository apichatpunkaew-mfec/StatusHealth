param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "PCHealthAgent"),
  [string]$Endpoint = "https://pc-health-dashboard.apichat-p-1989.workers.dev/api/health",
  [int]$IntervalSeconds = 10,
  [string]$DisplayName = "",
  [string]$DeviceId = "",
  [string]$TaskName = "PC Health Dashboard Agent",
  [string]$ServiceName = "PCHealthAgent",
  [string]$ServiceDisplayName = "PC Health Dashboard Agent",
  [string]$BaseUrl = "https://raw.githubusercontent.com/apichatpunkaew-mfec/StatusHealth/main/windows",
  [switch]$Force,
  [switch]$NoStart,
  [switch]$SkipVerify,
  [switch]$Uninstall,
  [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$adminPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Administrator privileges are required. Right-click PowerShell and choose Run as Administrator."
}

$files = @(
  "health-lib.ps1",
  "agent.ps1",
  "install-agent.ps1",
  "collect-and-send.ps1",
  "send-health.bat",
  "run-agent.bat",
  "agent.config.example.json",
  "diagnose.ps1",
  "PCHealthAgent.Service.cs"
)

if ($Uninstall) {
  Write-Host "Uninstalling PC Health Agent"
} else {
  Write-Host "Installing PC Health Agent"
}
Write-Host "  folder  : $InstallDir"
Write-Host "  endpoint: $Endpoint"
Write-Host ""

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

foreach ($file in $files) {
  $target = Join-Path $InstallDir $file
  $url = "$BaseUrl/$file"
  Write-Host "  downloading $file"
  try {
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -ErrorAction Stop
  } catch {
    throw "Cannot download $url : $($_.Exception.Message)"
  }
}

$installer = Join-Path $InstallDir "install-agent.ps1"
$config = Join-Path $InstallDir "agent.config.json"

$procArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $installer,
  "-ConfigPath", $config,
  "-Endpoint", $Endpoint,
  "-IntervalSeconds", "$IntervalSeconds",
  "-TaskName", $TaskName,
  "-ServiceName", $ServiceName,
  "-ServiceDisplayName", $ServiceDisplayName
)

if (-not [string]::IsNullOrWhiteSpace($DisplayName)) { $procArgs += @("-DisplayName", $DisplayName) }
if (-not [string]::IsNullOrWhiteSpace($DeviceId)) { $procArgs += @("-DeviceId", $DeviceId) }
if ($Force) { $procArgs += "-Force" }
if ($NoStart) { $procArgs += "-NoStart" }
if ($SkipVerify) { $procArgs += "-SkipVerify" }
if ($Uninstall) { $procArgs += "-Uninstall" }
if ($RemoveFiles) { $procArgs += "-RemoveFiles" }

Write-Host ""
& powershell.exe @procArgs
exit $LASTEXITCODE
