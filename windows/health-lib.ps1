# Shared functions for the Windows health agent.
# Dot-source this file; it does not execute anything by itself.

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-HealthEndpoint {
  param([Parameter(Mandatory = $true)][string]$Endpoint)

  if ($Endpoint -notmatch '^(https://|http://(localhost|127\.0\.0\.1)(:\d+)?/)') {
    throw "Endpoint must be https:// (http is allowed for localhost only)."
  }
}

function Get-MachineId {
  param([string]$DeviceId)

  if (-not [string]::IsNullOrWhiteSpace($DeviceId)) {
    return $DeviceId.Trim()
  }

  $product = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
  if ($product -and $product.UUID) {
    return $product.UUID.Trim([char[]]'{}')
  }

  $guid = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue
  if ($guid -and $guid.MachineGuid) {
    return $guid.MachineGuid
  }

  return $env:COMPUTERNAME
}

function Get-PrimaryIPv4 {
  try {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' })
    if ($addresses.Count -gt 0) {
      return $addresses[0].IPAddress
    }
  } catch {
    # Fall back to WMI below.
  }

  try {
    $configured = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=TRUE" |
      Select-Object -First 1 -ExpandProperty IPAddress |
      Where-Object { $_ -ne '127.0.0.1' })
    if ($configured.Count -gt 0) {
      return $configured[0]
    }
  } catch {
    # No address available.
  }

  return ""
}

function Get-DiskInfo {
  $disks = @()
  foreach ($disk in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
    $size = [double]$disk.Size
    $free = [double]$disk.FreeSpace
    if ($size -le 0) { continue }

    $disks += [pscustomobject]@{
      name    = $disk.DeviceID
      usedPct = [math]::Round((($size - $free) / $size) * 100, 1)
      freeGb  = [math]::Round($free / 1GB, 1)
      totalGb = [math]::Round($size / 1GB, 1)
    }
  }
  return $disks
}

function Upgrade-Level {
  param([string]$Current, [string]$Next)

  if ($Next -eq "critical" -or ($Next -eq "warning" -and $Current -eq "ok")) {
    return $Next
  }
  return $Current
}

function Get-HealthStatus {
  param(
    [Nullable[double]]$CpuPct = $null,
    [Nullable[double]]$MemUsedPct = $null,
    [object[]]$Disks = @()
  )

  $level = "ok"
  $notes = New-Object 'System.Collections.Generic.List[string]'

  if ($null -ne $CpuPct) {
    if ($CpuPct -ge 98) {
      $level = Upgrade-Level $level "critical"
      $notes.Add("CPU critically high")
    } elseif ($CpuPct -ge 90) {
      $level = Upgrade-Level $level "warning"
      $notes.Add("CPU high")
    }
  }

  if ($null -ne $MemUsedPct) {
    if ($MemUsedPct -ge 97) {
      $level = Upgrade-Level $level "critical"
      $notes.Add("Memory critically high")
    } elseif ($MemUsedPct -ge 90) {
      $level = Upgrade-Level $level "warning"
      $notes.Add("Memory high")
    }
  }

  foreach ($disk in @($Disks)) {
    if ($null -eq $disk -or $null -eq $disk.usedPct) { continue }
    if ($disk.usedPct -ge 95) {
      $level = Upgrade-Level $level "critical"
      $notes.Add("Disk $($disk.name) almost full")
    } elseif ($disk.usedPct -ge 85) {
      $level = Upgrade-Level $level "warning"
      $notes.Add("Disk $($disk.name) running low")
    }
  }

  return [pscustomobject]@{ Level = $level; Notes = $notes }
}

function New-HealthPayload {
  param([string]$DeviceId, [string]$DisplayName)

  $os = Get-CimInstance Win32_OperatingSystem
  $processors = @(Get-CimInstance Win32_Processor)
  $cpuValues = @($processors | ForEach-Object {
    if ($null -ne $_.LoadPercentage) { [double]$_.LoadPercentage }
  })

  $cpuLoad = $null
  if ($cpuValues.Count -gt 0) {
    $cpuLoad = [math]::Round((($cpuValues | Measure-Object -Average).Average), 1)
  }

  $totalKb = [double]$os.TotalVisibleMemorySize
  $freeKb = [double]$os.FreePhysicalMemory
  $memUsedPct = $null
  if ($totalKb -gt 0) {
    $memUsedPct = [math]::Round((($totalKb - $freeKb) / $totalKb) * 100, 1)
  }

  $uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  $disks = @(Get-DiskInfo)
  $health = Get-HealthStatus -CpuPct $cpuLoad -MemUsedPct $memUsedPct -Disks $disks

  $name = if ([string]::IsNullOrWhiteSpace($DisplayName)) { $env:COMPUTERNAME } else { $DisplayName }

  return [ordered]@{
    id          = Get-MachineId -DeviceId $DeviceId
    hostname    = $env:COMPUTERNAME
    displayName = $name
    os          = $os.Caption.Trim()
    user        = "$env:USERDOMAIN\$env:USERNAME"
    ip          = Get-PrimaryIPv4
    status      = $health.Level
    message     = ($health.Notes -join "; ")
    timestamp   = (Get-Date).ToUniversalTime().ToString("o")
    metrics     = [ordered]@{
      cpuPct      = $cpuLoad
      memUsedPct  = $memUsedPct
      uptimeHours = $uptimeHours
      disks       = @($disks)
    }
  }
}

function Send-HealthOnce {
  param(
    [Parameter(Mandatory = $true)][string]$Endpoint,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$DeviceId,
    [string]$DisplayName
  )

  Test-HealthEndpoint -Endpoint $Endpoint

  if ($Token -eq "CHANGE_ME" -or [string]::IsNullOrWhiteSpace($Token)) {
    throw "Token is not configured. Set it in agent.config.json or HEALTH_TOKEN."
  }

  $payload = New-HealthPayload -DeviceId $DeviceId -DisplayName $DisplayName
  $json = $payload | ConvertTo-Json -Depth 6 -Compress
  $headers = @{
    "Authorization" = "Bearer $Token"
    "Content-Type"  = "application/json"
  }

  return Invoke-RestMethod `
    -Uri $Endpoint `
    -Method Post `
    -Headers $headers `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
    -TimeoutSec 20
}
