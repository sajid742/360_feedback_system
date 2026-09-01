<#
  Enterprise 360 - one-command Windows deployment.
  Verified on Node 22 + PostgreSQL 16 (Docker).

  Usage (from the project root, in PowerShell):
      ./deploy.ps1                 # set up DB + admin + sample data
      ./deploy.ps1 -Run            # ...and launch the dev servers at the end
      ./deploy.ps1 -NoSampleData   # skip the demo dataset
  Optional overrides:
      ./deploy.ps1 -AdminEmail sajidq@carepvtltd.com -AdminPassword "Secret123!" -OrgSlug care -Run

  Prerequisites: Node.js 20+, Docker Desktop running.
  (No local psql/PostgreSQL needed - it runs inside the Docker container.)
#>
param(
  [string]$OrgName = "CARE Pvt. Ltd.",
  [string]$OrgSlug = "care",
  [string]$AdminEmail = "sajidq@carepvtltd.com",
  [string]$AdminPassword = "ChangeMe123!",
  [string]$DbName = "enterprise360",
  # The address people actually type to reach this application. Every outbound link
  # (parent evaluations, password resets, short links) is built from it. Leave blank
  # for a single developer machine; set it for anything others must reach.
  #   .\deploy.ps1 -PublicAppUrl "http://192.168.1.20:5173"
  [string]$PublicAppUrl = "",
  [switch]$NoSampleData,   # skip loading the demo dataset
  [switch]$Run             # start the API + web dev servers when finished
)

# NOTE: we deliberately do NOT set $ErrorActionPreference = 'Stop'. Native tools
# used below (docker, npm, prisma, psql) routinely write warnings to stderr - e.g.
# Docker's "WARNING: No blkio throttle..." - and under 'Stop' Windows PowerShell
# turns any such stderr line into a fatal NativeCommandError, aborting the deploy.
# Instead we check each command's real exit code via Run/Need and stop on genuine
# failures only.
$ErrorActionPreference = "Continue"

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
# Run a native command and stop the script if it returns a non-zero exit code.
function Run([string]$desc, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$desc failed (exit code $LASTEXITCODE)." }
}
function Need([bool]$ok, [string]$msg) { if (-not $ok) { throw $msg } }

Step "1/11  Checking prerequisites"
node -v; npm -v
docker info 1>$null 2>$null
Need ($LASTEXITCODE -eq 0) "Docker Desktop is not running (or 'docker info' failed). Start Docker Desktop and re-run."

Step "2/11  Starting PostgreSQL + Redis (docker compose)"
Run "docker compose up" { docker compose -f docker-compose.yml up -d }
Write-Host "Waiting for PostgreSQL to accept connections..."
$ok = $false
foreach ($i in 1..30) {
  docker compose -f docker-compose.yml exec -T postgres pg_isready -U postgres 1>$null 2>$null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  Start-Sleep -Seconds 2
}
Need $ok "PostgreSQL did not become ready."

# Create the databases if missing. NB: psql exits 0 for a valid query even when it
# returns no rows, so branch on the actual query OUTPUT ('1' when the db exists),
# not on the exit code.
$dbExists = (docker compose -f docker-compose.yml exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'" 2>$null | Out-String).Trim()
if ($dbExists -ne '1') { Run "createdb $DbName" { docker compose -f docker-compose.yml exec -T postgres createdb -U postgres $DbName } }
# Mock SIS database (integration testing / parent evaluations)
$sisExists = (docker compose -f docker-compose.yml exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='mock_sis'" 2>$null | Out-String).Trim()
if ($sisExists -ne '1') { Run "createdb mock_sis" { docker compose -f docker-compose.yml exec -T postgres createdb -U postgres mock_sis } }

Step "3/11  Writing environment files"
function New-HexKey([int]$bytes) { -join ((1..$bytes) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }
$mfa = New-HexKey 32   # 64 hex chars
$jwt = New-HexKey 32
$sisApiKey = "mock-sis-dev-key-change-me"
@"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/$DbName"
JWT_ACCESS_SECRET="$jwt"
JWT_ACCESS_TTL="15m"
MFA_ENCRYPTION_KEY="$mfa"
REDIS_HOST="localhost"
REDIS_PORT=6379
PUBLIC_APP_URL="$(if ($PublicAppUrl) { $PublicAppUrl } else { "http://localhost:5173" })"
CORS_ORIGIN="http://localhost:5173"
PORT=3000
NODE_ENV=development
SIS_PROVIDER=mock
SIS_BASE_URL="http://localhost:3100/api/v1"
SIS_API_KEY="$sisApiKey"
"@ | Set-Content -Encoding ascii apps/api/.env
@"
VITE_API_BASE_URL=/api/v1
VITE_DEFAULT_ORG_SLUG=$OrgSlug
"@ | Set-Content -Encoding ascii apps/web/.env
@"
MOCK_SIS_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mock_sis"
PORT=3100
SIS_API_KEY="$sisApiKey"
"@ | Set-Content -Encoding ascii apps/mock-sis/.env
Copy-Item .env.example .env -Force -ErrorAction SilentlyContinue

Step "4/11  Installing dependencies (npm workspaces)"
Run "npm install" { npm install }

Step "5/11  Generating Prisma client"
Run "prisma generate (api)" { npm run db:generate }

Step "6/11  Applying database schema (base for fresh installs + idempotent reconcile)"
# Only run the base DDL on an empty database; on an existing one the CREATE TABLEs
# would error. The reconcile then runs ALWAYS and is idempotent - it adds any
# tables/columns introduced since this database was first created (self-healing).
$existing = (docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d $DbName -tAc "SELECT to_regclass('public.organizations')" 2>$null | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($existing)) {
  Write-Host "Fresh database - applying base schema."
  Run "copy base schema" { docker compose -f docker-compose.yml cp database/000_initial_schema.sql postgres:/schema.sql }
  Run "apply base schema" { docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d $DbName -v ON_ERROR_STOP=1 -f /schema.sql }
} else {
  Write-Host "Existing schema detected - skipping base DDL, reconciling instead."
}
Run "copy reconcile" { docker compose -f docker-compose.yml cp database/001_reconcile.sql postgres:/reconcile.sql }
Run "apply reconcile" { docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d $DbName -v ON_ERROR_STOP=1 -f /reconcile.sql }

Step "7/11  Seeding permissions"
Run "db:seed" { npm run db:seed }

Step "8/11  Creating administrator account"
# Pass via env vars to avoid cmd.exe quoting/escaping issues on Windows.
$env:BOOTSTRAP_ORG = $OrgName
$env:BOOTSTRAP_SLUG = $OrgSlug
$env:BOOTSTRAP_EMAIL = $AdminEmail
$env:BOOTSTRAP_PASSWORD = $AdminPassword
Run "db:bootstrap-tenant" { npm run db:bootstrap-tenant }
# Ensure the five predefined RBAC roles exist for every org (idempotent; covers upgrades).
Run "db:seed-roles" { npm run db:seed-roles }

if ($NoSampleData) {
  Step "9/11  Sample data (skipped)"
} else {
  Step "9/11  Loading sample data (demo cycle, employees, scored feedback)"
  # Target the same organisation the admin logs into. Idempotent - safe to re-run.
  $env:SAMPLE_ORG_SLUG = $OrgSlug
  Run "db:sample" { npm run db:sample }
}

Step "10/11  Mock SIS - Prisma client"
Run "sis:generate" { npm run sis:generate }

Step "11/11  Mock SIS - schema + sample academic data"
Run "sis:push" { npm run sis:push }
Run "sis:seed" { npm run sis:seed }

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " Deployment complete." -ForegroundColor Green
Write-Host ""
Write-Host " Login:  org slug '$OrgSlug'  /  $AdminEmail  /  $AdminPassword"
if (-not $NoSampleData) {
  Write-Host " Sample test users:  <name>@carepvtltd.com  /  Password123!  (see the Organization screen)"
}
Write-Host "============================================================" -ForegroundColor Green

if ($Run) {
  Write-Host "`nStarting dev servers..." -ForegroundColor Cyan
  & "$PSScriptRoot/start-dev.ps1"
} else {
  Write-Host ""
  Write-Host " Start the servers with:  ./start-dev.ps1" -ForegroundColor Yellow
  Write-Host "   (or in three terminals:  npm run dev:sis   npm run dev:api   npm run dev:web)"
  Write-Host "   API -> http://localhost:3000/api/v1     Web -> http://localhost:5173"
}
