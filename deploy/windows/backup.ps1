[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
$restic = Assert-OkfCommand 'restic'
$env:RESTIC_REPOSITORY = [string]$deployment.backup_repository
$env:RESTIC_PASSWORD_FILE = [string]$deployment.restic_password_file
if (-not (Test-Path -LiteralPath $env:RESTIC_PASSWORD_FILE -PathType Leaf)) {
    throw "Restic password file not found: $env:RESTIC_PASSWORD_FILE"
}

$backupState = Join-Path ([string]$deployment.state) 'backups'
New-Item -ItemType Directory -Force -Path $backupState | Out-Null
$initialized = Join-Path $backupState 'restic-initialized'
if (-not (Test-Path -LiteralPath $initialized)) {
    & $restic snapshots --json *> $null
    if ($LASTEXITCODE -ne 0) {
        & $restic init --repository-version 2
        if ($LASTEXITCODE -ne 0) { throw 'Restic repository initialization failed' }
    }
    Set-Content -LiteralPath $initialized -Value ([DateTimeOffset]::Now.ToString('o')) -Encoding utf8NoBOM
}

$sources = @(
    [string]$deployment.vault,
    [string]$deployment.originals,
    (Join-Path ([string]$deployment.repository_root) 'deploy')
)
$output = & $restic backup @sources --json --exclude '.git' --exclude '.trash' --exclude '.obsidian/workspace*.json' --exclude 'sources/assets/treehole-media'
if ($LASTEXITCODE -ne 0) { throw 'Restic backup failed' }
$summary = $output |
    ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
    Where-Object { $_ -and $_.message_type -eq 'summary' } |
    Select-Object -Last 1
$snapshot = if ($summary -and $summary.snapshot_id) { [string]$summary.snapshot_id } else { 'created' }

& $restic forget --keep-daily 7 --keep-weekly 8 --keep-monthly 12 --prune
if ($LASTEXITCODE -ne 0) { throw 'Restic retention cleanup failed' }

Write-OkfJson -Path (Join-Path $backupState 'last-success.json') -Value ([ordered]@{
    completed_at = [DateTimeOffset]::Now.ToString('o')
    snapshot_id = $snapshot
    repository = [string]$deployment.backup_repository
    sources = $sources
})
Write-Host "Backup complete: $snapshot"
