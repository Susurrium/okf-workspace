[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location (Join-Path $root 'dashboard')
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
} finally {
    Pop-Location
}
