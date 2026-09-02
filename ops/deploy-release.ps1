<#
.SYNOPSIS
  Deploy the Enterprise 360 stack as ONE versioned release, with automatic rollback.

.DESCRIPTION
  Treats the four locally built images as a single release unit:

      e360-api   e360-web   e360-mock-sis   e360-api-tools

  Before anything is overwritten the currently running set is TAGGED with a release id and
  recorded in a manifest, and the database is dumped. If the new release fails to become
  healthy or fails its smoke checks, the previous release is restored as a complete set -
  never a mixture of old web and new api.

  Nothing here changes compose.yaml, the Dockerfiles or the development workflow.
  start-docker.ps1 remains the first-run and development entry point.

  THE ORDER IS THE SAFETY PROPERTY:
    pre-flight  -> nothing has changed yet, so every failure here is free
    backup      -> must succeed, or we do not proceed
    build       -> does not touch running containers; a failure leaves the app serving
    up          -> the only genuinely destructive step
    verify      -> and roll back automatically if it does not pass

.EXAMPLE
  .\ops\deploy-release.ps1

.EXAMPLE
  .\ops\deploy-release.ps1 -Keep 3 -Timeout 300

.EXAMPLE
  # Deploy without taking a database dump (faster; only when you have one already).
  .\ops\deploy-release.ps1 -SkipDbBackup

.NOTES
  Pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252.
#>
[CmdletBinding()]
param(
  # Release identifier. Defaults to yyyy-MM-dd-HHmm.
  [string]$ReleaseId = '',
  # How many releases to retain.
  [int]$Keep = 5,
  # Seconds to wait for every gated container to become healthy.
  [int]$Timeout = 180,
  # Skip the pre-deployment database dump. Use only when you already have one.
  [switch]$SkipDbBackup,
  # Verify and back up, but do not build or deploy. Shows exactly what would happen.
  [switch]$WhatIfDeploy
)

Set-Location (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'release-lib.ps1')

if (-not $ReleaseId) { $ReleaseId = New-ReleaseId }
$startedAt = Get-Date

Write-Host ''
Write-Host "  Enterprise 360 - release deployment" -ForegroundColor Cyan
Write-Host "  New release id: $ReleaseId"
Write-Host ''

# ============================================================ 1. PRE-FLIGHT ====
# Everything here runs BEFORE anything changes, so a failure costs nothing.

Write-Step 1 'Pre-flight'

try { docker version --format '{{.Server.Version}}' 2>$null | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) { throw "Docker is not running. Start Docker Desktop, wait for the whale icon to settle, then re-run." }
Write-Ok 'Docker is running'

& (Join-Path $PSScriptRoot 'init-env.ps1')
if (-not (Test-Path (Join-Path (Get-RepoRoot) '.env'))) { throw ".env is missing and could not be created. Nothing has been changed." }

docker @script:Compose config --quiet
if ($LASTEXITCODE -ne 0) { throw "The compose configuration did not validate. Nothing has been changed. See ops\DOCKER.md section 27." }
Write-Ok 'compose.yaml is valid and every required variable is set'

$free = (Get-PSDrive -Name ((Get-Location).Path.Substring(0,1))).Free
if ($free -lt 5GB) { throw ("Only {0:N1} GB free on this drive. A build needs several GB; stopping before it fails half-way." -f ($free / 1GB)) }
Write-Ok ("{0:N1} GB free" -f ($free / 1GB))

# ==================================================== 2. IDENTIFY + 3. BACKUP ==

Write-Step 2 'Identifying the currently running release'

$previousId = Get-CurrentReleaseId
$anyImages = $false
foreach ($img in $script:ReleaseImages) { if (Get-ImageId $img.Repo) { $anyImages = $true } }

if (-not $anyImages) {
  Write-Warn2 'No existing application images - this is a FIRST DEPLOYMENT'
  Write-Warn2 'There is nothing to roll back to, so a failure will leave the stack down.'
  $backupId = $null
} else {
  $backupId = "$ReleaseId-prev"
  if ($previousId) { Write-Ok "current release: $previousId" } else { Write-Warn2 'images exist but no release manifest - capturing them as an unnamed baseline' }

  Write-Step 3 "Backing up the running release as $backupId"

  $dump = $null
  if ($SkipDbBackup) {
    Write-Warn2 'SKIPPING the database dump (-SkipDbBackup). Image rollback alone does not restore data.'
  } else {
    $dump = Backup-Database $backupId
    if ($dump) { Write-Ok ("database dumped: {0} ({1:N1} MB)" -f (Split-Path $dump -Leaf), ((Get-Item $dump).Length / 1MB)) }
  }

  $captured = Backup-CurrentRelease -ReleaseId $backupId -DbBackupPath $dump
  if (-not $captured) { throw "Backup produced nothing while images exist. Stopping rather than overwriting an unrecorded release." }
  Write-Ok "manifest written: releases\$backupId\manifest.json"
}

if ($WhatIfDeploy) {
  Write-Host ''
  Write-Host '  -WhatIfDeploy: stopping here. The running application is untouched and a' -ForegroundColor Yellow
  Write-Host "  restore point exists at $backupId." -ForegroundColor Yellow
  Write-Host ''
  exit 0
}

# ================================================================= 4. BUILD ====
# `build` writes new images but does not touch running containers. A failure here leaves
# the application serving on the previous release, which still carries its tags.

Write-Step 4 'Building the new images'
docker @script:Compose build
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Bad 'BUILD FAILED.'
  Write-Host '    The running application was not touched and is still serving.' -ForegroundColor Yellow
  if ($backupId) { Write-Host "    Restore point remains available: $backupId" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}
Write-Ok 'all images built'

# ================================================== 5. START + 6/7. VERIFY =====

Write-Step 5 'Starting the new release'
docker @script:Compose up -d
$upFailed = ($LASTEXITCODE -ne 0)

$healthy = $false
$smoke = @{ Passed = $false; Schema = '' }

if (-not $upFailed) {
  Write-Step 6 "Waiting for health (timeout ${Timeout}s)"
  $healthy = Wait-ForHealthy -TimeoutSeconds $Timeout
  $initOk = Test-DbInit

  if ($healthy -and $initOk) {
    Write-Step 7 'Smoke checks'
    $smoke = Invoke-SmokeChecks
  } else {
    Write-Bad 'skipping smoke checks - the stack did not become healthy'
  }
}

$deployOk = (-not $upFailed) -and $healthy -and $smoke.Passed

# =============================================== 8. SUCCESS / 9. ROLLBACK ======

if ($deployOk) {
  Write-Step 8 'Success - recording the release'

  $entries = @{}
  foreach ($img in $script:ReleaseImages) {
    $id = Get-ContainerImageId $img.Container
    if (-not $id) { $id = Get-ImageId $img.Repo }
    $tag = "$($img.Repo):$ReleaseId"
    docker tag $id $tag
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "could not tag $tag - this release will not be rollback-able" }
    $entries[$img.Key] = [pscustomobject]@{ service = $img.Service; repo = $img.Repo; tag = $tag; id = $id }
    Write-Ok "$($img.Repo) -> $tag"
  }

  Write-Manifest -ReleaseId $ReleaseId -Images $entries -DbBackupPath '' -Verified $true -SchemaVersion $smoke.Schema
  Set-CurrentReleaseId $ReleaseId
  Write-Ok "manifest written and marked current"

  Write-Step 9 "Retention (keeping $Keep)"
  Invoke-Retention -Keep $Keep

  $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
  Write-Host ''
  Write-Host "  DEPLOYED  $ReleaseId  (${elapsed}s)" -ForegroundColor Green
  Write-Host "  Application  $(Get-EnvValue 'PUBLIC_APP_URL' 'http://localhost:8080')"
  Write-Host "  Roll back    .\ops\rollback.ps1 -Release $backupId"
  Write-Host ''
  exit 0
}

# --- failure path -------------------------------------------------------------

Write-Host ''
Write-Bad 'DEPLOYMENT FAILED VERIFICATION.'
Write-Host ''

if (-not $backupId) {
  Write-Host '  This was a first deployment, so there is no previous release to restore.' -ForegroundColor Yellow
  Write-Host '  The stack has been left running so you can read the logs:' -ForegroundColor Yellow
  Write-Host '      docker compose -f compose.yaml logs --tail 100' -ForegroundColor Cyan
  Write-Host ''
  exit 1
}

Write-Host "  Rolling back to $backupId automatically." -ForegroundColor Yellow
Write-Host ''

try {
  $restored = Restore-Release -ReleaseId $backupId -TimeoutSeconds $Timeout
  Write-Host ''
  if ($restored) {
    Set-CurrentReleaseId $backupId
    Write-Host "  ROLLED BACK to $backupId and verified." -ForegroundColor Green
    Write-Host '  The failed release was NOT recorded, and its images are untagged.'
  } else {
    Write-Bad "ROLLED BACK to $backupId, but it did NOT pass verification."
    Write-Host '  The previous images are in place. Something outside the images is wrong -' -ForegroundColor Yellow
    Write-Host '  check the database, .env and the logs:' -ForegroundColor Yellow
    Write-Host '      docker compose -f compose.yaml logs --tail 100' -ForegroundColor Cyan
  }
} catch {
  Write-Host ''
  Write-Bad 'ROLLBACK FAILED.'
  Write-Host "  $_" -ForegroundColor Red
  Write-Host ''
  Write-Host '  Recover by hand:' -ForegroundColor Yellow
  Write-Host "      .\ops\rollback.ps1 -Release $backupId" -ForegroundColor Cyan
  Write-Host "  The manifest listing the exact images is at releases\$backupId\manifest.json" -ForegroundColor Yellow
}

$m = Read-Manifest $backupId
if ($m -and $m.dbBackup) {
  Write-Host ''
  Write-Host '  A database dump was taken before this deployment:' -ForegroundColor Yellow
  Write-Host "      $($m.dbBackup)" -ForegroundColor Cyan
  Write-Host '  It is NOT restored automatically - that would discard everything written since.'
  Write-Host '  Restore it deliberately with ops\restore.ps1 only if the schema or data is wrong.'
}
Write-Host ''
exit 1
