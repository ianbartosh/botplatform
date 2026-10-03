# dryrun-setup.ps1 — import the bots on this VPS into the platform for a DRY-RUN test, and start them.
#
#   powershell -ExecutionPolicy Bypass -File C:\botplatform\scripts\dryrun-setup.ps1
#
# Safe by design: wallet keys are NOT imported, every bot is dry-run, the test screener does not post
# to Slack, and all bots use the Helius key you type here (use your FREE key, not the trading key).
# Run setup-windows.ps1 first. Re-running this is safe: bots already imported are skipped.

param([string]$BotsDir = "C:\bots")

$ErrorActionPreference = "Continue"   # native commands report through exit codes, checked below
function Fail($m) { Write-Host "`nSTOPPED: $m" -ForegroundColor Red; exit 1 }
$Root = Split-Path -Parent $PSScriptRoot
$bp = Join-Path $Root "bp.js"

# settings saved by setup-windows.ps1
$env:BP_MASTER_KEY = [Environment]::GetEnvironmentVariable("BP_MASTER_KEY", "Machine")
$env:BP_DATA_DIR = [Environment]::GetEnvironmentVariable("BP_DATA_DIR", "Machine")
if (-not $env:BP_MASTER_KEY) { Fail "Run scripts\setup-windows.ps1 first." }

function Bp { & node $bp @args; if ($LASTEXITCODE -ne 0) { Fail "bp $($args -join ' ') failed (see above)." } }
function Exists($id) { & node $bp show $id *> $null; return ($LASTEXITCODE -eq 0) }

$key = Read-Host "Paste your FREE Helius API key (just the key, not the URL)"
$key = $key.Trim()
if ($key.Length -lt 20) { Fail "That doesn't look like a Helius key." }
$rpc = "https://mainnet.helius-rpc.com/?api-key=$key"

# id, strategy, file, extra settings
$plan = @(
  @{ id = "scr";  strat = "screener";   file = "$BotsDir\screener\screener_settings.json"; set = @() },
  @{ id = "slp";  strat = "screenerlp"; file = "$BotsDir\screenerlp\.env";  set = @("PICKS_FROM=scr") },
  @{ id = "slp2"; strat = "screenerlp"; file = "$BotsDir\screenerlp2\.env"; set = @("PICKS_FROM=scr", "SCREENER_BASE_SHAPE=spot") },
  @{ id = "swap"; strat = "swapcopy";   file = "$BotsDir\swapcopy\.env";    set = @() }
)

$done = @()
foreach ($b in $plan) {
  Write-Host "`n== $($b.id) ($($b.strat))" -ForegroundColor Cyan
  if (Exists $b.id) { Write-Host "already imported - skipping"; $done += $b.id; continue }
  if (-not (Test-Path $b.file)) { Write-Host "not found: $($b.file) - skipping" -ForegroundColor Yellow; continue }
  Bp import $b.id $b.strat $b.file --no-keys
  if ($b.strat -eq "screener") {
    & node $bp unset $b.id SLACK_WEBHOOK_URL *> $null       # no Slack posts from the test screener
  } else {
    Bp secret $b.id RPC_URL $rpc
    if ($b.strat -ne "swapcopy") { Bp secret $b.id HELIUS_API_KEY $key }
  }
  if ($b.set.Count) { Bp set $b.id @($b.set) }
  $done += $b.id
}
if (-not $done.Count) { Fail "No bots found under $BotsDir." }

Write-Host "`n== Enabling" -ForegroundColor Cyan
foreach ($id in $done) { Bp enable $id }

$svc = Get-Service botplatform -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "`nThe botplatform service is running - it starts these bots within a few seconds."
} else {
  Write-Host "`nStarting the engine in a new window (keep that window open; closing it stops the test)."
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:BP_MASTER_KEY=[Environment]::GetEnvironmentVariable('BP_MASTER_KEY','Machine'); `$env:BP_DATA_DIR=[Environment]::GetEnvironmentVariable('BP_DATA_DIR','Machine'); node '$bp' run"
}
Start-Sleep -Seconds 20
& node $bp status
Write-Host "`nDONE. The dry-run is running. Check it any time with:  bp status" -ForegroundColor Green
