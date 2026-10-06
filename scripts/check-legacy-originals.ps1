[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Historical recovery service; intentionally separate from the active Workspace checks.
Push-Location (Join-Path $root 'services\originals')
try {
    & uv sync --extra dev --locked
    if ($LASTEXITCODE -ne 0) { throw 'Legacy Originals dependency check failed' }
    & uv run pytest
    if ($LASTEXITCODE -ne 0) { throw 'Legacy Originals tests failed' }
    & uv run ruff check src tests
    if ($LASTEXITCODE -ne 0) { throw 'Legacy Originals Ruff check failed' }
    & uv run pyright
    if ($LASTEXITCODE -ne 0) { throw 'Legacy Originals Pyright check failed' }
}
finally { Pop-Location }

Write-Host 'Legacy Originals recovery checks passed.'
