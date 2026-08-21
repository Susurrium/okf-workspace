[CmdletBinding()]
param(
    [string]$Vault = 'E:\ObsidianData\OKF-Brain',
    [string]$State = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vaultRoot = [System.IO.Path]::GetFullPath($Vault)
if (-not (Test-Path -LiteralPath $vaultRoot -PathType Container)) {
    throw "Vault does not exist: $vaultRoot"
}
$obsidianRoot = Join-Path $vaultRoot '.obsidian'
if (-not (Test-Path -LiteralPath $obsidianRoot -PathType Container)) {
    throw "Obsidian settings directory does not exist: $obsidianRoot"
}
& (Join-Path $PSScriptRoot 'build-dashboard.ps1')
$target = Join-Path $vaultRoot '.obsidian\plugins\okf-workspace-dashboard'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dashboard\dist\main.js') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root 'dashboard\manifest.json') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root 'dashboard\styles.css') -Destination $target -Force

$dataPath = Join-Path $target 'data.json'
$data = @{}
if (Test-Path -LiteralPath $dataPath -PathType Leaf) {
    $data = Get-Content -LiteralPath $dataPath -Raw | ConvertFrom-Json -AsHashtable
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
    $deployment = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
}
$apiPort = if ($deployment.ContainsKey('api_port')) { [int]$deployment['api_port'] } else { 8765 }

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
$data | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $dataPath -Encoding UTF8 -NoNewline

$communityPlugins = Join-Path $vaultRoot '.obsidian\community-plugins.json'
$enabled = @()
if (Test-Path -LiteralPath $communityPlugins -PathType Leaf) {
    $enabled = @(Get-Content -LiteralPath $communityPlugins -Raw | ConvertFrom-Json)
}
$enabled = @($enabled | Where-Object { $_ -ne 'okf-brain-dashboard' })
if ($enabled -notcontains 'okf-workspace-dashboard') { $enabled += 'okf-workspace-dashboard' }
$enabled | ConvertTo-Json -Depth 2 | Set-Content -LiteralPath $communityPlugins -Encoding UTF8 -NoNewline
Write-Host "Dashboard installed: $target"
