[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

. (Join-Path $PSScriptRoot 'common.ps1')
$deployment = Read-OkfConfig $Config
$python = Join-Path ([string]$deployment.repository_root) 'engine\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Python executable missing: $python" }
$logDirectory = Join-Path ([string]$deployment.state) 'logs'
& $python -m okf_workspace.server --config $Config --log-directory $logDirectory
exit $LASTEXITCODE
