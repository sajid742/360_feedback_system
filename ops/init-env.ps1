<#
.SYNOPSIS
  Creates the Docker stack's .env from .env.docker.example and fills in the two
  required secrets. Safe to re-run.

.DESCRIPTION
  `docker compose up -d` refuses to start without JWT_ACCESS_SECRET and
  MFA_ENCRYPTION_KEY, deliberately: starting with a placeholder secret would be
  worse than failing. This script generates real ones so you never have to.

  It never overwrites a secret you have already set - re-running it on a working
  .env changes nothing, so it cannot silently invalidate the key that encrypts
  your HR and SIS provider secrets.

.EXAMPLE
  .\ops\init-env.ps1
  docker compose up -d

.NOTES
  Run from the repository root (the folder containing compose.yaml).
  If PowerShell refuses to run this file because it is unsigned:
     powershell -ExecutionPolicy Bypass -File .\ops\init-env.ps1
#>
[CmdletBinding()]
param(
  # Overwrite existing secrets with freshly generated ones.
  # WARNING: a new MFA_ENCRYPTION_KEY makes previously encrypted HR/SIS provider
  # secrets unreadable. Only use this on a database you are willing to re-configure.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root '.env.docker.example'
$envFile  = Join-Path $root '.env'

if (-not (Test-Path $template)) {
  throw "Cannot find .env.docker.example in $root. Run this from the repository root."
}

function New-HexKey { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }

if (-not (Test-Path $envFile)) {
  Copy-Item $template $envFile
  Write-Host "Created .env from .env.docker.example" -ForegroundColor Green
} else {
  Write-Host ".env already exists - leaving it in place" -ForegroundColor Yellow
}

# A value counts as "not set" when it is missing, empty, or still the placeholder
# from the template (all zeros, or anything beginning with change-me).
function Test-NeedsValue([string]$value) {
  if ($Force) { return $true }
  if ([string]::IsNullOrWhiteSpace($value)) { return $true }
  if ($value -match '^change-me') { return $true }
  if ($value -match '^0+$') { return $true }
  return $false
}

$lines   = [System.IO.File]::ReadAllLines($envFile)
$changed = @()

# JWT_ACCESS_SECRET  - signs access tokens
# MFA_ENCRYPTION_KEY - MUST be 64 hex chars; also encrypts HR/SIS provider secrets
# WAHA_API_KEY       - the X-Api-Key the application sends to WAHA
# WAHA_DASHBOARD_PASSWORD - basic auth for WAHA's /dashboard page in your browser.
#   Unset, WAHA generates a new random one on EVERY start and prints it only to its
#   log; it also rejects weak values and substitutes a random one. So it is pinned here.
foreach ($name in @('JWT_ACCESS_SECRET', 'MFA_ENCRYPTION_KEY', 'WAHA_API_KEY', 'WAHA_DASHBOARD_PASSWORD')) {
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$name\s*=") { $idx = $i; break }
  }

  $current = if ($idx -ge 0) { ($lines[$idx] -replace "^\s*$name\s*=", '').Trim() } else { '' }

  if (Test-NeedsValue $current) {
    $key = New-HexKey            # 64 hex characters - what MFA_ENCRYPTION_KEY requires
    if ($idx -ge 0) { $lines[$idx] = "$name=$key" }
    else            { $lines += "$name=$key" }
    $changed += $name
  }
}

if ($changed.Count -gt 0) {
  # WriteAllLines emits UTF-8 WITHOUT a byte-order mark. Set-Content -Encoding utf8
  # on Windows PowerShell 5.1 would add one, and a BOM on the first line of .env
  # stops Compose recognising it as a comment.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($envFile, $lines, $utf8NoBom)
  Write-Host ("Generated: " + ($changed -join ', ')) -ForegroundColor Green
} else {
  Write-Host "Both secrets are already set - nothing to change" -ForegroundColor Green
}

# Read back what is actually in the file, so this reports the real values whether
# they were generated just now or were already there.
function EnvValue([string]$name, [string]$fallback) {
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -match "^\s*$name\s*=(.*)$") { $v = $Matches[1].Trim(); if ($v) { return $v } }
  }
  return $fallback
}

Write-Host ""
Write-Host "WAHA dashboard login (http://localhost:3001/dashboard):" -ForegroundColor Cyan
Write-Host ("  user      " + (EnvValue 'WAHA_DASHBOARD_USERNAME' 'admin'))
Write-Host ("  password  " + (EnvValue 'WAHA_DASHBOARD_PASSWORD' '(not set)'))
Write-Host "  This is NOT the API key. The API key is what you type into the"
Write-Host "  application at Communication > WhatsApp:"
Write-Host ("  api key   " + (EnvValue 'WAHA_API_KEY' '(not set)'))
Write-Host ""
Write-Host "Back up MFA_ENCRYPTION_KEY with your database dumps: it also encrypts" -ForegroundColor Yellow
Write-Host "HR and SIS provider secrets, which are unrecoverable without it." -ForegroundColor Yellow
Write-Host ""
Write-Host "Next:  docker compose up -d"
Write-Host "Then:  http://localhost:8080   (org care / sajidq@carepvtltd.com / Password123!)"
