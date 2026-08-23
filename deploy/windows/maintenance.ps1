[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
Set-OkfEnvironment $deployment
$okf = Join-Path ([string]$deployment.repository_root) 'engine\.venv\Scripts\okf.exe'
$indexArguments = @('index', 'rebuild', '--vault', [string]$deployment.vault, '--state', [string]$deployment.state)
if ([bool]$deployment.enable_vectors) { $indexArguments += '--vectors' }
& $okf @indexArguments
if ($LASTEXITCODE -ne 0) { throw 'Incremental index update failed' }

if ([string]$deployment.backup_repository) {
    & (Join-Path $PSScriptRoot 'backup.ps1') -Config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Daily backup failed' }
    & (Join-Path $PSScriptRoot 'restore-test.ps1') -Config $Config -DueOnly
    if ($LASTEXITCODE -ne 0) { throw 'Scheduled restore test failed' }
}
