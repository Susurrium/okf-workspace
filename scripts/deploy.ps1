[CmdletBinding()]
param(
    [string]$DataRoot = 'E:\ObsidianData',
    [string]$Vault = '',
    [string]$Originals = '',
    [string]$State = '',
    [switch]$SkipAcceptance,
    [switch]$SkipScheduledTasks,
    [switch]$EnableBackupSetup
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installer = Join-Path $root 'deploy\windows\install.ps1'
$arguments = @{
    RepositoryRoot = $root
    DataRoot = $DataRoot
}
if ($Vault) { $arguments['Vault'] = $Vault }
if ($Originals) { $arguments['Originals'] = $Originals }
if ($State) { $arguments['State'] = $State }
if ($SkipAcceptance) { $arguments['SkipAcceptance'] = $true }
if ($SkipScheduledTasks) { $arguments['SkipScheduledTasks'] = $true }
if ($EnableBackupSetup) { $arguments['EnableBackupSetup'] = $true }

& $installer @arguments
if ($LASTEXITCODE -ne 0) { throw 'OKF Workspace deployment failed' }
