[CmdletBinding()]
param([string]$Config = 'E:\ObsidianData\OKF-Brain-State\config\deployment.json')

& (Join-Path $PSScriptRoot '..\deploy\windows\backup.ps1') -Config $Config
exit $LASTEXITCODE
