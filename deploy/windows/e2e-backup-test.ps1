[CmdletBinding()]
param([string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)

. (Join-Path $PSScriptRoot 'common.ps1')
$repo = Resolve-OkfPath $RepositoryRoot
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("okf-brain-backup-e2e-" + [guid]::NewGuid().ToString('N'))
$vault = Join-Path $testRoot 'test-vault'
$originals = Join-Path $testRoot 'originals'
$state = Join-Path $testRoot 'state'
$resticRepository = Join-Path $testRoot 'restic-repository'
$password = Join-Path $state 'secrets\restic-password'
$config = Join-Path $state 'config\deployment.json'
New-Item -ItemType Directory -Force -Path $testRoot, $originals, (Split-Path -Parent $password) | Out-Null

try {
    $okf = Join-Path $repo 'engine\.venv\Scripts\okf.exe'
    & $okf fixtures generate --output $vault
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic Vault generation failed' }

    $payload = [Text.Encoding]::UTF8.GetBytes('restic-original-fixture')
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($payload)).ToLowerInvariant()
    $originalDirectory = Join-Path $originals (Join-Path $digest.Substring(0, 2) $digest)
    New-Item -ItemType Directory -Force -Path $originalDirectory | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $originalDirectory 'original.pdf'), $payload)
    $source = Join-Path $vault 'sources\records\documents\restic-fixture.md'
    @"
---
type: Source
title: Restic restore fixture
status: stable
resource: okf-original://sha256/$digest/fixture.pdf
---

# Restic restore fixture
"@ | Set-Content -LiteralPath $source -Encoding utf8NoBOM

    $secret = [byte[]]::new(48)
    [Security.Cryptography.RandomNumberGenerator]::Fill($secret)
    [Convert]::ToBase64String($secret) | Set-Content -LiteralPath $password -Encoding ascii -NoNewline
    Write-OkfJson -Path $config -Value ([ordered]@{
        repository_root = $repo
        vault = $vault
        originals = $originals
        state = $state
        api_port = 8765
        mineru_url = 'http://127.0.0.1:18000'
        markitdown_url = 'http://127.0.0.1:18010'
        markitdown_token_file = ''
        enable_vectors = $false
        backup_repository = $resticRepository
        restic_password_file = $password
    })

    & (Join-Path $PSScriptRoot 'backup.ps1') -Config $config
    if ($LASTEXITCODE -ne 0) { throw 'Backup script failed' }
    & (Join-Path $PSScriptRoot 'restore-test.ps1') -Config $config
    if ($LASTEXITCODE -ne 0) { throw 'Restore test script failed' }
    $backup = Get-Content -LiteralPath (Join-Path $state 'backups\last-success.json') -Raw | ConvertFrom-Json
    $restore = Get-Content -LiteralPath (Join-Path $state 'backups\last-restore-test.json') -Raw | ConvertFrom-Json
    [ordered]@{
        passed = $true
        snapshot_id = $backup.snapshot_id
        markdown_files = $restore.markdown_files
        readable_files = $restore.readable_files
        original_references = $restore.original_references
        resolved_originals = $restore.resolved_originals
    } | ConvertTo-Json
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        $temp = (Resolve-OkfPath ([System.IO.Path]::GetTempPath())).TrimEnd('\') + '\'
        $resolved = Resolve-OkfPath $testRoot
        if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Split-Path -Leaf $resolved).StartsWith('okf-brain-backup-e2e-')) {
            throw "Refusing to remove unexpected test path: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
