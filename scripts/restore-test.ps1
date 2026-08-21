[CmdletBinding()]
param([string]$Config = 'E:\ObsidianData\OKF-Brain-State\config\deployment.json')

& (Join-Path $PSScriptRoot '..\deploy\windows\restore-test.ps1') -Config $Config
exit $LASTEXITCODE
