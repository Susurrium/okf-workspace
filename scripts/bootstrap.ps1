[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location (Join-Path $root 'engine')
try {
    & uv sync --frozen --extra dev --extra vector
    if ($LASTEXITCODE -ne 0) { throw 'Engine dependency installation failed' }
}
finally { Pop-Location }

foreach ($application in @('dashboard', 'claudian')) {
    Push-Location (Join-Path $root $application)
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "$application dependency installation failed" }
    }
    finally { Pop-Location }
}

Write-Host 'OKF Workspace dependencies are ready.'
