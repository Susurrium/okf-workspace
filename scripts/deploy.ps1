[CmdletBinding()]
param(
    [string]$DataRoot = 'E:\ObsidianData',
    [string]$Vault = '',
    [string]$Originals = '',
    [string]$State = '',
    [string]$MinerUTokenFile = '',
    [ValidateSet('vlm', 'pipeline')][string]$MinerUModel = 'vlm',
    [ValidateSet('mineru-cloud', 'markitdown-service', 'mineru-self-hosted')]
    [string]$DefaultConversionMethod = 'mineru-cloud',
    [string]$MarkItDownUrl = 'http://127.0.0.1:18010',
    [string]$MarkItDownTokenFile = '',
    [bool]$MinerUSelfHostedEnabled = $false,
    [string]$MinerUUrl = 'http://127.0.0.1:18000',
    [bool]$MinerUSshManaged = $true,
    [string]$MinerUSshHost = 'bjmu-inner',
    [int]$MinerUSshRemotePort = 8000,
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
foreach ($parameter in @(
    'MinerUTokenFile', 'MinerUModel', 'DefaultConversionMethod',
    'MarkItDownUrl', 'MarkItDownTokenFile', 'MinerUSelfHostedEnabled',
    'MinerUUrl', 'MinerUSshManaged', 'MinerUSshHost', 'MinerUSshRemotePort'
)) {
    if ($PSBoundParameters.ContainsKey($parameter)) {
        $arguments[$parameter] = $PSBoundParameters[$parameter]
    }
}
if ($SkipAcceptance) { $arguments['SkipAcceptance'] = $true }
if ($SkipScheduledTasks) { $arguments['SkipScheduledTasks'] = $true }
if ($EnableBackupSetup) { $arguments['EnableBackupSetup'] = $true }

& $installer @arguments
if ($LASTEXITCODE -ne 0) { throw 'OKF Workspace deployment failed' }
