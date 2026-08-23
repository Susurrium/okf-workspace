[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
Set-OkfEnvironment $deployment
$producers = Join-Path ([string]$deployment.state) 'feed-producers.json'
if (-not (Test-Path -LiteralPath $producers -PathType Leaf)) {
    Write-Host 'Feed producers are not configured; nothing to synchronize.'
    exit 0
}

$okf = Join-Path ([string]$deployment.repository_root) 'engine\.venv\Scripts\okf.exe'
& $okf feed sync all --state ([string]$deployment.state)
if ($LASTEXITCODE -ne 0) {
    throw 'Feed synchronization was incomplete; the scheduled task will retry.'
}
