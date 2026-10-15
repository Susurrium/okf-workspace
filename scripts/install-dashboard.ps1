[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Vault,
    [string]$State = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $root 'deploy\windows\common.ps1')
$vaultRoot = [System.IO.Path]::GetFullPath($Vault)
if (-not (Test-Path -LiteralPath $vaultRoot -PathType Container)) {
    throw "Vault does not exist: $vaultRoot"
}
$obsidianRoot = Join-Path $vaultRoot '.obsidian'
if (-not (Test-Path -LiteralPath $obsidianRoot -PathType Container)) {
    throw "Obsidian settings directory does not exist: $obsidianRoot"
}
$target = Join-Path $vaultRoot '.obsidian\plugins\okf-workspace-dashboard'
$dataPath = Join-Path $target 'data.json'
$legacyTarget = Join-Path $vaultRoot '.obsidian\plugins\okf-brain-dashboard'
$legacyDataPath = Join-Path $legacyTarget 'data.json'
$data = @{}
if (Test-Path -LiteralPath $dataPath -PathType Leaf) {
    $data = Read-OkfJsonHashtable -Path $dataPath -Description 'Dashboard settings'
} elseif (Test-Path -LiteralPath $legacyDataPath -PathType Leaf) {
    $data = Read-OkfJsonHashtable -Path $legacyDataPath -Description 'Legacy Dashboard settings'
}

if (-not $State) { throw 'Source Dashboard installation requires an explicit test State.' }
$stateRoot = [System.IO.Path]::GetFullPath($State)
$configPath = [System.IO.Path]::Combine($stateRoot, 'config', 'deployment.json')
$deployment = Assert-OkfTestEnvironment -Config $configPath -Vault $vaultRoot
$apiPort = [int]$deployment['api_port']
$dashboardMigration = Get-OkfDashboardPluginMigrationPlan -Vault $vaultRoot

# Read and validate every existing JSON input before replacing plugin artifacts.
& (Join-Path $PSScriptRoot 'build-dashboard.ps1')
Install-OkfDashboardPluginAtomic `
    -DashboardRoot (Join-Path $root 'dashboard') `
    -Target $target | Out-Null

$data['baseUrl'] = "http://127.0.0.1:$apiPort"
$data['tokenFile'] = [System.IO.Path]::Combine($stateRoot, 'secrets', 'local-api-token')
$data['pythonExecutable'] = Join-Path $root 'engine\.venv\Scripts\python.exe'
$data['deploymentConfig'] = $configPath
$data['serviceLogDirectory'] = [System.IO.Path]::Combine($stateRoot, 'logs')
if (-not $data.ContainsKey('manageLocalService')) { $data['manageLocalService'] = $true }
$data.Remove('token')
Write-OkfJson -Path $dataPath -Value $data

# Preserve every user-owned plugin in its existing order, make the Dashboard
# load first for a stable Ribbon position, then remove only its retired id.
Complete-OkfDashboardPluginMigration `
    -Vault $vaultRoot `
    -Preflight $dashboardMigration | Out-Null
Write-Host "Dashboard installed: $target"
