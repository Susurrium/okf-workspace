[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Config,
    [switch]$RemoveData
)

. (Join-Path $PSScriptRoot 'common.ps1')
$configPath = Resolve-OkfPath $Config
$deployment = Read-OkfConfig $configPath
$validatedDataTargets = @()
if ($RemoveData) {
    foreach ($requiredProperty in @('vault', 'originals', 'state', 'installation_id')) {
        if ($deployment.PSObject.Properties.Name -notcontains $requiredProperty -or
            -not [string]$deployment.$requiredProperty) {
            throw "Deployment config is missing required removal identity: $requiredProperty"
        }
    }
    $repositoryRoot = if ($deployment.PSObject.Properties.Name -contains 'repository_root') {
        [string]$deployment.repository_root
    } else {
        ''
    }
    $dataLayout = Assert-OkfDataPathLayout `
        -Vault ([string]$deployment.vault) `
        -Originals ([string]$deployment.originals) `
        -State ([string]$deployment.state) `
        -RepositoryRoot $repositoryRoot
    $expectedConfigPath = Join-Path $dataLayout.state 'config\deployment.json'
    if (-not (Test-OkfSamePath -Left $configPath -Right $expectedConfigPath)) {
        throw "-RemoveData requires the managed deployment config at: $expectedConfigPath"
    }

    $installationId = [string]$deployment.installation_id
    $targetSpecs = @(
        @{ role = 'vault'; path = [string]$dataLayout.vault },
        @{ role = 'originals'; path = [string]$dataLayout.originals },
        @{ role = 'state'; path = [string]$dataLayout.state }
    )
    foreach ($targetSpec in $targetSpecs) {
        $targetPath = [string]$targetSpec.path
        $role = [string]$targetSpec.role
        if ($deployment.PSObject.Properties.Name -contains 'ownership_markers') {
            $configuredMarker = [string]$deployment.ownership_markers.$role
            $expectedMarker = Get-OkfOwnershipMarkerPath $targetPath
            if (-not $configuredMarker -or
                -not (Test-OkfSamePath -Left $configuredMarker -Right $expectedMarker)) {
                throw "Deployment config has an invalid $role ownership marker path."
            }
        }
        if (Test-Path -LiteralPath $targetPath) {
            $verifiedPath = Assert-OkfOwnershipMarker `
                -Target $targetPath `
                -Role $role `
                -InstallationId $installationId
            $validatedDataTargets += $verifiedPath
        }
    }
}

# The historical folder name alone is not proof that OKF owns it. Preflight
# before stopping tasks or changing plugin configuration so an ambiguous
# `claudian` directory leaves the whole uninstall untouched.
$ownedLegacyClaudian = Confirm-OkfRetiredPluginDirectoryOwnership `
    -Vault ([string]$deployment.vault) `
    -DirectoryName 'claudian' `
    -AllowedManifestIds @('okf-claudian')

foreach ($task in @(
    'OKF Workspace Daily Maintenance',
    'OKF Workspace Feed Sync',
    'OKF Brain Local Service',
    'OKF Brain Daily Maintenance',
    'Obsidian Workflow Hub',
    'Obsidian Codex Agent Worker'
    )) {
    $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($existing -and $PSCmdlet.ShouldProcess($task, 'Stop and unregister scheduled task')) {
        Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
}

$expectedPluginParent = Join-Path ([string]$deployment.vault) '.obsidian\plugins'
foreach ($pluginId in @(
    'okf-workspace-dashboard',
    'okf-brain-dashboard',
    'okf-claudian'
)) {
    $plugin = Join-Path $expectedPluginParent $pluginId
    if (Test-Path -LiteralPath $plugin) {
        $verifiedPlugin = Assert-OkfChildPath -Parent $expectedPluginParent -Child $plugin
        if ($PSCmdlet.ShouldProcess($verifiedPlugin, "Remove Dashboard plugin $pluginId")) {
            Remove-Item -LiteralPath $verifiedPlugin -Recurse -Force
            Write-Host "Removed plugin: $verifiedPlugin"
        }
    }
}
if ($ownedLegacyClaudian) {
    $legacyClaudian = Join-Path $expectedPluginParent 'claudian'
    if ($PSCmdlet.ShouldProcess($legacyClaudian, 'Remove owned retired Claudian plugin')) {
        Remove-OkfRetiredPluginDirectory `
            -Vault ([string]$deployment.vault) `
            -DirectoryName 'claudian' `
            -AllowedManifestIds @('okf-claudian') | Out-Null
        Write-Host "Removed plugin: $legacyClaudian"
    }
}

$communityPlugins = Join-Path ([string]$deployment.vault) '.obsidian\community-plugins.json'
if (Test-Path -LiteralPath $communityPlugins -PathType Leaf) {
    $enabled = @(Get-Content -LiteralPath $communityPlugins -Raw | ConvertFrom-Json)
    $removedPluginIds = @(
        'okf-workspace-dashboard',
        'okf-brain-dashboard',
        'okf-claudian'
    )
    if ($ownedLegacyClaudian) { $removedPluginIds += 'claudian' }
    $remaining = @($enabled | Where-Object { $_ -notin $removedPluginIds })
    if ($PSCmdlet.ShouldProcess($communityPlugins, 'Disable Workspace Obsidian plugins')) {
        Write-OkfJson -Path $communityPlugins -Value $remaining
    }
}

if ($RemoveData) {
    if ($validatedDataTargets.Count -eq 0) {
        Write-Host 'Managed Vault, Original Store and Runtime State were already absent.'
    } else {
        $targetSummary = $validatedDataTargets -join ', '
        if ($PSCmdlet.ShouldProcess($targetSummary, 'Remove all validated OKF Workspace data')) {
            foreach ($verified in $validatedDataTargets) {
                Remove-Item -LiteralPath $verified -Recurse -Force
                Write-Host "Removed data: $verified (not recoverable unless backed up)"
            }
        }
    }
} else {
    Write-Host 'Vault, Original Store, Runtime State and backups were preserved.'
}
