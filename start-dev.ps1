<#
  Starts the Mock SIS, API and web dev servers in three new PowerShell windows.
  Run ./deploy.ps1 first (one time) to set up the database + admin.

  The web dev server listens on every interface (apps/web/vite.config.ts sets
  server.host), so the app is reachable both on this machine and from phones or
  laptops on the same Wi-Fi. This script detects the current LAN IPv4 address at
  start-up and prints the URLs - nothing is hard-coded, so a changed DHCP lease
  needs no edit here.
#>
$root = $PSScriptRoot

# --- Preflight -------------------------------------------------------------
# This script opens three windows and then exits, so anything wrong with the
# folder used to fail three times over - in three windows that each scrolled a
# different stack trace and then sat there. Both checks below are things
# deploy.ps1 does for you, and are only ever missing when start-dev.ps1 was run
# on a freshly unzipped copy first.
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host ""
  Write-Host "  Dependencies are not installed in this folder." -ForegroundColor Yellow
  Write-Host "  Every fresh copy of the project needs this once:"
  Write-Host ""
  Write-Host "      npm install" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Or run .\deploy.ps1, which installs them and sets up the database too."
  Write-Host ""
  exit 1
}
if (-not (Test-Path (Join-Path $root 'apps\api\.env'))) {
  Write-Host ""
  Write-Host "  apps\api\.env is missing, so the API has no DATABASE_URL and would exit" -ForegroundColor Yellow
  Write-Host "  the moment it started. .env files are deliberately not shipped in the ZIP,"
  Write-Host "  so a fresh extract never has one."
  Write-Host ""
  Write-Host "  Run .\deploy.ps1 once to create it." -ForegroundColor Cyan
  Write-Host ""
  exit 1
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; npm run dev:sis"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; npm run dev:api"
Start-Sleep -Seconds 2
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$root`"; npm run dev:web"

# Current LAN IPv4: a real, non-loopback, non-APIPA address. Interfaces that have a
# default gateway are preferred, since that is the address other devices can reach.
$lan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -ne '127.0.0.1' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.PrefixOrigin -in @('Dhcp', 'Manual')
  } |
  Sort-Object -Property @{
    Expression = { $null -ne (Get-NetIPConfiguration -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).IPv4DefaultGateway }
  } -Descending |
  Select-Object -First 1 -ExpandProperty IPAddress

Write-Host ""
Write-Host "On this machine:" -ForegroundColor Cyan
Write-Host "  Web      -> http://localhost:5173"
Write-Host "  API      -> http://localhost:3000/api/v1"
Write-Host "  Mock SIS -> http://localhost:3100/api/v1"

if ($lan) {
  Write-Host ""
  Write-Host "From another device on the same Wi-Fi:" -ForegroundColor Cyan
  Write-Host "  Web      -> http://${lan}:5173" -ForegroundColor Green
  Write-Host "  API      -> http://${lan}:3000/api/v1"
  Write-Host ""
  Write-Host "  Open the Web URL on the other device. The page calls the API through the" -ForegroundColor DarkGray
  Write-Host "  dev server on that same host and port, so nothing else needs configuring." -ForegroundColor DarkGray
  Write-Host "  If it does not load, check the port is reachable:" -ForegroundColor DarkGray
  Write-Host "    Test-NetConnection -ComputerName $lan -Port 5173" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Note: links the system GENERATES - parent evaluation links, password" -ForegroundColor DarkGray
  Write-Host "  reset emails - use PUBLIC_APP_URL from apps/api/.env, which defaults to" -ForegroundColor DarkGray
  Write-Host "  localhost. To open those on another device, set:" -ForegroundColor DarkGray
  Write-Host "    PUBLIC_APP_URL=http://${lan}:5173" -ForegroundColor DarkGray
} else {
  Write-Host ""
  Write-Host "Could not determine a LAN IPv4 address - are you connected to a network?" -ForegroundColor Yellow
  Write-Host "Find it manually with:  ipconfig | findstr IPv4"
}
Write-Host ""
