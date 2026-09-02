<#
.SYNOPSIS
  Starts the entire Enterprise 360 ecosystem in Docker - one command, from a fresh unzip.

.DESCRIPTION
  Equivalent to running ops\init-env.ps1 followed by `docker compose up -d`, with the
  checks that make the difference between a clear message and a puzzling one:

    1. Docker is installed and running
    2. .env exists and both required secrets are set   (generated if not)
    3. The compose file interpolates cleanly           (fails here, not half-way up)
    4. docker compose up -d --build   (see -NoBuild for why the build is not optional)
    5. Prints where everything is

  Safe to re-run. It never overwrites a secret you have already set, so it cannot
  silently invalidate the key that encrypts your HR and SIS provider secrets.

  This is the DOCKER entry point for DEVELOPMENT and FIRST RUNS. The from-source workflow
  is unchanged and still starts with deploy.ps1 / start-dev.ps1.

  FOR A WORKING INSTALLATION YOU CANNOT AFFORD TO LOSE, use ops\deploy-release.ps1
  instead. This script rebuilds the images in place, which leaves the previous ones
  dangling and therefore prunable; deploy-release.ps1 tags and records the running set
  first, verifies the new one, and restores the previous release automatically if it
  fails. See ops\RELEASES.md. Nothing about this script's behaviour has changed.

.EXAMPLE
  .\start-docker.ps1

.EXAMPLE
  # If PowerShell refuses to run it because it is unsigned:
  powershell -ExecutionPolicy Bypass -File .\start-docker.ps1

.NOTES
  The first run builds four images and takes 5-15 minutes. Later runs take seconds.
#>
[CmdletBinding()]
param(
  # Skip the image build and start whatever images already exist.
  #
  # NOT the default, deliberately. compose.yaml pins fixed, untagged image names
  # (e360-api, e360-web, e360-api-tools), so `docker compose up -d` on its own REUSES an
  # image of that name built from any other folder - including an older release unzipped
  # somewhere else. The stack then silently runs the previous version's code, which is
  # indistinguishable from "my fix did not apply". Building by default makes this script
  # mean "start THIS folder's application". Docker's layer cache keeps an unchanged
  # rebuild to a few seconds.
  [switch]$NoBuild,
  # Follow the initialisation log once the stack is up.
  [switch]$Logs
)

# NOTE: we deliberately do NOT set $ErrorActionPreference = 'Stop', for the same reason
# deploy.ps1 does not. Native tools write progress and warnings to stderr as a matter of
# course - Docker prints "Found multiple config files" on EVERY command in this folder,
# because both compose.yaml and docker-compose.yml exist. Windows PowerShell turns any
# such stderr line into a NativeCommandError, and under 'Stop' that is fatal. Every real
# failure below is raised with an explicit `throw`, which terminates regardless.
Set-Location $PSScriptRoot

# Pin the compose file. Without -f, Compose finds both compose.yaml and docker-compose.yml
# and prints a warning to stderr every single time; pinning removes the warning at source
# rather than filtering it afterwards, and guarantees the FULL stack is what we act on.
$Compose = @('compose', '-f', 'compose.yaml')

# Capture a native command's stdout without letting its stderr become a PowerShell error.
# Belt and braces alongside the two measures above: a captured assignment is where
# Windows PowerShell is most eager to promote stderr into a terminating error.
function Invoke-Capture([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command 2>$null } finally { $ErrorActionPreference = $prev }
}

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    $text" -ForegroundColor Green }
function Warn($text)     { Write-Host "    $text" -ForegroundColor Yellow }

Step 1 'Checking Docker'
try { docker version --format '{{.Server.Version}}' 2>$null | Out-Null } catch { }
if ($LASTEXITCODE -ne 0) {
  throw "Docker is not running. Start Docker Desktop, wait for the whale icon to settle, then re-run."
}
$composeVersion = Invoke-Capture { docker @Compose version --short }
if ($LASTEXITCODE -ne 0) {
  throw "This Docker install has no 'docker compose' subcommand (Compose v2). Update Docker Desktop."
}
Ok "Docker is running; Compose $composeVersion"

Step 2 'Environment file'
& (Join-Path $PSScriptRoot 'ops\init-env.ps1')

Step 3 'Validating the compose configuration'
# --quiet parses and interpolates without printing the merged file. A missing secret
# fails HERE, with the same message but before anything has been built or started.
docker @Compose config --quiet
if ($LASTEXITCODE -ne 0) {
  throw "The compose configuration did not validate. The message above says why; ops\DOCKER.md section 27 lists the usual causes."
}
Ok 'compose.yaml is valid and every required variable is set'

Step 4 'Starting the stack'
if ($NoBuild) {
  Warn 'Skipping the build (-NoBuild). If this folder is a newer release than the images,'
  Warn 'you will be running the OLDER code. Re-run without -NoBuild to rebuild.'
  docker @Compose up -d
} else {
  Warn 'The first run builds four images. Expect 5-15 minutes; later runs take seconds.'
  docker @Compose up -d --build
}
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed. See the output above." }

$envLines = [System.IO.File]::ReadAllLines((Join-Path $PSScriptRoot '.env'))
function EnvValue([string]$name, [string]$fallback) {
  foreach ($line in $envLines) {
    if ($line -match "^\s*$name\s*=(.*)$") { $v = $Matches[1].Trim(); if ($v) { return $v } }
  }
  return $fallback
}

Step 5 'Database initialisation'
# `docker compose up -d` returns as soon as the containers are CREATED, which says
# nothing about whether db-init actually finished its work. Everything that makes the
# stack usable - schema, permissions, the administrator, the demo dataset - happens in
# that one-shot container, and until now a failure there was silent: the script printed
# a cheerful list of URLs and the user found an empty application.
$initExit = Invoke-Capture { docker inspect --format '{{.State.ExitCode}}' e360-db-init }
if ($LASTEXITCODE -ne 0 -or $null -eq $initExit) {
  Warn 'Could not read the db-init container. Check: docker compose logs db-init'
} elseif ("$initExit".Trim() -ne '0') {
  Write-Host ""
  Write-Host "  Initialisation FAILED (db-init exited $initExit)." -ForegroundColor Red
  Write-Host "  The stack is running but the database may be incomplete - no demo data,"
  Write-Host "  possibly no administrator. The reason is in the log:"
  Write-Host ""
  Write-Host "      docker compose logs db-init" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  After fixing the cause, re-run initialisation on its own:"
  Write-Host "      docker compose run --rm db-init" -ForegroundColor Cyan
  Write-Host ""
} else {
  Ok 'db-init completed successfully'
  # Confirm the demo dataset really landed rather than assuming it did. db:demo stops
  # silently when its marker cycle already exists, so "it ran" and "there is data" are
  # genuinely different questions.
  $dbName = EnvValue 'POSTGRES_DB' 'enterprise360'
  $count = Invoke-Capture { docker @Compose exec -T postgres psql -U postgres -d $dbName -tAc "SELECT count(*) FROM employees" }
  if ($LASTEXITCODE -eq 0 -and $count) {
    $n = [int]("$count".Trim())
    if ($n -gt 0) {
      Ok "demo data present ($n employees)"
    } else {
      Write-Host ""
      Write-Host "  The database is set up but contains no employees." -ForegroundColor Yellow
      Write-Host "  If you expected the demo dataset, load it with:"
      Write-Host "      docker compose run --rm -e DEMO_RESEED=true db-init" -ForegroundColor Cyan
      Write-Host "  (SEED_DEMO_DATA=false in .env skips it deliberately.)"
      Write-Host ""
    }
  }
}

Step 6 'Status'
docker @Compose ps

$appUrl = EnvValue 'PUBLIC_APP_URL' 'http://localhost:8080'
$slug   = EnvValue 'ORG_SLUG'       'care'
$email  = EnvValue 'ADMIN_EMAIL'    'sajidq@carepvtltd.com'

# PUBLIC_APP_URL decides what every outbound link says. Left at localhost on a machine
# other people use, parent-evaluation invitations go out pointing at the RECIPIENT'S own
# computer: delivered, token spent, link dead. Say so here, where it is still cheap to fix.
if ($appUrl -match '^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)') {
  $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -in @('Dhcp','Manual') } |
    Select-Object -First 1 -ExpandProperty IPAddress)
  Write-Host ""
  Write-Host "  NOTE  PUBLIC_APP_URL is $appUrl" -ForegroundColor Yellow
  Write-Host "        Fine on this machine only. Parent-evaluation and password-reset links are"
  Write-Host "        built from it, so anyone else receives a link to their OWN computer."
  if ($lan) {
    Write-Host "        For access from phones or other machines, set in .env:"
    Write-Host "            PUBLIC_APP_URL=http://${lan}:8080" -ForegroundColor Cyan
    Write-Host "        then: docker compose up -d"
  }
}

Write-Host ""
Write-Host "  Application   $appUrl" -ForegroundColor Green
Write-Host "  Sign in       organisation '$slug' / $email"
Write-Host ""
Write-Host "  Mock SIS      http://localhost:3100/admin"
Write-Host "  API health    http://localhost:3000/health"
Write-Host ""
Write-Host "  WAHA          http://localhost:3001/dashboard" -ForegroundColor Green
Write-Host ("    dashboard login   " + (EnvValue 'WAHA_DASHBOARD_USERNAME' 'admin') + " / " + (EnvValue 'WAHA_DASHBOARD_PASSWORD' '(not set)'))
Write-Host ("    API key           " + (EnvValue 'WAHA_API_KEY' '(not set)'))
Write-Host "    The dashboard login is basic auth for the browser. The API key is what"
Write-Host "    you enter in the app at Communication > WhatsApp. See ops\DOCKER.md 19.3."
Write-Host ""
Write-Host "  Initialisation runs on every start and is a no-op after the first:"
Write-Host "      docker compose logs -f db-init"
Write-Host "  Stop (KEEPS your data):"
Write-Host "      docker compose down"
Write-Host ""

if ($Logs) {
  Write-Host "Following db-init. Ctrl+C to stop watching; the stack keeps running." -ForegroundColor Cyan
  docker @Compose logs -f db-init
}
