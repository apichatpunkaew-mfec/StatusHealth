param(
  [Parameter(Mandatory = $true)][string]$Endpoint,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$DeviceId,
  [string]$DisplayName
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "health-lib.ps1")

try {
  $response = Send-HealthOnce `
    -Endpoint $Endpoint `
    -Token $Token `
    -DeviceId $DeviceId `
    -DisplayName $DisplayName

  Write-Host ("[{0}] OK id={1} status={2}" -f (Get-Date -Format "HH:mm:ss"), $response.id, $response.status)
  exit 0
} catch {
  [Console]::Error.WriteLine("Failed to send health check: $($_.Exception.Message)")
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    [Console]::Error.WriteLine($_.ErrorDetails.Message)
  }
  exit 1
}
