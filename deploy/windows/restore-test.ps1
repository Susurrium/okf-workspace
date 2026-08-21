[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [switch]$DueOnly,
    [switch]$KeepRestore
)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
$restic = Assert-OkfCommand 'restic'
$env:RESTIC_REPOSITORY = [string]$deployment.backup_repository
$env:RESTIC_PASSWORD_FILE = [string]$deployment.restic_password_file
$backupState = Join-Path ([string]$deployment.state) 'backups'
$marker = Join-Path $backupState 'last-restore-test.json'
if ($DueOnly -and (Test-Path -LiteralPath $marker)) {
    $last = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    $completed = [DateTimeOffset]::Parse([string]$last.completed_at)
    if ($completed -gt [DateTimeOffset]::Now.AddDays(-28)) {
        Write-Host 'Restore test is not due.'
        exit 0
    }
}

$restoreRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("okf-brain-restore-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $restoreRoot | Out-Null
try {
    function Get-ResticSnapshotPath([string]$Source) {
        $full = Resolve-OkfPath $Source
        $root = [IO.Path]::GetPathRoot($full)
        if (-not $root -or $root.StartsWith('\\')) { throw "Unsupported restore source root: $Source" }
        $drive = $root.TrimEnd('\').TrimEnd(':')
        $relative = $full.Substring($root.Length).Replace('\', '/')
        return "/$drive/$relative"
    }

    $restoredVaultPath = Join-Path $restoreRoot 'vault'
    $restoredOriginalsPath = Join-Path $restoreRoot 'originals'
    New-Item -ItemType Directory -Path $restoredVaultPath, $restoredOriginalsPath | Out-Null
    $vaultSnapshotPath = Get-ResticSnapshotPath ([string]$deployment.vault)
    $originalsSnapshotPath = Get-ResticSnapshotPath ([string]$deployment.originals)
    & $restic restore "latest:$vaultSnapshotPath" --target $restoredVaultPath --verify
    if ($LASTEXITCODE -ne 0) { throw 'Restic Vault restore failed' }
    & $restic restore "latest:$originalsSnapshotPath" --target $restoredOriginalsPath --verify
    if ($LASTEXITCODE -ne 0) { throw 'Restic Original Store restore failed' }

    $restoredVault = Get-Item -LiteralPath $restoredVaultPath
    $restoredOriginals = Get-Item -LiteralPath $restoredOriginalsPath
    if (-not (Test-Path -LiteralPath (Join-Path $restoredVault.FullName 'index.md'))) {
        throw "Restored Vault not found below $restoredVaultPath"
    }

    $okf = Join-Path ([string]$deployment.repository_root) '.venv\Scripts\okf.exe'
    $reportText = & $okf backup verify-restore --vault $restoredVault.FullName --originals $restoredOriginals.FullName --json
    if ($LASTEXITCODE -ne 0) { throw "Restored data verification failed: $reportText" }
    $report = $reportText | ConvertFrom-Json
    Write-OkfJson -Path $marker -Value ([ordered]@{
        completed_at = [DateTimeOffset]::Now.ToString('o')
        snapshot_id = 'latest'
        markdown_files = $report.markdown_files
        readable_files = $report.readable_files
        original_references = $report.original_references
        resolved_originals = $report.resolved_originals
    })
    Write-Host "Restore test passed: $($report.readable_files) Markdown, $($report.resolved_originals) Originals."
} finally {
    if (-not $KeepRestore -and (Test-Path -LiteralPath $restoreRoot)) {
        $resolvedTemp = (Resolve-OkfPath ([System.IO.Path]::GetTempPath())).TrimEnd('\') + '\'
        $resolvedRestore = Resolve-OkfPath $restoreRoot
        if (-not $resolvedRestore.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Split-Path -Leaf $resolvedRestore).StartsWith('okf-brain-restore-')) {
            throw "Refusing to remove unexpected restore path: $resolvedRestore"
        }
        Remove-Item -LiteralPath $resolvedRestore -Recurse -Force
    }
}
