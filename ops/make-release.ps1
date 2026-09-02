<#
.SYNOPSIS
  Build and package a customer release: prebuilt images plus the files needed to run them.

.DESCRIPTION
  This is the script that makes the licensing hardening stick. Steps 1-4 of the plan can
  all be undone by one person zipping the working folder by hand, so the package is
  assembled from an explicit ALLOW-LIST and then checked before it is compressed.

  What it does:
    1. Builds e360-api / e360-web with BUILD_CHANNEL=customer and the trusted PUBLIC key
       compiled in, which is also what compiles the development licence out.
    2. Exports the images with `docker save`.
    3. Copies only the operational files a customer needs.
    4. REFUSES to produce the archive if anything forbidden slipped in.

  The customer loads the images and runs compose. They never build, so they never hold
  the source - which is the only configuration in which a compiled-in key is worth
  anything. If you ship a buildable source tree instead, the customer can simply change
  the key back, and most of the protection is gone.

  NEVER pass a private key to this script. It takes the PUBLIC key only, and refuses
  anything that looks private.

.EXAMPLE
  .\ops\make-release.ps1 -Version 2026-09-01-v1

.EXAMPLE
  .\ops\make-release.ps1 -Version 2026-09-01-v1 -PublicKeyFile "..\e360-license-keys\license-public.pem"

.NOTES
  Pure ASCII on purpose. Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252, so
  a stray en-dash or curly quote becomes a parse error at a line that looks fine.
#>
[CmdletBinding()]
param(
  # Release identifier. Follows the folder convention: yyyy-MM-dd-vN.
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d{4}-\d{2}-\d{2}-v\d+$')]
  [string]$Version,

  # The vendor PUBLIC key, PEM. Default matches `license:keygen`'s output location.
  [string]$PublicKeyFile = '..\e360-license-keys\license-public.pem',

  # Where the release folder and .zip are written.
  [string]$OutDir = '..\e360-releases',

  # Skip `docker build` and reuse the images already present (faster re-packaging).
  [switch]$NoBuild,

  # Assemble the folder but do not compress it.
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Step([string]$text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok([string]$text)   { Write-Host "    $text" -ForegroundColor Green }
function Die([string]$text)  { Write-Host ""; Write-Host "  FAILED: $text" -ForegroundColor Red; Write-Host ""; exit 1 }

# ---------------------------------------------------------------- the key ----
Step "Trusted public key"

$keyPath = if ([System.IO.Path]::IsPathRooted($PublicKeyFile)) { $PublicKeyFile } else { Join-Path $root $PublicKeyFile }
if (-not (Test-Path $keyPath)) {
  Die ("cannot find the public key at $keyPath.`n" +
       "  Generate one ONCE with:  npm run license:keygen`n" +
       "  It writes license-public.pem and license-private.pem outside the repository.")
}

$keyText = Get-Content $keyPath -Raw
if ($keyText -match 'PRIVATE KEY') {
  Die "that file contains a PRIVATE key. Only the public key may go into a build."
}
if ($keyText -notmatch 'BEGIN PUBLIC KEY') {
  Die "that file does not look like a public key PEM."
}

# base64 of the PEM, so it survives a single-line build argument.
$keyB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($keyText))
Ok "public key read from $keyPath"

# ------------------------------------------------------------- build images --
$stage = Join-Path (Join-Path $root $OutDir) "e360-$Version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'images') -Force | Out-Null

if (-not $NoBuild) {
  Step "Building customer images (BUILD_CHANNEL=customer)"
  Push-Location $root
  try {
    foreach ($img in @(
      @{ name = 'e360-api';       file = 'apps/api/Dockerfile'; target = 'runtime' },
      @{ name = 'e360-api-tools'; file = 'apps/api/Dockerfile'; target = 'tools'   },
      @{ name = 'e360-web';       file = 'apps/web/Dockerfile'; target = ''        }
    )) {
      Write-Host "    building $($img.name) ..."
      $args = @('build', '-f', $img.file,
                '--build-arg', "BUILD_CHANNEL=customer",
                '--build-arg', "LICENSE_PUBLIC_KEY_B64=$keyB64",
                '--build-arg', "BUILD_ID=$Version",
                '-t', $img.name)
      if ($img.target) { $args += @('--target', $img.target) }
      $args += '.'
      & docker @args
      if ($LASTEXITCODE -ne 0) { Die "docker build failed for $($img.name)." }
    }
  } finally { Pop-Location }
  Ok "images built"
}

Step "Exporting images"
foreach ($name in @('e360-api', 'e360-api-tools', 'e360-web')) {
  $out = Join-Path $stage "images\$name.tar"
  & docker save -o $out $name
  if ($LASTEXITCODE -ne 0) { Die "docker save failed for $name." }
  Ok ("{0,-16} {1,8:N0} MB" -f $name, ((Get-Item $out).Length / 1MB))
}

# ------------------------------------------------------- operational files ---
Step "Copying the operational files"

# ALLOW-LIST. Anything not named here does not ship. Add deliberately, never by wildcard
# over a directory that also holds source.
$files = @(
  'compose.yaml', 'compose.prod.yaml', '.env.docker.example',
  'start-docker.ps1', 'deploy.ps1',
  'README.md', 'DEPLOYMENT.md', 'WINDOWS_DEPLOY.md', 'LICENSING.md',
  'COMMUNICATION_SETUP.md', 'WHITE_LABEL.md'
)
$dirs = @(
  @{ from = 'database'; include = @('*.sql') },
  @{ from = 'ops';      include = @('*.ps1', '*.sh', '*.md') }
)

foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { Die "allow-listed file is missing: $f" }
  Copy-Item $src (Join-Path $stage $f) -Force
}
foreach ($d in $dirs) {
  $dest = Join-Path $stage $d.from
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Get-ChildItem (Join-Path $root $d.from) -File -Include $d.include -Recurse |
    ForEach-Object { Copy-Item $_.FullName $dest -Force }
}
# The release must not ship the vendor's own packaging script.
Remove-Item (Join-Path $stage 'ops\make-release.ps1') -Force -ErrorAction SilentlyContinue
Ok "$($files.Count) files and $($dirs.Count) directories copied"

# --------------------------------------------------------------- the check ---
# The point of the whole script. If any of this trips, something in the allow-list is
# wrong and the package must not go out.
Step "Verifying the package"

$forbidden = @(
  @{ what = 'application source';   pattern = '*.ts'            },
  @{ what = 'source maps';          pattern = '*.map'           },
  @{ what = 'the licence tool';     pattern = 'license.cjs'     },
  @{ what = 'the build stamper';    pattern = 'write-build-config.cjs' },
  @{ what = 'private key material'; pattern = '*.pem'           },
  @{ what = 'an issued licence';    pattern = '*-license.txt'   },
  @{ what = 'a real environment';   pattern = '.env'            },
  @{ what = 'Dockerfiles';          pattern = 'Dockerfile*'     },
  @{ what = 'tsconfig';             pattern = 'tsconfig*.json'  }
)
$bad = @()
foreach ($rule in $forbidden) {
  $hits = Get-ChildItem $stage -Recurse -File -Filter $rule.pattern -ErrorAction SilentlyContinue
  foreach ($h in $hits) { $bad += "$($rule.what): $($h.FullName.Substring($stage.Length + 1))" }
}
if ($bad.Count -gt 0) {
  Write-Host ""
  $bad | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
  Die "the package contains files that must never reach a customer."
}
Ok "no source, no maps, no keys, no vendor tooling"

# The images are the product; make sure they actually exist and are not empty shells.
foreach ($name in @('e360-api', 'e360-api-tools', 'e360-web')) {
  $tar = Join-Path $stage "images\$name.tar"
  if (-not (Test-Path $tar) -or (Get-Item $tar).Length -lt 1MB) { Die "$name.tar is missing or too small." }
}
Ok "three images present"

# -------------------------------------------------------------- load script --
$loader = @"
# Loads the Enterprise 360 images shipped with this release, then starts the stack.
# Run this INSTEAD of building: this package contains no source to build from.
`$ErrorActionPreference = 'Stop'
Get-ChildItem "`$PSScriptRoot\images\*.tar" | ForEach-Object {
  Write-Host "Loading `$(`$_.Name) ..."
  docker load -i `$_.FullName
}
Write-Host ""
Write-Host "Images loaded. Now run:  .\start-docker.ps1 -NoBuild" -ForegroundColor Cyan
"@
Set-Content -Path (Join-Path $stage 'load-images.ps1') -Value $loader -Encoding ASCII

# --------------------------------------------------------------------- zip ---
if (-not $NoZip) {
  Step "Compressing"
  $zip = Join-Path (Join-Path $root $OutDir) "Enterprise360_App_$Version.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
  Ok ("{0}  ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}

Write-Host ""
Write-Host "Release $Version is ready." -ForegroundColor Green
Write-Host "  folder : $stage"
Write-Host ""
Write-Host "  Customer runs:  .\load-images.ps1  then  .\start-docker.ps1 -NoBuild"
Write-Host "  Then issue their licence:  npm run license:create -- --slug <their-slug> ..."
Write-Host ""
