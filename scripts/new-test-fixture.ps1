[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]*$')][string]$Name,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Purpose,
    [Parameter(Mandatory)][DateTimeOffset]$ExpiresAt
)

. (Join-Path $PSScriptRoot '..\deploy\windows\common.ps1')
if ($ExpiresAt -le [DateTimeOffset]::Now) { throw 'Fixture expiration must be in the future.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$fixtureRoot = Join-Path $root "work\fixtures\$Name"
if (Test-Path -LiteralPath $fixtureRoot) { throw "Fixture already exists: $fixtureRoot" }
$okf = Join-Path $root 'engine\.venv\Scripts\okf.exe'
if (-not (Test-Path -LiteralPath $okf)) { throw 'Bootstrap the source Engine before creating a fixture.' }
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
Write-OkfJson -Path (Join-Path $fixtureRoot 'fixture.json') -Value @{
    environment = 'temporary-test'; purpose = $Purpose; status = 'initializing'
    created_at = [DateTimeOffset]::Now.ToString('o'); expires_at = $ExpiresAt.ToString('o')
    vault = (Join-Path $fixtureRoot 'vault'); state = (Join-Path $fixtureRoot 'state')
    cleanup = 'Close all fixture writers; retain required evidence; verify paths before removing this fixture directory.'
}
& $okf fixtures generate --output (Join-Path $fixtureRoot 'vault')
if ($LASTEXITCODE -ne 0) { throw 'Fixture initialization failed; its marker is retained for diagnosis.' }
$marker = Read-OkfJsonHashtable -Path (Join-Path $fixtureRoot 'fixture.json')
$marker['status'] = 'ready'
$marker['engine_revision'] = (& git -C $root rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot record the fixture source revision.' }
Write-OkfJson -Path (Join-Path $fixtureRoot 'fixture.json') -Value $marker
Write-Host "Temporary fixture created: $fixtureRoot; expires: $ExpiresAt"
