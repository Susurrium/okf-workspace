[CmdletBinding()]
param(
    [string]$Vault = 'E:\ObsidianData\OKF-Brain',
    [string]$ClaudianRepository = '',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$vaultRoot = [System.IO.Path]::GetFullPath($Vault)
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = if ($ClaudianRepository.Trim()) {
    [System.IO.Path]::GetFullPath($ClaudianRepository)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repository 'claudian'))
}
foreach ($entry in @(
        @{ Path = $vaultRoot; Label = 'Vault' },
        @{ Path = (Join-Path $vaultRoot '.obsidian'); Label = 'Obsidian settings' },
        @{ Path = $sourceRoot; Label = 'OKF Claudian repository' }
    )) {
    if (-not (Test-Path -LiteralPath $entry.Path -PathType Container)) {
        throw "$($entry.Label) does not exist: $($entry.Path)"
    }
}

if (-not $SkipBuild) {
    Push-Location $sourceRoot
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'OKF Claudian dependency install failed' }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'OKF Claudian build failed' }
    }
    finally {
        Pop-Location
    }
}

$artifactNames = @('main.js', 'manifest.json', 'styles.css')
foreach ($artifactName in $artifactNames) {
    $artifact = Join-Path $sourceRoot $artifactName
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf) -or
        (Get-Item -LiteralPath $artifact).Length -eq 0) {
        throw "Missing or empty OKF Claudian artifact: $artifact"
    }
}
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'manifest.json') -Raw -Encoding UTF8 |
    ConvertFrom-Json
if ($manifest.id -ne 'okf-claudian') {
    throw "Unexpected plugin id: $($manifest.id)"
}

$pluginTarget = [System.IO.Path]::GetFullPath(
    (Join-Path $vaultRoot '.obsidian\plugins\okf-claudian')
)
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
foreach ($artifactName in $artifactNames) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $artifactName) `
        -Destination (Join-Path $pluginTarget $artifactName) -Force
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $artifactName) -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath (Join-Path $pluginTarget $artifactName) -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw "Artifact verification failed: $artifactName" }
}

$settingsRoot = Join-Path $vaultRoot '.claudian'
$settingsPath = Join-Path $settingsRoot 'claudian-settings.json'
New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
$settings = @{}
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 |
        ConvertFrom-Json -AsHashtable
}
if (-not $settings.ContainsKey('systemPromptMode')) { $settings['systemPromptMode'] = 'okf-native' }
if (-not $settings.ContainsKey('settingsProvider')) { $settings['settingsProvider'] = 'codex' }
if (-not $settings.ContainsKey('locale')) { $settings['locale'] = 'zh-CN' }
if (-not $settings.ContainsKey('providerConfigs') -or $settings['providerConfigs'] -isnot [hashtable]) {
    $settings['providerConfigs'] = @{}
}
$providerConfigs = [hashtable]$settings['providerConfigs']
if (-not $providerConfigs.ContainsKey('claude') -or $providerConfigs['claude'] -isnot [hashtable]) {
    $providerConfigs['claude'] = @{}
}
if (-not $providerConfigs.ContainsKey('codex') -or $providerConfigs['codex'] -isnot [hashtable]) {
    $providerConfigs['codex'] = @{}
}
$claudeConfig = [hashtable]$providerConfigs['claude']
$codexConfig = [hashtable]$providerConfigs['codex']
if (-not $claudeConfig.ContainsKey('enabled')) { $claudeConfig['enabled'] = $false }
if (-not $codexConfig.ContainsKey('enabled')) { $codexConfig['enabled'] = $true }
if (-not $codexConfig.ContainsKey('safeMode')) { $codexConfig['safeMode'] = 'workspace-write' }
$settings | ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $settingsPath -Encoding UTF8 -NoNewline

$communityPluginsPath = Join-Path $vaultRoot '.obsidian\community-plugins.json'
$enabled = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $communityPluginsPath -PathType Leaf) {
    foreach ($id in @(Get-Content -LiteralPath $communityPluginsPath -Raw -Encoding UTF8 | ConvertFrom-Json)) {
        if ($id -is [string] -and $id -ne 'claudian' -and -not $enabled.Contains($id)) {
            $enabled.Add($id)
        }
    }
}
if (-not $enabled.Contains('okf-claudian')) { $enabled.Add('okf-claudian') }
$enabled.ToArray() | ConvertTo-Json -Depth 2 |
    Set-Content -LiteralPath $communityPluginsPath -Encoding UTF8 -NoNewline

foreach ($legacyId in @('claudian')) {
    $legacyPlugin = [System.IO.Path]::GetFullPath(
        (Join-Path $vaultRoot ".obsidian\plugins\$legacyId")
    )
    if (Test-Path -LiteralPath $legacyPlugin -PathType Container) {
        Remove-Item -LiteralPath $legacyPlugin -Recurse -Force
    }
}

[pscustomobject]@{
    plugin_id = $manifest.id
    version = $manifest.version
    installed_to = $pluginTarget
    enabled = $true
    prompt_mode = $settings['systemPromptMode']
    provider = $settings['settingsProvider']
    settings = $settingsPath
    workspace_resources = 'managed by Engine initialization and migration'
    next_step = 'Reload Obsidian so both OKF Claudian and the updated Dashboard are loaded.'
} | ConvertTo-Json -Depth 5
