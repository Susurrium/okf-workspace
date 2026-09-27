[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

& (Join-Path $root 'deploy\windows\test-dashboard-plugin-migration.ps1')

Push-Location (Join-Path $root 'engine')
try {
    & uv run pytest
    if ($LASTEXITCODE -ne 0) { throw 'Engine tests failed' }
    & uv run ruff check src tests
    if ($LASTEXITCODE -ne 0) { throw 'Engine Ruff check failed' }
    & uv run pyright
    if ($LASTEXITCODE -ne 0) { throw 'Engine Pyright check failed' }
}
finally { Pop-Location }

Push-Location $root
try {
    & uv run --project engine pytest tests/e2e
    if ($LASTEXITCODE -ne 0) { throw 'Cross-component contract tests failed' }
    & uv run --project engine ruff check tests/e2e
    if ($LASTEXITCODE -ne 0) { throw 'Cross-component Ruff check failed' }
}
finally { Pop-Location }

Push-Location (Join-Path $root 'dashboard')
try {
    & npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard typecheck failed' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard tests failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
}
finally { Pop-Location }

Push-Location (Join-Path $root 'claudian')
try {
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Claudian typecheck failed' }
    & npm.cmd run lint
    if ($LASTEXITCODE -ne 0) { throw 'Claudian lint failed' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Claudian tests failed' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Claudian build failed' }
}
finally { Pop-Location }

Write-Host 'OKF Workspace checks passed.'
