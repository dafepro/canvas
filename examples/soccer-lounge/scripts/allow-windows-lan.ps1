#Requires -RunAsAdministrator

$ruleName = "Canvas Soccer Lounge LAN"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if (-not $existing) {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description "Allow the Canvas soccer lounge app and room service from the local subnet." `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 5174, 8082 `
    -RemoteAddress LocalSubnet `
    -Profile Private, Public | Out-Null
}

Get-NetFirewallRule -DisplayName $ruleName |
  Select-Object DisplayName, Enabled, Profile, Direction, Action
