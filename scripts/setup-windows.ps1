# setup-windows.ps1 — install the bot platform on a Windows VPS.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1                 (dry-run test box: run it in a window)
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Service        (also install as a Windows service)
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -DatapiLimit 5  (share the box with live bots)
#
# What it does: checks Node, installs packages, runs the tests, asks for the master key once and
# stores it (with the data folder) as machine environment variables, creates the database, adds a
# `bp` command, and optionally installs the engine as a service with NSSM.

param(
  [string]$DataDir = "C:\botplatform-data",
  [switch]$Service,
  [int]$DatapiLimit = 0
)

$ErrorActionPreference = "Continue"   # native commands report through exit codes, checked below
function Fail($m) { Write-Host "`nSTOPPED: $m" -ForegroundColor Red; exit 1 }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 0. must be admin (machine env vars + service)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail "Run PowerShell as Administrator." }

# 1. Node 22.13+
Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js is not installed. Install the LTS version from https://nodejs.org (22 or 24), open a NEW PowerShell as Administrator, and rerun." }
$v = (node -v).TrimStart("v").Split(".")
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 13)) { Fail "Node $(node -v) is too old. Install Node 22.13+ or 24 LTS from https://nodejs.org and rerun." }
Write-Host "Node $(node -v) ok"

# 2. packages + tests
Step "Installing packages"
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (see above)." }
Step "Running tests"
npm test
if ($LASTEXITCODE -ne 0) { Fail "Tests failed - send the output to Claude." }

# 3. master key + data folder
Step "Master key"
$existing = [Environment]::GetEnvironmentVariable("BP_MASTER_KEY", "Machine")
if ($existing) {
  Write-Host "BP_MASTER_KEY already set - keeping it."
  $mk = $existing
} else {
  Write-Host "Choose a master key (12+ characters). It encrypts every private key and API key in the database."
  Write-Host "Write it down somewhere safe: without it the stored secrets cannot be decrypted." -ForegroundColor Yellow
  $a = Read-Host "Master key" -AsSecureString
  $b = Read-Host "Repeat" -AsSecureString
  $pa = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
  $pb = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
  if ($pa -ne $pb) { Fail "The two entries differ." }
  if ($pa.Length -lt 12) { Fail "Use at least 12 characters." }
  [Environment]::SetEnvironmentVariable("BP_MASTER_KEY", $pa, "Machine")
  $mk = $pa
}
[Environment]::SetEnvironmentVariable("BP_DATA_DIR", $DataDir, "Machine")
$env:BP_MASTER_KEY = $mk
$env:BP_DATA_DIR = $DataDir
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Step "Creating the database"
node bp.js init
if ($LASTEXITCODE -ne 0) { Fail "init failed (wrong master key for an existing database?)." }
if ($DatapiLimit -gt 0) { node bp.js limit dlmm.datapi.meteora.ag $DatapiLimit }

# 4. `bp` command available in any new PowerShell window
Step "Adding the bp command"
$cmd = Join-Path $Root "bp.cmd"
Set-Content -Path $cmd -Value "@node `"%~dp0bp.js`" %*" -Encoding ASCII
$path = [Environment]::GetEnvironmentVariable("Path", "Machine")
if (($path -split ";") -notcontains $Root) { [Environment]::SetEnvironmentVariable("Path", "$path;$Root", "Machine") }
Write-Host "Open a NEW PowerShell window and type: bp help"

# 5. optional Windows service (NSSM)
if ($Service) {
  Step "Installing the Windows service"
  $nssmDir = Join-Path $Root "tools\nssm"
  $nssm = Join-Path $nssmDir "nssm.exe"
  if (-not (Test-Path $nssm)) {
    New-Item -ItemType Directory -Force -Path $nssmDir | Out-Null
    $zip = Join-Path $env:TEMP "nssm.zip"
    Invoke-WebRequest "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP\nssm -Force
    Copy-Item "$env:TEMP\nssm\nssm-2.24\win64\nssm.exe" $nssm
  }
  $nodeExe = (Get-Command node).Source
  & $nssm stop botplatform 2>$null | Out-Null
  & $nssm remove botplatform confirm 2>$null | Out-Null
  & $nssm install botplatform $nodeExe "`"$Root\bp.js`" run"
  & $nssm set botplatform AppDirectory $Root
  & $nssm set botplatform AppEnvironmentExtra "BP_MASTER_KEY=$mk" "BP_DATA_DIR=$DataDir"
  & $nssm set botplatform AppStdout "$DataDir\service-out.log"
  & $nssm set botplatform AppStderr "$DataDir\service-err.log"
  & $nssm set botplatform AppRotateFiles 1
  & $nssm set botplatform AppRotateBytes 20000000
  & $nssm set botplatform AppStopMethodConsole 30000   # Ctrl+Break, then wait 30s for workers to stop
  & $nssm set botplatform AppExit Default Restart
  & $nssm set botplatform AppRestartDelay 5000
  & $nssm set botplatform Start SERVICE_AUTO_START
  & $nssm start botplatform
  Write-Host "Service 'botplatform' installed and started. It starts on boot and restarts on crash."
  Write-Host "Stop: nssm stop botplatform   Start: nssm start botplatform   (or services.msc)"
}

Write-Host "`nDONE. Next: import your bots - see README.md, section 'Dry-run on the current VPS'." -ForegroundColor Green
