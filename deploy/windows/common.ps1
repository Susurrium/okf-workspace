Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-OkfPath {
    param([Parameter(Mandatory)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Write-OkfJson {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $json = ConvertTo-Json -InputObject $Value -Depth 10
    $resolvedPath = Resolve-OkfPath $Path
    $temporaryPath = Join-Path $parent ".$(Split-Path -Leaf $resolvedPath).tmp-$([guid]::NewGuid().ToString('N'))"
    $backupPath = Join-Path $parent ".$(Split-Path -Leaf $resolvedPath).backup-$([guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            $json,
            (New-Object System.Text.UTF8Encoding($false))
        )
        if (Test-Path -LiteralPath $resolvedPath -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $resolvedPath, $backupPath)
            Remove-Item -LiteralPath $backupPath -Force
        } else {
            [System.IO.File]::Move($temporaryPath, $resolvedPath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Read-OkfConfig {
    param([Parameter(Mandatory)][string]$Config)
    if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
        throw "Deployment config not found: $Config"
    }
    return Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
}

function Set-OkfEnvironment {
    param([Parameter(Mandatory)][object]$Config)
    $env:OKF_BRAIN_VAULT = [string]$Config.vault
    $env:OKF_BRAIN_ORIGINALS = [string]$Config.originals
    $env:OKF_BRAIN_STATE = [string]$Config.state
    $env:OKF_MINERU_URL = [string]$Config.mineru_url
    if ($Config.PSObject.Properties.Name -contains 'mineru_ssh_managed') {
        $env:OKF_MINERU_SSH_MANAGED = [string]$Config.mineru_ssh_managed
        $env:OKF_MINERU_SSH_HOST = [string]$Config.mineru_ssh_host
        $env:OKF_MINERU_SSH_REMOTE_PORT = [string]$Config.mineru_ssh_remote_port
    }
    $env:OKF_MARKITDOWN_URL = [string]$Config.markitdown_url
    if ($Config.PSObject.Properties.Name -contains 'markitdown_token_file') {
        $env:OKF_MARKITDOWN_TOKEN_FILE = [string]$Config.markitdown_token_file
    }
    if ($Config.PSObject.Properties.Name -contains 'ai_base_url') {
        $env:OKF_AI_BASE_URL = [string]$Config.ai_base_url
        $env:OKF_AI_MODEL = [string]$Config.ai_model
        $env:OKF_AI_API_KEY_FILE = [string]$Config.ai_api_key_file
    }
    if ($Config.PSObject.Properties.Name -contains 'ai_mode') {
        $env:OKF_AI_MODE = [string]$Config.ai_mode
        $env:OKF_CODEX_COMMAND = [string]$Config.codex_command
        $env:OKF_CODEX_MODEL = [string]$Config.codex_model
    }
    if ($Config.PSObject.Properties.Name -contains 'semantic_timeout_seconds') {
        $env:OKF_SEMANTIC_TIMEOUT_SECONDS = [string]$Config.semantic_timeout_seconds
    }
    if ($Config.PSObject.Properties.Name -contains 'semantic_retrieval_timeout_seconds') {
        $env:OKF_SEMANTIC_RETRIEVAL_TIMEOUT_SECONDS = [string]$Config.semantic_retrieval_timeout_seconds
    }
    if ($Config.PSObject.Properties.Name -contains 'livesync_required') {
        $env:OKF_LIVESYNC_REQUIRED = [string]$Config.livesync_required
    }
    $env:OKF_API_HOST = '127.0.0.1'
    $env:OKF_API_PORT = [string]$Config.api_port
}

function Assert-OkfCommand {
    param([Parameter(Mandatory)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $searchPath = @(
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
    ) -join ';'
    foreach ($directory in ($searchPath -split ';' | Where-Object { $_ })) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
        $match = Get-ChildItem -LiteralPath $directory -File -Filter "$Name*.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    throw "Required command is unavailable: $Name"
}

function Assert-OkfChildPath {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child
    )
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $resolvedParent = (Resolve-OkfPath $Parent).TrimEnd('\', '/') + $separator
    $resolvedChild = Resolve-OkfPath $Child
    if (-not $resolvedChild.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside intended root: $resolvedChild"
    }
    return $resolvedChild
}

function Test-OkfSamePath {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )
    $resolvedLeft = (Resolve-OkfPath $Left).TrimEnd('\', '/')
    $resolvedRight = (Resolve-OkfPath $Right).TrimEnd('\', '/')
    return $resolvedLeft.Equals($resolvedRight, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-OkfNestedPath {
    param(
        [Parameter(Mandatory)][string]$Parent,
        [Parameter(Mandatory)][string]$Child
    )
    $resolvedParent = (Resolve-OkfPath $Parent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $resolvedChild = Resolve-OkfPath $Child
    return $resolvedChild.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-OkfDataPathLayout {
    param(
        [Parameter(Mandatory)][string]$Vault,
        [Parameter(Mandatory)][string]$Originals,
        [Parameter(Mandatory)][string]$State,
        [string]$RepositoryRoot = ''
    )

    $resolved = [ordered]@{
        vault = Resolve-OkfPath $Vault
        originals = Resolve-OkfPath $Originals
        state = Resolve-OkfPath $State
    }

    foreach ($entry in $resolved.GetEnumerator()) {
        $root = [System.IO.Path]::GetPathRoot([string]$entry.Value)
        if ((Test-OkfSamePath -Left ([string]$entry.Value) -Right $root)) {
            throw "Refusing to use a drive root as $($entry.Key): $($entry.Value)"
        }
        if ($RepositoryRoot -and (Test-OkfSamePath -Left ([string]$entry.Value) -Right $RepositoryRoot)) {
            throw "Refusing to use the repository root as $($entry.Key): $($entry.Value)"
        }
    }

    $names = @($resolved.Keys)
    for ($leftIndex = 0; $leftIndex -lt $names.Count; $leftIndex++) {
        for ($rightIndex = $leftIndex + 1; $rightIndex -lt $names.Count; $rightIndex++) {
            $leftName = [string]$names[$leftIndex]
            $rightName = [string]$names[$rightIndex]
            $leftPath = [string]$resolved[$leftName]
            $rightPath = [string]$resolved[$rightName]
            if ((Test-OkfSamePath -Left $leftPath -Right $rightPath) -or
                (Test-OkfNestedPath -Parent $leftPath -Child $rightPath) -or
                (Test-OkfNestedPath -Parent $rightPath -Child $leftPath)) {
                throw "Vault, Originals and State must be separate, non-nested paths; $leftName=$leftPath, $rightName=$rightPath"
            }
        }
    }

    return [pscustomobject]$resolved
}

function Get-OkfOwnershipMarkerPath {
    param([Parameter(Mandatory)][string]$Target)
    return Join-Path (Resolve-OkfPath $Target) '.okf-workspace-owner.json'
}

function Assert-OkfOwnershipMarker {
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][ValidateSet('vault', 'originals', 'state')][string]$Role,
        [Parameter(Mandatory)][string]$InstallationId
    )

    $resolvedTarget = Resolve-OkfPath $Target
    if (-not (Test-Path -LiteralPath $resolvedTarget -PathType Container)) {
        throw "Managed $Role directory does not exist: $resolvedTarget"
    }
    $targetItem = Get-Item -LiteralPath $resolvedTarget -Force
    if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing managed data path through a reparse point: $resolvedTarget"
    }

    $markerPath = Get-OkfOwnershipMarkerPath $resolvedTarget
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "Ownership marker is missing for ${Role}: $markerPath. Re-run the installer before using -RemoveData."
    }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ([string]$marker.product -ne 'okf-workspace' -or
        [string]$marker.role -ne $Role -or
        [string]$marker.installation_id -ne $InstallationId -or
        -not (Test-OkfSamePath -Left ([string]$marker.path) -Right $resolvedTarget)) {
        throw "Ownership marker does not match the requested $Role directory: $markerPath"
    }
    return $resolvedTarget
}

function Write-OkfOwnershipMarker {
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][ValidateSet('vault', 'originals', 'state')][string]$Role,
        [Parameter(Mandatory)][string]$InstallationId
    )
    $resolvedTarget = Resolve-OkfPath $Target
    Write-OkfJson -Path (Get-OkfOwnershipMarkerPath $resolvedTarget) -Value ([ordered]@{
        schema = 1
        product = 'okf-workspace'
        role = $Role
        installation_id = $InstallationId
        path = $resolvedTarget
    })
}

function Install-OkfPluginArtifactsAtomic {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Artifacts,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$ExpectedId
    )

    $targetPath = Resolve-OkfPath $Target
    if ((Split-Path -Leaf $targetPath) -cne $ExpectedId) {
        throw "Plugin target directory must be named '$ExpectedId': $targetPath"
    }

    $requiredFiles = @('main.js', 'manifest.json', 'styles.css')
    foreach ($file in $requiredFiles) {
        if (-not $Artifacts.Contains($file)) {
            throw "Plugin artifact mapping is missing: $file"
        }
        $sourceFile = Resolve-OkfPath ([string]$Artifacts[$file])
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Plugin file missing: $sourceFile"
        }
    }
    $manifestPath = Resolve-OkfPath ([string]$Artifacts['manifest.json'])
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Plugin manifest is invalid JSON: $manifestPath"
    }
    if ([string]$manifest.id -cne $ExpectedId) {
        throw "Plugin manifest id must be '$ExpectedId', found '$([string]$manifest.id)'"
    }

    $targetParent = Split-Path -Parent $targetPath
    New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    if (Test-Path -LiteralPath $targetPath) {
        if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
            throw "Plugin target is not a directory: $targetPath"
        }
        $targetItem = Get-Item -LiteralPath $targetPath -Force
        if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing plugin install through a reparse point: $targetPath"
        }
    }
    $operationId = [guid]::NewGuid().ToString('N')
    $stagePath = Join-Path $targetParent ".$ExpectedId.stage-$operationId"
    $backupPath = Join-Path $targetParent ".$ExpectedId.backup-$operationId"
    New-Item -ItemType Directory -Path $stagePath | Out-Null
    try {
        if (Test-Path -LiteralPath $targetPath -PathType Container) {
            Get-ChildItem -LiteralPath $targetPath -Force |
                Copy-Item -Destination $stagePath -Recurse -Force
        }
        foreach ($file in $requiredFiles) {
            Copy-Item -LiteralPath (Resolve-OkfPath ([string]$Artifacts[$file])) `
                -Destination (Join-Path $stagePath $file) -Force
        }

        if (Test-Path -LiteralPath $targetPath) {
            Move-Item -LiteralPath $targetPath -Destination $backupPath
        }
        try {
            Move-Item -LiteralPath $stagePath -Destination $targetPath
        } catch {
            if (Test-Path -LiteralPath $backupPath) {
                Move-Item -LiteralPath $backupPath -Destination $targetPath
            }
            throw
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Recurse -Force
        }
    } finally {
        if (Test-Path -LiteralPath $stagePath) {
            Remove-Item -LiteralPath $stagePath -Recurse -Force
        }
    }
    return $targetPath
}

function Install-OkfPluginAtomic {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$ExpectedId
    )

    $sourcePath = Resolve-OkfPath $Source
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Plugin source directory not found: $sourcePath"
    }
    return Install-OkfPluginArtifactsAtomic `
        -Artifacts ([ordered]@{
            'main.js' = Join-Path $sourcePath 'main.js'
            'manifest.json' = Join-Path $sourcePath 'manifest.json'
            'styles.css' = Join-Path $sourcePath 'styles.css'
        }) `
        -Target $Target `
        -ExpectedId $ExpectedId
}

function Confirm-OkfRetiredPluginDirectoryOwnership {
    param(
        [Parameter(Mandatory)][string]$Vault,
        [Parameter(Mandatory)][string]$DirectoryName,
        [Parameter(Mandatory)][string[]]$AllowedManifestIds
    )

    $vaultPath = Resolve-OkfPath $Vault
    $pluginsRoot = Join-Path $vaultPath '.obsidian\plugins'
    $target = Assert-OkfChildPath `
        -Parent $pluginsRoot `
        -Child (Join-Path $pluginsRoot $DirectoryName)
    if (-not (Test-Path -LiteralPath $target)) { return $false }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        throw "Retired plugin path is not a directory: $target"
    }
    $targetItem = Get-Item -LiteralPath $target -Force
    if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing retired plugin cleanup through a reparse point: $target"
    }
    $manifestPath = Join-Path $target 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Refusing to remove retired plugin without a manifest: $target"
    }
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing retired plugin cleanup with a linked manifest: $manifestPath"
    }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Retired plugin manifest is invalid JSON: $manifestPath"
    }
    $manifestId = [string]$manifest.id
    if ($AllowedManifestIds -cnotcontains $manifestId) {
        throw "Refusing to remove retired plugin directory with manifest id '$manifestId': $target"
    }
    return $true
}

function Remove-OkfRetiredPluginDirectory {
    param(
        [Parameter(Mandatory)][string]$Vault,
        [Parameter(Mandatory)][string]$DirectoryName,
        [Parameter(Mandatory)][string[]]$AllowedManifestIds
    )

    $owned = Confirm-OkfRetiredPluginDirectoryOwnership `
        -Vault $Vault `
        -DirectoryName $DirectoryName `
        -AllowedManifestIds $AllowedManifestIds
    if (-not $owned) { return $false }

    $vaultPath = Resolve-OkfPath $Vault
    $pluginsRoot = Join-Path $vaultPath '.obsidian\plugins'
    $target = Assert-OkfChildPath `
        -Parent $pluginsRoot `
        -Child (Join-Path $pluginsRoot $DirectoryName)
    Remove-Item -LiteralPath $target -Recurse -Force
    return $true
}

function Install-OkfDashboardPluginAtomic {
    param(
        [Parameter(Mandatory)][string]$DashboardRoot,
        [Parameter(Mandatory)][string]$Target
    )

    $sourcePath = Resolve-OkfPath $DashboardRoot
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Dashboard source directory not found: $sourcePath"
    }
    return Install-OkfPluginArtifactsAtomic `
        -Artifacts ([ordered]@{
            'main.js' = Join-Path $sourcePath 'dist\main.js'
            'manifest.json' = Join-Path $sourcePath 'manifest.json'
            'styles.css' = Join-Path $sourcePath 'styles.css'
        }) `
        -Target $Target `
        -ExpectedId 'okf-workspace-dashboard'
}

function Complete-OkfDashboardPluginMigration {
    param([Parameter(Mandatory)][string]$Vault)

    $currentId = 'okf-workspace-dashboard'
    $legacyId = 'okf-brain-dashboard'
    $vaultPath = Resolve-OkfPath $Vault
    $obsidianRoot = Join-Path $vaultPath '.obsidian'
    $pluginsRoot = Join-Path $obsidianRoot 'plugins'
    $currentTarget = Assert-OkfChildPath `
        -Parent $pluginsRoot `
        -Child (Join-Path $pluginsRoot $currentId)
    $currentManifestPath = Join-Path $currentTarget 'manifest.json'
    if (-not (Test-Path -LiteralPath $currentManifestPath -PathType Leaf)) {
        throw "Installed Dashboard manifest is missing: $currentManifestPath"
    }
    try {
        $currentManifest = Get-Content -LiteralPath $currentManifestPath -Raw | ConvertFrom-Json
    } catch {
        throw "Installed Dashboard manifest is invalid JSON: $currentManifestPath"
    }
    if ([string]$currentManifest.id -cne $currentId) {
        throw "Installed Dashboard manifest id must be '$currentId', found '$([string]$currentManifest.id)'"
    }

    $legacyTarget = Assert-OkfChildPath `
        -Parent $pluginsRoot `
        -Child (Join-Path $pluginsRoot $legacyId)
    $removeLegacy = Test-Path -LiteralPath $legacyTarget
    if ($removeLegacy) {
        if (-not (Test-Path -LiteralPath $legacyTarget -PathType Container)) {
            throw "Legacy Dashboard path is not a directory: $legacyTarget"
        }
        $legacyItem = Get-Item -LiteralPath $legacyTarget -Force
        if (($legacyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing legacy Dashboard cleanup through a reparse point: $legacyTarget"
        }
        $legacyManifestPath = Join-Path $legacyTarget 'manifest.json'
        if (Test-Path -LiteralPath $legacyManifestPath -PathType Leaf) {
            try {
                $legacyManifest = Get-Content -LiteralPath $legacyManifestPath -Raw | ConvertFrom-Json
            } catch {
                throw "Legacy Dashboard manifest is invalid JSON: $legacyManifestPath"
            }
            if ([string]$legacyManifest.id -cne $legacyId) {
                throw "Refusing to remove legacy Dashboard directory with manifest id '$([string]$legacyManifest.id)': $legacyTarget"
            }
        }
    }

    $communityPlugins = Join-Path $obsidianRoot 'community-plugins.json'
    $loaded = @()
    if (Test-Path -LiteralPath $communityPlugins -PathType Leaf) {
        $rawCommunityPlugins = Get-Content -LiteralPath $communityPlugins -Raw
        if (-not $rawCommunityPlugins.Trim().StartsWith('[') -or
            -not $rawCommunityPlugins.Trim().EndsWith(']')) {
            throw "Obsidian community plugin configuration must be a JSON array: $communityPlugins"
        }
        try {
            # Windows PowerShell 5.1 emits a JSON array as one Object[] pipeline
            # item, while PowerShell 7 enumerates it. Assign first, then normalize.
            $parsedCommunityPlugins = ConvertFrom-Json -InputObject $rawCommunityPlugins
            $loaded = @($parsedCommunityPlugins)
        } catch {
            throw "Obsidian community plugin configuration is invalid JSON: $communityPlugins"
        }
    }

    $preserved = [System.Collections.Generic.List[string]]::new()
    foreach ($pluginId in $loaded) {
        if ($pluginId -isnot [string]) {
            throw "Obsidian community plugin configuration contains a non-string id: $communityPlugins"
        }
        if ([string]::Equals($pluginId, $currentId, [System.StringComparison]::Ordinal) -or
            [string]::Equals($pluginId, $legacyId, [System.StringComparison]::Ordinal)) {
            continue
        }
        $preserved.Add($pluginId)
    }
    $enabled = @($currentId) + @($preserved.ToArray())

    # Commit the load order before deleting the retired code. A failed delete is
    # safe to retry: the old directory remains present but is no longer enabled.
    Write-OkfJson -Path $communityPlugins -Value $enabled
    if ($removeLegacy) {
        Remove-Item -LiteralPath $legacyTarget -Recurse -Force
    }
    return $enabled
}
