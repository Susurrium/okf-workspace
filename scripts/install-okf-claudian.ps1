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
. (Join-Path $repository 'deploy\windows\common.ps1')
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

# Historical development builds copied this fork into a folder named
# `claudian`, but their manifest id was still `okf-claudian`. Validate that
# exact provenance before making any Vault change. A folder name, or the
# upstream `claudian` manifest id, is not ownership evidence.
$ownedLegacyPluginIds = [System.Collections.Generic.List[string]]::new()
foreach ($legacyId in @('claudian')) {
    $owned = Confirm-OkfRetiredPluginDirectoryOwnership `
        -Vault $vaultRoot `
        -DirectoryName $legacyId `
        -AllowedManifestIds @('okf-claudian')
    if ($owned) { $ownedLegacyPluginIds.Add($legacyId) | Out-Null }
}

$settingsRoot = Join-Path $vaultRoot '.claudian'
$settingsPath = Join-Path $settingsRoot 'claudian-settings.json'
$settings = @{}
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = Read-OkfJsonHashtable -Path $settingsPath -Description 'OKF Claudian settings'
}

$communityPluginsPath = Join-Path $vaultRoot '.obsidian\community-plugins.json'
$enabled = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $communityPluginsPath -PathType Leaf) {
    $rawCommunityPlugins = [System.IO.File]::ReadAllText($communityPluginsPath)
    if (-not $rawCommunityPlugins.Trim().StartsWith('[') -or
        -not $rawCommunityPlugins.Trim().EndsWith(']')) {
        throw "Obsidian community plugin configuration must be a JSON array: $communityPluginsPath"
    }
    try {
        $parsedCommunityPlugins = ConvertFrom-Json -InputObject $rawCommunityPlugins
    } catch {
        throw "Obsidian community plugin configuration is invalid JSON: $communityPluginsPath"
    }
    foreach ($id in @($parsedCommunityPlugins)) {
        if ($id -isnot [string]) {
            throw "Obsidian community plugin configuration contains a non-string id: $communityPluginsPath"
        }
        if (-not $ownedLegacyPluginIds.Contains($id) -and -not $enabled.Contains($id)) {
            $enabled.Add($id)
        }
    }
}

$pluginTarget = [System.IO.Path]::GetFullPath(
    (Join-Path $vaultRoot '.obsidian\plugins\okf-claudian')
)
Install-OkfPluginAtomic `
    -Source $sourceRoot `
    -Target $pluginTarget `
    -ExpectedId 'okf-claudian' | Out-Null
foreach ($artifactName in $artifactNames) {
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $artifactName) -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath (Join-Path $pluginTarget $artifactName) -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw "Artifact verification failed: $artifactName" }
}

New-Item -ItemType Directory -Force -Path $settingsRoot | Out-Null
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
Write-OkfJson -Path $settingsPath -Value $settings

if (-not $enabled.Contains('okf-claudian')) { $enabled.Add('okf-claudian') }
Write-OkfJson -Path $communityPluginsPath -Value $enabled.ToArray()

foreach ($legacyId in $ownedLegacyPluginIds) {
    Remove-OkfRetiredPluginDirectory `
        -Vault $vaultRoot `
        -DirectoryName $legacyId `
        -AllowedManifestIds @('okf-claudian') | Out-Null
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
