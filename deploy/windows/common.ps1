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
    $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
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
    $resolvedParent = (Resolve-OkfPath $Parent).TrimEnd('\') + '\'
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

function Install-OkfPluginAtomic {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$ExpectedId
    )

    $sourcePath = Resolve-OkfPath $Source
    $targetPath = Resolve-OkfPath $Target
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Plugin source directory not found: $sourcePath"
    }

    $requiredFiles = @('main.js', 'manifest.json', 'styles.css')
    foreach ($file in $requiredFiles) {
        $sourceFile = Join-Path $sourcePath $file
        if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            throw "Plugin file missing: $sourceFile"
        }
    }
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $sourcePath 'manifest.json') -Raw | ConvertFrom-Json
    } catch {
        throw "Plugin manifest is invalid JSON: $(Join-Path $sourcePath 'manifest.json')"
    }
    if ([string]$manifest.id -ne $ExpectedId) {
        throw "Plugin manifest id must be '$ExpectedId', found '$([string]$manifest.id)'"
    }

    $targetParent = Split-Path -Parent $targetPath
    New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
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
            Copy-Item -LiteralPath (Join-Path $sourcePath $file) -Destination (Join-Path $stagePath $file) -Force
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
