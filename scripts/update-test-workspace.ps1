[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Vault,
    [Parameter(Mandatory)][string]$State
)

. (Join-Path $PSScriptRoot '..\deploy\windows\common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Join-Path $State 'config\deployment.json'
$deployment = Assert-OkfTestEnvironment -Config $config -Vault $Vault
$statusJson = & (Join-Path $PSScriptRoot 'test-workspace.ps1') -Config $config -Action Status
$status = $statusJson | ConvertFrom-Json
if ($status.vault_open -or $status.api_listening) { throw 'Stop the test workspace before updating it.' }
if (-not (Test-OkfSamePath -Left (Get-OkfEnginePython ([pscustomobject]$deployment)) -Right (Join-Path $root 'engine\.venv\Scripts\python.exe'))) {
    throw 'Test Engine must use this source repository.'
}
Push-Location (Join-Path $root 'engine')
try {
    & uv sync --frozen --extra dev --extra vector
    if ($LASTEXITCODE -ne 0) { throw 'Test Engine dependency update failed.' }
} finally { Pop-Location }
$okf = Join-Path $root 'engine\.venv\Scripts\okf.exe'
& $okf resources sync --vault $Vault
if ($LASTEXITCODE -ne 0) { throw 'Test Workspace resources update failed.' }
& (Join-Path $PSScriptRoot 'install-skills.ps1') -Vault $Vault
& (Join-Path $PSScriptRoot 'install-dashboard.ps1') -Vault $Vault -State $State
& (Join-Path $PSScriptRoot 'install-okf-claudian.ps1') -Vault $Vault -State $State
& $okf index rebuild --vault $Vault --state $State
if ($LASTEXITCODE -ne 0) { throw 'Test index rebuild failed.' }
& $okf validate --vault $Vault
if ($LASTEXITCODE -ne 0) { throw 'Updated test Vault failed contract validation.' }
& (Join-Path $PSScriptRoot 'test-workspace.ps1') -Config $config -Action Stop
$artifacts = @{}
foreach ($component in @('okf-workspace-dashboard', 'okf-claudian')) {
    foreach ($name in @('main.js', 'styles.css', 'manifest.json')) {
        $path = Join-Path $Vault ".obsidian\plugins\$component\$name"
        $artifacts["$component/$name"] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
Write-OkfJson -Path (Join-Path $State 'reports\development-build.json') -Value @{
    environment = 'test'; vault = (Resolve-OkfPath $Vault); state = (Resolve-OkfPath $State)
    updated_at = [DateTimeOffset]::Now.ToString('o'); artifacts = $artifacts
}
& (Join-Path $PSScriptRoot 'record-deployment.ps1') -Config $config
Write-Host 'Test workspace updated; Engine autostart and LiveSync are disabled.'
