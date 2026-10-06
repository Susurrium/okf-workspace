[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
Set-OkfEnvironment $deployment
# Preserve the daily backup even if the rebuildable index later fails.
if ([string]$deployment.backup_repository) {
    & (Join-Path $PSScriptRoot 'backup.ps1') -Config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Daily backup failed' }
    & (Join-Path $PSScriptRoot 'restore-test.ps1') -Config $Config -DueOnly
    if ($LASTEXITCODE -ne 0) { throw 'Scheduled restore test failed' }
}
$okf = Get-OkfEngineCommand $deployment
$indexArguments = @('index', 'rebuild', '--vault', [string]$deployment.vault, '--state', [string]$deployment.state)
if ([bool]$deployment.enable_vectors) { $indexArguments += '--vectors' }
& $okf @indexArguments
if ($LASTEXITCODE -ne 0) { throw 'Incremental index update failed' }
