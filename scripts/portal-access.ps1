# portal-access.ps1 — make the portal reachable from your phone/laptop through Tailscale (private),
# never from the open internet. The portal itself only listens on 127.0.0.1:8790.
#
#   powershell -ExecutionPolicy Bypass -File C:\botplatform\scripts\portal-access.ps1
#
# One-time on each device that should open the portal (yours, Josh's, Matt's): install Tailscale from
# https://tailscale.com/download and log in to the same Tailscale network (invite them from the
# Tailscale admin page: https://login.tailscale.com/admin/users).

param([int]$Port = 8790)
$ErrorActionPreference = "Continue"
function Fail($m) { Write-Host "`nSTOPPED: $m" -ForegroundColor Red; exit 1 }

$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
  Write-Host "Installing Tailscale..." -ForegroundColor Cyan
  $exe = Join-Path $env:TEMP "tailscale-setup.exe"
  Invoke-WebRequest "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe" -OutFile $exe
  Start-Process $exe -ArgumentList "/quiet" -Wait
  if (-not (Test-Path $ts)) { Fail "Tailscale did not install. Install it from https://tailscale.com/download/windows and rerun." }
}

& $ts status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Log this server in to Tailscale (a browser link follows)..." -ForegroundColor Cyan
  & $ts up --unattended
  if ($LASTEXITCODE -ne 0) { Fail "tailscale up failed." }
}

Write-Host "Publishing the portal on your private Tailscale network..." -ForegroundColor Cyan
& $ts serve --bg $Port
if ($LASTEXITCODE -ne 0) {
  Write-Host "If it asked you to enable HTTPS: open the link it printed, click Enable, then rerun this script." -ForegroundColor Yellow
  Fail "tailscale serve failed."
}
& $ts serve status
Write-Host "`nDONE. Open the https://....ts.net address above on any device logged in to your Tailscale." -ForegroundColor Green
Write-Host "Only devices in your Tailscale network can reach it; it is not on the public internet."
