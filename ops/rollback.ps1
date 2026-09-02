<#
.SYNOPSIS
  Restore a previous Enterprise 360 release as a complete set.

.DESCRIPTION
  Re-points all four application image names at the images recorded in ONE release
  manifest, then restarts the stack without rebuilding.

  Every image is verified to exist BEFORE the running stack is stopped. If any is missing
  the rollback aborts with the application still serving, rather than stopping it and then
  discovering it cannot be started again.

  IMAGES ONLY. This does not restore the database. See the warning it prints.

.EXAMPLE
  .\ops\rollback.ps1 -List

.EXAMPLE
  .\ops\rollback.ps1 -Release 2026-09-02-1500

.EXAMPLE
  # Roll back to the release before the current one.
  .\ops\rollback.ps1 -Previous

.NOTES
  Pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252.
#>
[CmdletBinding(DefaultParameterSetName = 'ById')]
param(
  [Parameter(ParameterSetName = 'ById')]
  [string]$Release = '',

  # Show every retained release and stop.
  [Parameter(ParameterSetName = 'List')]
  [switch]$List,

  # Roll back to the release immediately before the current one.
  [Parameter(ParameterSetName = 'Previous')]
  [switch]$Previous,

  [int]$Timeout = 180,

  # Do not ask for confirmation.
  [switch]$Force
)

Set-Location (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'release-lib.ps1')

$current = Get-CurrentReleaseId
$all = @(Get-AllReleases)

# ------------------------------------------------------------------- listing --

if ($List -or (-not $Release -and -not $Previous)) {
  Write-Host ''
  Write-Host '  Retained releases' -ForegroundColor Cyan
  Write-Host ''
  if ($all.Count -eq 0) {
    Write-Host '    none yet - deploy once with .\ops\deploy-release.ps1'
    Write-Host ''
    exit 0
  }
  Write-Host ('    {0,-22} {1,-20} {2,-10} {3}' -f 'RELEASE', 'CREATED', 'VERIFIED', 'IMAGES')
  foreach ($rel in $all) {
    $m = Read-Manifest $rel.Name
    $present = 0
    foreach ($img in $script:ReleaseImages) {
      $e = $m.images.($img.Key)
      if ($e -and (Test-ImageExists $e.id)) { $present++ }
    }
    $mark = if ($rel.Name -eq $current) { ' <- current' } else { '' }
    $colour = if ($present -eq $script:ReleaseImages.Count) { 'Green' } else { 'Red' }
    Write-Host ('    {0,-22} {1,-20} {2,-10} {3}/{4}{5}' -f `
      $rel.Name, $m.createdAt, $(if ($m.verified) { 'yes' } else { 'no' }), $present, $script:ReleaseImages.Count, $mark) -ForegroundColor $colour
    if ($m.dbBackup) { Write-Host ("      db dump: " + (Split-Path $m.dbBackup -Leaf)) -ForegroundColor DarkGray }
  }
  Write-Host ''
  Write-Host '    A release showing fewer than 4 images CANNOT be rolled back to.' -ForegroundColor Yellow
  Write-Host ''
  exit 0
}

# ------------------------------------------------------------------ resolving --

if ($Previous) {
  if ($all.Count -lt 2) { throw "Fewer than two releases are retained - there is nothing to roll back to." }
  if ($current) {
    $idx = [array]::IndexOf(($all | ForEach-Object { $_.Name }), $current)
    if ($idx -lt 1) { throw "The current release ($current) is the oldest retained - there is nothing before it." }
    $Release = $all[$idx - 1].Name
  } else {
    $Release = $all[$all.Count - 2].Name
  }
}

$manifest = Read-Manifest $Release
if (-not $manifest) {
  Write-Host ''
  Write-Bad "No release '$Release'."
  Write-Host '  Run  .\ops\rollback.ps1 -List  to see what is available.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

if ($Release -eq $current) {
  Write-Warn2 "Release $Release is already the current one. Nothing to do."
  exit 0
}

# --------------------------------------------------------------- confirmation --

Write-Host ''
Write-Host "  Roll back to $Release" -ForegroundColor Cyan
Write-Host "    created  $($manifest.createdAt)"
Write-Host "    commit   $($manifest.gitCommit)"
Write-Host "    from     $(if ($current) { $current } else { 'unknown' })"
Write-Host ''
foreach ($img in $script:ReleaseImages) {
  $e = $manifest.images.($img.Key)
  Write-Host ('    {0,-16} {1}' -f $e.repo, $e.id.Substring(0, 19))
}
Write-Host ''
Write-Host '  THIS RESTORES IMAGES ONLY.' -ForegroundColor Yellow
Write-Host '  The database, uploaded files, Redis queue and WhatsApp session are NOT changed.' -ForegroundColor Yellow
Write-Host '  Schema changes are forward-only: the database will stay AHEAD of this code, and' -ForegroundColor Yellow
Write-Host '  /ready will report "degraded" with a schema mismatch. That is expected here.' -ForegroundColor Yellow
if ($manifest.envSha256 -ne 'none') {
  $envNow = 'none'
  $envFile = Join-Path (Get-RepoRoot) '.env'
  if (Test-Path $envFile) { $envNow = (Get-FileHash $envFile -Algorithm SHA256).Hash.Substring(0, 16) }
  if ($envNow -ne $manifest.envSha256) {
    Write-Host ''
    Write-Host '  NOTE  .env has changed since this release was captured. The restored code will' -ForegroundColor Yellow
    Write-Host '        run with your CURRENT .env, not the one it shipped with.' -ForegroundColor Yellow
  }
}
Write-Host ''

if (-not $Force) {
  $answer = Read-Host '  Type the release id to confirm'
  if ($answer.Trim() -ne $Release) { Write-Host '  Cancelled. Nothing changed.' -ForegroundColor Yellow; exit 0 }
}

# ------------------------------------------------------------------- restore --

try {
  $ok = Restore-Release -ReleaseId $Release -TimeoutSeconds $Timeout
  Write-Host ''
  if ($ok) {
    Set-CurrentReleaseId $Release
    Write-Host "  ROLLED BACK to $Release and verified." -ForegroundColor Green
    if ($manifest.dbBackup) {
      Write-Host ''
      Write-Host '  A database dump from that release is available if the data also needs to go back:' -ForegroundColor Yellow
      Write-Host "      $($manifest.dbBackup)" -ForegroundColor Cyan
      Write-Host '      .\ops\restore.ps1     (restoring DISCARDS everything written since)'
    }
    Write-Host ''
    exit 0
  }
  Set-CurrentReleaseId $Release
  Write-Bad "Rolled back to $Release, but it did NOT pass verification."
  Write-Host '  The images are in place, so the problem is outside them - check the database,' -ForegroundColor Yellow
  Write-Host '  .env, and:  docker compose -f compose.yaml logs --tail 100' -ForegroundColor Yellow
  Write-Host ''
  exit 1
} catch {
  Write-Host ''
  Write-Bad 'ROLLBACK FAILED.'
  Write-Host "  $_" -ForegroundColor Red
  Write-Host ''
  Write-Host '  The exact images are listed in:' -ForegroundColor Yellow
  Write-Host "      releases\$Release\manifest.json" -ForegroundColor Cyan
  Write-Host '  ops\RELEASES.md section "Manual recovery" shows how to do this by hand.' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}
