param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "agent.config.json"),
  [int]$IntervalSeconds = 0,
  [switch]$Console
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "health-lib.ps1")

$LogPath = Join-Path $PSScriptRoot "agent.log"

function Get-ConfigValue {
  param($Object, [string]$Name, $Default)

  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  if ($null -eq $property.Value) { return $Default }
  return $property.Value
}

function Read-AgentConfig {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    throw "Config not found: $Path. Copy agent.config.example.json to agent.config.json first."
  }

  $raw = Get-Content -Path $Path -Raw -Encoding UTF8
  try {
    return ($raw | ConvertFrom-Json)
  } catch {
    throw "Invalid JSON in $Path : $($_.Exception.Message)"
  }
}

function Write-AgentLog {
  param([string]$Level, [string]$Message)

  try {
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1MB) {
      Move-Item -Path $LogPath -Destination (Join-Path $PSScriptRoot "agent.old.log") -Force
    }

    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    if ($Console) { Write-Host $line }
  } catch {
    # Logging must never stop the agent.
  }
}

try {
  $config = Read-AgentConfig -Path $ConfigPath

  $endpoint = [string](Get-ConfigValue $config "endpoint" "")
  $token = [string](Get-ConfigValue $config "token" "")
  $deviceId = [string](Get-ConfigValue $config "deviceId" "")
  $displayName = [string](Get-ConfigValue $config "displayName" "")
  $configuredInterval = [int](Get-ConfigValue $config "intervalSeconds" 10)

  if ($IntervalSeconds -gt 0) {
    $interval = $IntervalSeconds
  } else {
    $interval = $configuredInterval
  }

  if ($interval -lt 2) { $interval = 2 }
  if ($interval -gt 3600) { $interval = 3600 }

  Test-HealthEndpoint -Endpoint $endpoint

  if ($token -eq "CHANGE_ME" -or [string]::IsNullOrWhiteSpace($token)) {
    throw "Set token in $ConfigPath before starting the agent."
  }

  Write-AgentLog -Level "INFO" -Message "Agent started. endpoint=$endpoint interval=${interval}s"

  $failures = 0

  while ($true) {
    $cycleStarted = Get-Date

    try {
      $response = Send-HealthOnce `
        -Endpoint $endpoint `
        -Token $token `
        -DeviceId $deviceId `
        -DisplayName $displayName

      $failures = 0
      Write-AgentLog -Level "OK" -Message ("id={0} status={1}" -f $response.id, $response.status)
    } catch {
      $failures++
      $detail = $_.ErrorDetails.Message
      if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
      Write-AgentLog -Level "ERROR" -Message ("failure #{0}: {1}" -f $failures, $detail)
    }

    $elapsed = ((Get-Date) - $cycleStarted).TotalSeconds
    $sleepSeconds = [math]::Ceiling($interval - $elapsed)
    if ($sleepSeconds -lt 1) { $sleepSeconds = 1 }
    Start-Sleep -Seconds $sleepSeconds
  }
} catch {
  $message = $_.Exception.Message
  Write-AgentLog -Level "FATAL" -Message $message
  [Console]::Error.WriteLine("Agent failed: $message")
  exit 1
}
