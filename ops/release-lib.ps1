<#
  Shared helpers for deploy-release.ps1 and rollback.ps1.

  Dot-source it:   . (Join-Path $PSScriptRoot 'release-lib.ps1')

  WHY ONE LIBRARY. Deployment and rollback must agree on what "the release set" is, what
  "healthy" means and how a manifest is read. Two copies of that logic drift, and the way
  they drift is a rollback that restores three images out of four.

  NOTE ON $ErrorActionPreference. This file deliberately does NOT set it to 'Stop', for
  the same reason start-docker.ps1 and deploy.ps1 do not: native tools write progress and
  warnings to stderr as a matter of course, and Windows PowerShell turns any such line
  into a NativeCommandError which is fatal under 'Stop'. Every real failure is raised with
  an explicit throw, which terminates regardless.

  PURE ASCII on purpose. Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252, so
  a stray en-dash or curly quote becomes a parse error on a line that looks perfectly fine.
#>

# ------------------------------------------------------------------ constants --

# Compose is pinned. Without -f, Compose finds both compose.yaml and docker-compose.yml,
# warns on every command, and - worse for us - could act on the wrong stack.
$script:Compose = @('compose', '-f', 'compose.yaml')

<#
  THE RELEASE SET. Four locally built images, and all four move together.

  api-tools is easy to mistake for a build artefact. It is not: db-init runs on every
  `up` and applies database/000_initial_schema.sql and 001_reconcile.sql from INSIDE that
  image, so the SQL a deployment applies is part of the release.

  postgres, redis and waha are upstream images. They are recorded in the manifest for
  diagnosis but never tagged or rolled back - they are not ours to version.
#>
$script:ReleaseImages = @(
  [pscustomobject]@{ Key = 'api';       Service = 'api';      Container = 'e360-api';      Repo = 'e360-api'       }
  [pscustomobject]@{ Key = 'web';       Service = 'web';      Container = 'e360-web';      Repo = 'e360-web'       }
  [pscustomobject]@{ Key = 'mock-sis';  Service = 'mock-sis'; Container = 'e360-mock-sis'; Repo = 'e360-mock-sis'  }
  [pscustomobject]@{ Key = 'api-tools'; Service = 'db-init';  Container = 'e360-db-init';  Repo = 'e360-api-tools' }
)

# Containers that must reach "healthy" before a deployment counts as started.
# waha is deliberately excluded: it boots a browser engine (90s start_period) and
# WhatsApp is not on the critical path for the application being usable.
$script:HealthGate = @('e360-postgres', 'e360-redis', 'e360-api', 'e360-web', 'e360-mock-sis')

# ------------------------------------------------------------------- plumbing --

function Write-Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Write-Ok($text)       { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text)    { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Bad($text)      { Write-Host "    $text" -ForegroundColor Red }

<#
  Capture a native command's stdout without letting its stderr become a terminating
  PowerShell error. A captured assignment is where Windows PowerShell is most eager to
  promote stderr into an error, so every `docker ... | capture` goes through this.
#>
function Invoke-Capture([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>$null } finally { $ErrorActionPreference = $prev }
}

function Get-RepoRoot { Split-Path -Parent $PSScriptRoot }

function Get-ReleaseRoot {
  $p = Join-Path (Get-RepoRoot) 'releases'
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  return $p
}

function Get-BackupRoot {
  $p = Join-Path (Get-RepoRoot) 'backups'
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  return $p
}

function New-ReleaseId { (Get-Date).ToString('yyyy-MM-dd-HHmm') }

<# Read a value out of the repo-root .env, with a fallback. #>
function Get-EnvValue([string]$Name, [string]$Fallback) {
  $envFile = Join-Path (Get-RepoRoot) '.env'
  if (-not (Test-Path $envFile)) { return $Fallback }
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -match "^\s*$Name\s*=(.*)$") {
      $v = $Matches[1].Trim()
      if ($v) { return $v }
    }
  }
  return $Fallback
}

# --------------------------------------------------------------------- images --

<# The image ID a repo name currently points at, or $null if it does not exist. #>
function Get-ImageId([string]$Repo) {
  $id = Invoke-Capture { docker image inspect --format '{{.Id}}' $Repo }
  if ($LASTEXITCODE -ne 0 -or -not $id) { return $null }
  return "$id".Trim()
}

<# The image ID a RUNNING container was started from, or $null. This is the more honest
   source for "what is actually serving right now": the repo tag may have been moved by a
   build that has not been started yet. #>
function Get-ContainerImageId([string]$Container) {
  $id = Invoke-Capture { docker inspect --format '{{.Image}}' $Container }
  if ($LASTEXITCODE -ne 0 -or -not $id) { return $null }
  return "$id".Trim()
}

function Test-ImageExists([string]$Ref) {
  Invoke-Capture { docker image inspect $Ref } | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# ------------------------------------------------------------------ manifests --

function Get-ManifestPath([string]$ReleaseId) {
  Join-Path (Join-Path (Get-ReleaseRoot) $ReleaseId) 'manifest.json'
}

function Read-Manifest([string]$ReleaseId) {
  $p = Get-ManifestPath $ReleaseId
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-CurrentReleaseId {
  $p = Join-Path (Get-ReleaseRoot) 'current.txt'
  if (-not (Test-Path $p)) { return $null }
  $v = (Get-Content $p -Raw).Trim()
  if ($v) { return $v } else { return $null }
}

function Set-CurrentReleaseId([string]$ReleaseId) {
  Set-Content -Path (Join-Path (Get-ReleaseRoot) 'current.txt') -Value $ReleaseId -Encoding ASCII
}

function Get-AllReleases {
  Get-ChildItem (Get-ReleaseRoot) -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } |
    Sort-Object Name
}

<#
  Capture the CURRENTLY RUNNING release: tag all four images with the release id, then
  write a manifest recording their IDs.

  The tag is not decoration. compose.yaml pins untagged names, so a rebuild leaves the
  previous image dangling - and a dangling image is deleted by `docker image prune`,
  `docker system prune` and Docker Desktop's own "Clean up" button. Tagging is what stops
  Docker garbage-collecting the rollback target.

  Returns $true if a release was captured, $false if there was nothing to capture (a first
  deployment). Throws if capture was attempted and failed - the caller must not proceed.
#>
function Backup-CurrentRelease([string]$ReleaseId, [string]$DbBackupPath) {
  $entries = @{}
  $found = 0

  foreach ($img in $script:ReleaseImages) {
    # Prefer what the container is actually running; fall back to the tag.
    $id = Get-ContainerImageId $img.Container
    if (-not $id) { $id = Get-ImageId $img.Repo }
    if (-not $id) {
      Write-Warn2 "no existing image for $($img.Repo) - nothing to back up for this service"
      continue
    }

    $tag = "$($img.Repo):$ReleaseId"
    docker tag $id $tag
    if ($LASTEXITCODE -ne 0) { throw "Could not tag $id as $tag. Backup FAILED - deployment stopped before anything was overwritten." }

    $entries[$img.Key] = [pscustomobject]@{
      service = $img.Service
      repo    = $img.Repo
      tag     = $tag
      id      = $id
    }
    $found++
    Write-Ok "$($img.Repo) -> $tag"
  }

  if ($found -eq 0) { return $false }
  if ($found -ne $script:ReleaseImages.Count) {
    throw "Only $found of $($script:ReleaseImages.Count) images could be captured. A partial backup cannot be rolled back as a set - stopping."
  }

  Write-Manifest -ReleaseId $ReleaseId -Images $entries -DbBackupPath $DbBackupPath -Verified $true
  return $true
}

function Write-Manifest {
  param(
    [string]$ReleaseId,
    [hashtable]$Images,
    [string]$DbBackupPath,
    [bool]$Verified,
    [string]$SchemaVersion = ''
  )
  $dir = Join-Path (Get-ReleaseRoot) $ReleaseId
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $git = Invoke-Capture { git -C (Get-RepoRoot) rev-parse --short HEAD }
  if ($LASTEXITCODE -ne 0) { $git = 'not-a-git-repo' }

  $envFile = Join-Path (Get-RepoRoot) '.env'
  $envHash = 'none'
  if (Test-Path $envFile) { $envHash = (Get-FileHash $envFile -Algorithm SHA256).Hash.Substring(0, 16) }

  $manifest = [pscustomobject]@{
    release        = $ReleaseId
    createdAt      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    composeProject = 'e360'
    gitCommit      = "$git".Trim()
    images         = [pscustomobject]$Images
    upstream       = [pscustomobject]@{
      postgres = 'postgres:16-alpine'
      redis    = 'redis:7-alpine'
      waha     = (Get-EnvValue 'WAHA_IMAGE' 'devlikeapro/waha:latest')
    }
    schemaVersion  = $SchemaVersion
    dbBackup       = $DbBackupPath
    envSha256      = $envHash
    verified       = $Verified
  }

  $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $dir 'manifest.json') -Encoding ASCII
  Copy-Item (Join-Path (Get-RepoRoot) 'compose.yaml') (Join-Path $dir 'compose.yaml') -Force
}

# ---------------------------------------------------------------- db backup ----

<#
  Dump the database THROUGH THE CONTAINER, not from the host.

  ops/backup.ps1 shells out to a host `pg_dump`, which needs PostgreSQL client tools
  installed. That is fine for scheduled operational backups on your machine and wrong for
  a deployment safety net on a customer box that has only Docker Desktop. Dumping inside
  the container and copying the file out needs nothing but Docker.

  Returns the path written, or $null if the database was not running (a first deployment).
  Throws on a real failure - a deployment must not proceed on a failed backup.
#>
function Backup-Database([string]$ReleaseId) {
  $running = Invoke-Capture { docker inspect --format '{{.State.Running}}' e360-postgres }
  if ($LASTEXITCODE -ne 0 -or "$running".Trim() -ne 'true') {
    Write-Warn2 'PostgreSQL is not running - no database to back up (first deployment?)'
    return $null
  }

  $user = Get-EnvValue 'POSTGRES_USER' 'postgres'
  $db   = Get-EnvValue 'POSTGRES_DB'   'enterprise360'
  $out  = Join-Path (Get-BackupRoot) "db-$ReleaseId.dump"

  # -Fc is the custom format restore.ps1 already expects. Written inside the container
  # first, then copied out, so no binary stream passes through PowerShell's stdout.
  docker @script:Compose exec -T postgres pg_dump -Fc -U $user -d $db -f /tmp/e360-deploy.dump
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed. Backup FAILED - deployment stopped before anything was changed." }

  docker @script:Compose cp postgres:/tmp/e360-deploy.dump $out
  if ($LASTEXITCODE -ne 0) { throw "Could not copy the dump out of the container. Backup FAILED - deployment stopped." }

  Invoke-Capture { docker @script:Compose exec -T postgres rm -f /tmp/e360-deploy.dump } | Out-Null

  if (-not (Test-Path $out) -or (Get-Item $out).Length -lt 1024) {
    throw "The database dump is missing or implausibly small. Backup FAILED - deployment stopped."
  }
  return $out
}

# ------------------------------------------------------------------- health ----

<#
  Wait until every gated container reports healthy.

  `docker compose up -d` returns as soon as containers are CREATED, which says nothing
  about whether anything works. This is the gate the current start-docker.ps1 lacks.
#>
function Wait-ForHealthy([int]$TimeoutSeconds = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $pending  = [System.Collections.ArrayList]@($script:HealthGate)

  while ((Get-Date) -lt $deadline -and $pending.Count -gt 0) {
    foreach ($name in @($pending)) {
      $status = Invoke-Capture { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $name }
      $status = "$status".Trim()
      if ($status -eq 'healthy' -or $status -eq 'running') {
        Write-Ok "$name is $status"
        $pending.Remove($name)
      } elseif ($status -eq 'unhealthy' -or $status -eq 'exited') {
        Write-Bad "$name is $status"
        return $false
      }
    }
    if ($pending.Count -gt 0) { Start-Sleep -Seconds 3 }
  }

  if ($pending.Count -gt 0) {
    Write-Bad ("timed out after ${TimeoutSeconds}s waiting for: " + ($pending -join ', '))
    return $false
  }
  return $true
}

<# db-init is one-shot: it has no healthcheck, only an exit code. #>
function Test-DbInit {
  $code = Invoke-Capture { docker inspect --format '{{.State.ExitCode}}' e360-db-init }
  if ($LASTEXITCODE -ne 0) { Write-Warn2 'could not read e360-db-init - check: docker compose logs db-init'; return $false }
  if ("$code".Trim() -ne '0') { Write-Bad "db-init exited $code - the database may be incomplete"; return $false }
  Write-Ok 'db-init completed successfully'
  return $true
}

function Invoke-HttpCheck([string]$Label, [string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -eq 200) { Write-Ok "$Label 200  $Url"; return $r }
    Write-Bad "$Label $($r.StatusCode)  $Url"
    return $null
  } catch {
    Write-Bad "$Label unreachable  $Url"
    return $null
  }
}

<#
  Smoke checks. Returns a hashtable: Passed (bool) and Schema (string, informational).

  A schema mismatch is a WARNING, not a failure. /ready gates readiness on the database
  being up alone and reports an outdated schema as "degraded" - which is what makes a
  rollback possible at all, since rolled-back code always trails the database. It must be
  named clearly rather than silently passing.
#>
function Invoke-SmokeChecks {
  $apiPort  = Get-EnvValue 'API_PORT'      '3000'
  $webPort  = Get-EnvValue 'WEB_PORT'      '8080'
  $sisPort  = Get-EnvValue 'MOCK_SIS_PORT' '3100'
  $ok = $true
  $schemaNote = ''

  if (-not (Invoke-HttpCheck 'api  /health ' "http://localhost:$apiPort/health"))       { $ok = $false }
  if (-not (Invoke-HttpCheck 'web  /       ' "http://localhost:$webPort/"))             { $ok = $false }
  if (-not (Invoke-HttpCheck 'sis  /health ' "http://localhost:$sisPort/api/v1/health")) { $ok = $false }

  $ready = Invoke-HttpCheck 'api  /ready  ' "http://localhost:$apiPort/ready"
  if (-not $ready) {
    $ok = $false
  } else {
    try {
      $j = $ready.Content | ConvertFrom-Json
      if ($j.checks.database.status -ne 'up') { Write-Bad "database check reports '$($j.checks.database.status)'"; $ok = $false }
      if ($j.checks.redis.status -ne 'up')    { Write-Warn2 "redis is $($j.checks.redis.status) - delivery falls back to inline" }
      if ($j.checks.schema.status -eq 'outdated') {
        $schemaNote = "expected $($j.checks.schema.expected), applied $($j.checks.schema.applied)"
        Write-Warn2 "SCHEMA MISMATCH: $schemaNote"
        Write-Warn2 'Expected after a rollback (the database stays ahead of the code). Not expected after a forward deployment.'
      } else {
        $schemaNote = $j.checks.schema.applied
      }
    } catch { Write-Warn2 'could not parse /ready - continuing on the status code alone' }
  }

  # The database is reachable AND actually populated - two different questions.
  $db = Get-EnvValue 'POSTGRES_DB' 'enterprise360'
  $usr = Get-EnvValue 'POSTGRES_USER' 'postgres'
  $count = Invoke-Capture { docker @script:Compose exec -T postgres psql -U $usr -d $db -tAc "SELECT count(*) FROM employees" }
  if ($LASTEXITCODE -eq 0 -and $count) {
    $n = 0; [void][int]::TryParse("$count".Trim(), [ref]$n)
    if ($n -gt 0) { Write-Ok "employees table has $n rows" } else { Write-Warn2 'employees table is empty (SEED_DEMO_DATA=false?)' }
  } else {
    Write-Bad 'could not query the employees table'
    $ok = $false
  }

  return @{ Passed = $ok; Schema = $schemaNote }
}

# ----------------------------------------------------------------- rollback ----

<#
  Restore a complete release.

  The order matters and is the whole safety property: EVERY image is verified to exist
  BEFORE the running stack is touched. If one is missing we abort with the application
  still serving, rather than stopping it and then discovering we cannot start it again.
#>
function Restore-Release([string]$ReleaseId, [int]$TimeoutSeconds = 180) {
  $m = Read-Manifest $ReleaseId
  if (-not $m) { throw "No manifest for release '$ReleaseId'. Nothing has been changed." }

  Write-Step 1 "Verifying every image in release $ReleaseId"
  $missing = @()
  foreach ($img in $script:ReleaseImages) {
    $entry = $m.images.($img.Key)
    if (-not $entry) { $missing += "$($img.Key) (not in the manifest)"; continue }
    if (-not (Test-ImageExists $entry.id)) { $missing += "$($entry.repo) $($entry.id.Substring(0,19))" }
  }
  if ($missing.Count -gt 0) {
    Write-Host ''
    $missing | ForEach-Object { Write-Bad $_ }
    throw "Release $ReleaseId is incomplete - $($missing.Count) image(s) missing. ABORTED before stopping anything; the current application is still running."
  }
  Write-Ok "all $($script:ReleaseImages.Count) images present"

  Write-Step 2 'Stopping the current stack (containers only - volumes are untouched)'
  docker @script:Compose down
  if ($LASTEXITCODE -ne 0) { Write-Warn2 'compose down reported a problem; continuing to re-point images' }

  Write-Step 3 'Re-pointing every image name from the one manifest'
  foreach ($img in $script:ReleaseImages) {
    $entry = $m.images.($img.Key)
    docker tag $entry.id $entry.repo
    if ($LASTEXITCODE -ne 0) { throw "Could not re-point $($entry.repo). The stack is DOWN - fix Docker and re-run this rollback." }
    Write-Ok "$($entry.repo) -> $($entry.id.Substring(0,19))"
  }

  Write-Step 4 'Starting the restored release'
  # NO --build. Rebuilding would compile the CURRENT source into an old tag, which is
  # precisely the failure this whole mechanism exists to prevent.
  docker @script:Compose up -d --no-build
  if ($LASTEXITCODE -ne 0) { throw "Could not start the restored release. The images are in place; try: docker compose -f compose.yaml up -d" }

  Write-Step 5 'Waiting for health'
  $healthy = Wait-ForHealthy -TimeoutSeconds $TimeoutSeconds
  Test-DbInit | Out-Null

  Write-Step 6 'Smoke checks'
  $smoke = Invoke-SmokeChecks

  return ($healthy -and $smoke.Passed)
}

# ---------------------------------------------------------------- retention ----

<#
  Drop release tags beyond the retention limit.

  TWO RULES, both load-bearing:
    1. Only ever remove a TAG, never an image ID. Removing a tag that is not the last
       reference frees nothing and cannot break another release; removing an ID can.
    2. Never `docker image prune -a` from here. Docker Desktop's "Clean up" button does
       that, which is exactly why tagging is the mechanism.
#>
function Invoke-Retention([int]$Keep = 5) {
  $all = @(Get-AllReleases)
  if ($all.Count -le $Keep) { Write-Ok "$($all.Count) release(s) retained (limit $Keep) - nothing to remove"; return }

  $current = Get-CurrentReleaseId
  $drop = $all[0..($all.Count - $Keep - 1)]

  foreach ($rel in $drop) {
    if ($rel.Name -eq $current) { Write-Warn2 "skipping $($rel.Name) - it is the current release"; continue }
    $m = Read-Manifest $rel.Name
    if ($m) {
      foreach ($img in $script:ReleaseImages) {
        $entry = $m.images.($img.Key)
        if ($entry -and (Test-ImageExists $entry.tag)) {
          Invoke-Capture { docker rmi $entry.tag } | Out-Null
        }
      }
    }
    Remove-Item $rel.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "removed release $($rel.Name)"
  }
}
