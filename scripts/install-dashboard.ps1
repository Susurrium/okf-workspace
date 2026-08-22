[CmdletBinding()]
param(
    [string]$Vault = 'E:\ObsidianData\OKF-Brain',
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

$explicitState = [bool]$State
$existingConfig = if ($data.ContainsKey('deploymentConfig')) {
    [string]$data['deploymentConfig']
} else {
    ''
}
$stateRoot = if ($explicitState) {
    [System.IO.Path]::GetFullPath($State)
} elseif ($existingConfig) {
    [System.IO.Path]::GetDirectoryName(
        [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($existingConfig))
    )
} else {
    [System.IO.Path]::Combine((Split-Path -Parent $vaultRoot), 'OKF-Brain-State')
}
$configPath = [System.IO.Path]::Combine($stateRoot, 'config', 'deployment.json')
$deployment = @{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $deployment = Read-OkfJsonHashtable -Path $configPath -Description 'Deployment config'
}
$apiPort = if ($deployment.ContainsKey('api_port')) { [int]$deployment['api_port'] } else { 8765 }
$dashboardMigration = Get-OkfDashboardPluginMigrationPlan -Vault $vaultRoot

# Read and validate every existing JSON input before replacing plugin artifacts.
& (Join-Path $PSScriptRoot 'build-dashboard.ps1')
Install-OkfDashboardPluginAtomic `
    -DashboardRoot (Join-Path $root 'dashboard') `
    -Target $target | Out-Null

if ($explicitState -or -not $data.ContainsKey('baseUrl')) {
    $data['baseUrl'] = "http://127.0.0.1:$apiPort"
}
if ($explicitState -or -not $data.ContainsKey('tokenFile')) {
    $data['tokenFile'] = [System.IO.Path]::Combine($stateRoot, 'secrets', 'local-api-token')
}
$data['pythonExecutable'] = Join-Path $root 'engine\.venv\Scripts\python.exe'
if ($explicitState -or -not $data.ContainsKey('deploymentConfig')) {
    $data['deploymentConfig'] = $configPath
}
if ($explicitState -or -not $data.ContainsKey('serviceLogDirectory')) {
    $data['serviceLogDirectory'] = [System.IO.Path]::Combine($stateRoot, 'logs')
}
if (-not $data.ContainsKey('manageLocalService')) { $data['manageLocalService'] = $true }
$data.Remove('token')
Write-OkfJson -Path $dataPath -Value $data

# Preserve every user-owned plugin in its existing order, make the Dashboard
# load first for a stable Ribbon position, then remove only its retired id.
Complete-OkfDashboardPluginMigration `
    -Vault $vaultRoot `
    -Preflight $dashboardMigration | Out-Null
Write-Host "Dashboard installed: $target"
