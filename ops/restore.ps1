# Enterprise 360 - database + secrets restore (F21), Windows / PowerShell 5.1+.
# Restores a .zip produced by ops\backup.ps1 into the target database.
# DESTRUCTIVE to the target DB's current contents.
#
# Usage:   .\ops\restore.ps1 -Archive <path.zip> [-Yes]
# Env:     DATABASE_URL (else read from apps\api\.env)

param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Archive)) { Write-Error "Archive not found: $Archive"; exit 1 }

$RootDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RootDir "apps\api\.env"

$DatabaseUrl = $env:DATABASE_URL
if (-not $DatabaseUrl -and (Test-Path $EnvFile)) {
  $line = Select-String -Path $EnvFile -Pattern '^DATABASE_URL=' | Select-Object -First 1
  if ($line) { $DatabaseUrl = ($line.Line -replace '^DATABASE_URL=', '').Trim('"') }
}
if (-not $DatabaseUrl) { Write-Error "DATABASE_URL not set and not found in $EnvFile"; exit 1 }

if ($DatabaseUrl -match '^[^:]+://([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/([^?]+)') {
  $DbUser = $Matches[1]; $DbPass = $Matches[2]; $DbHost = $Matches[3]
  $DbPort = if ($Matches[4]) { $Matches[4] } else { "5432" }
  $DbName = $Matches[5]
} else { Write-Error "Could not parse DATABASE_URL"; exit 1 }

$Work = Join-Path $env:TEMP ("e360rs-" + (Get-Date).ToString("yyyyMMddHHmmss"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
Expand-Archive -Path $Archive -DestinationPath $Work -Force
$Dump = Join-Path $Work "db.dump"
if (-not (Test-Path $Dump)) { Write-Error "db.dump not found in archive"; exit 1 }

Write-Host "About to RESTORE into database '$DbName' on ${DbHost}:${DbPort}."
Write-Host "This DROPS and recreates the objects in that database."
if (-not $Yes) {
  $typed = Read-Host "Type the database name to confirm"
  if ($typed -ne $DbName) { Write-Error "Confirmation did not match. Aborting."; exit 1 }
}

$env:PGPASSWORD = $DbPass
$exists = (& psql -h $DbHost -p $DbPort -U $DbUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'")
if ($exists -ne "1") { & createdb -h $DbHost -p $DbPort -U $DbUser $DbName }

Write-Host "Restoring ..."
& pg_restore --clean --if-exists --no-owner --no-privileges -h $DbHost -p $DbPort -U $DbUser -d $DbName $Dump
# pg_restore may return non-zero on benign "does not exist, skipping" notices.

Write-Host ""
Write-Host "Database restore complete."
$bkEnv = Join-Path $Work "env.backup"
if (Test-Path $bkEnv) {
  $bkKey = (Select-String -Path $bkEnv -Pattern '^MFA_ENCRYPTION_KEY=' | Select-Object -First 1)
  $curKey = if (Test-Path $EnvFile) { Select-String -Path $EnvFile -Pattern '^MFA_ENCRYPTION_KEY=' | Select-Object -First 1 } else { $null }
  if ($bkKey -and (-not $curKey -or $bkKey.Line -ne $curKey.Line)) {
    Write-Host "ACTION REQUIRED: restore MFA_ENCRYPTION_KEY from the archive's env.backup"
    Write-Host "  so encrypted provider secrets / MFA seeds decrypt."
  } else {
    Write-Host "MFA_ENCRYPTION_KEY matches the current environment."
  }
}
Remove-Item -Recurse -Force $Work
Write-Host "Done. Restart the API and run a sanity check (see ops\BACKUP_RESTORE.md)."
