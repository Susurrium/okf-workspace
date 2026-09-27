[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location (Join-Path $root 'engine')
try {
    & uv build
    if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }
}
finally { Pop-Location }

Push-Location (Join-Path $root 'dashboard')
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
}
finally { Pop-Location }

Push-Location (Join-Path $root 'claudian')
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Claudian build failed' }
}
finally { Pop-Location }

Write-Host 'OKF Workspace build completed.'
