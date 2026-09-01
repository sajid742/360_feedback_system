# Enterprise 360 - database + secrets backup (F21), Windows / PowerShell 5.1+.
# Produces a timestamped .zip containing db.dump (pg_dump custom format),
# env.backup (apps/api/.env, which CONTAINS MFA_ENCRYPTION_KEY) and MANIFEST.txt.
#
# IMPORTANT: MFA_ENCRYPTION_KEY encrypts stored provider secrets (HR/SIS) and MFA
# seeds. A database restored WITHOUT the matching key cannot decrypt them, which
# is why the key is backed up alongside the data. Store the .zip securely.
#
# Usage:   .\ops\backup.ps1 [-BackupDir <path>] [-RetentionDays <n>]
# Env:     DATABASE_URL (else read from apps\api\.env)

param(
  [string]$BackupDir = "",
  [int]$RetentionDays = 14
)
$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RootDir "apps\api\.env"
if (-not $BackupDir) { $BackupDir = Join-Path $RootDir "backups" }

$DatabaseUrl = $env:DATABASE_URL
if (-not $DatabaseUrl -and (Test-Path $EnvFile)) {
  $line = Select-String -Path $EnvFile -Pattern '^DATABASE_URL=' | Select-Object -First 1
  if ($line) { $DatabaseUrl = ($line.Line -replace '^DATABASE_URL=', '').Trim('"') }
}
if (-not $DatabaseUrl) { Write-Error "DATABASE_URL not set and not found in $EnvFile"; exit 1 }

# Parse postgresql://user:pass@host:port/db
if ($DatabaseUrl -match '^[^:]+://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/([^?]+)') {
  $DbUser = $Matches[1]; $DbPass = $Matches[2]; $DbHost = $Matches[3]
  $DbPort = if ($Matches[4]) { $Matches[4] } else { "5432" }
  $DbName = $Matches[5]
} else { Write-Error "Could not parse DATABASE_URL"; exit 1 }

$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$Work = Join-Path $env:TEMP ("e360bk-" + $Stamp)
New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

Write-Host "Backing up database '$DbName' on ${DbHost}:${DbPort} ..."
$env:PGPASSWORD = $DbPass
& pg_dump -Fc -h $DbHost -p $DbPort -U $DbUser -d $DbName -f (Join-Path $Work "db.dump")
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed"; exit 1 }

if (Test-Path $EnvFile) {
  Copy-Item $EnvFile (Join-Path $Work "env.backup")
  Write-Host "Included apps\api\.env (contains MFA_ENCRYPTION_KEY)."
} else {
  Write-Warning "$EnvFile not found - MFA_ENCRYPTION_KEY is NOT in this backup."
}

$pgv = (& pg_dump --version | Select-Object -First 1)
@(
  "Enterprise 360 backup",
  "created_utc = $Stamp",
  "database    = $DbName",
  "host        = ${DbHost}:${DbPort}",
  "pg_dump     = $pgv",
  "format      = custom (pg_restore)",
  "includes    = db.dump, env.backup(MFA_ENCRYPTION_KEY), MANIFEST.txt"
) | Set-Content -Path (Join-Path $Work "MANIFEST.txt")

$Archive = Join-Path $BackupDir ("e360-backup-" + $Stamp + ".zip")
if (Test-Path $Archive) { Remove-Item $Archive }
Compress-Archive -Path (Join-Path $Work "*") -DestinationPath $Archive
Remove-Item -Recurse -Force $Work
Write-Host "Backup written: $Archive"

if ($RetentionDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -Path $BackupDir -Filter "e360-backup-*.zip" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Write-Host ("Pruned old backup: " + $_.Name); Remove-Item $_.FullName }
}
Write-Host "Done."
