[CmdletBinding()]
param(
    [string]$Vault = 'E:\ObsidianData\OKF-Brain'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repository 'engine\workspace\skills'
$vaultRoot = [System.IO.Path]::GetFullPath($Vault)
if (-not (Test-Path -LiteralPath $vaultRoot -PathType Container)) {
    throw "Vault does not exist: $vaultRoot"
}
$targetRoot = [System.IO.Path]::GetFullPath(
    (Join-Path (Join-Path $vaultRoot '.agents') 'skills')
)
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null

$ownershipPath = Join-Path $targetRoot '.okf-managed-skills.json'
$ownershipOwner = 'okf-workspace-engine'
$ownershipExists = Test-Path -LiteralPath $ownershipPath -PathType Leaf
$ownedNames = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
if ($ownershipExists) {
    $ownership = Get-Content -LiteralPath $ownershipPath -Raw -Encoding UTF8 |
        ConvertFrom-Json -AsHashtable
    if ([int]$ownership['schema'] -ne 1 -or [string]$ownership['owner'] -ne $ownershipOwner) {
        throw "Unsupported OKF Skill ownership manifest: $ownershipPath"
    }
    foreach ($nameValue in @($ownership['skills'])) {
        $name = if ($nameValue -is [string]) { $nameValue.Trim() } else { '' }
        if (-not $name -or $name -in @('.', '..') -or $name.Contains('/') -or $name.Contains('\')) {
            throw "Unsafe Skill name in ownership manifest: $nameValue"
        }
        if (-not $ownedNames.Add($name)) {
            throw "Duplicate Skill name in ownership manifest: $name"
        }
    }
}

function Get-OkfSkillTreeFingerprint {
    param([Parameter(Mandatory)][string]$Root)

    $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
        throw "Skill directory does not exist: $resolvedRoot"
    }
    $entries = [System.Collections.Generic.List[string]]::new()
    foreach ($item in Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse | Sort-Object FullName) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Skill ownership migration refuses links: $($item.FullName)"
        }
        $relative = [System.IO.Path]::GetRelativePath($resolvedRoot, $item.FullName).Replace('\', '/')
        if ($item.PSIsContainer) {
            $entries.Add("directory`0$relative")
            continue
        }
        $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $entries.Add("file`0$relative`0$($item.Length)`0$hash")
    }
    return [string]::Join("`n", $entries)
}

$installed = [System.Collections.Generic.List[string]]::new()
$adopted = [System.Collections.Generic.List[string]]::new()
$sourceNames = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
)
$sourceDirectories = @(Get-ChildItem -LiteralPath $sourceRoot -Directory | Sort-Object Name)
foreach ($skillDirectory in $sourceDirectories) {
    $skillFile = Join-Path $skillDirectory.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
        throw "Skill source is incomplete: $($skillDirectory.FullName)"
    }
    [void]$sourceNames.Add($skillDirectory.Name)
    $target = Join-Path $targetRoot $skillDirectory.Name
    $resolvedTarget = [System.IO.Path]::GetFullPath($target)
    if (-not $resolvedTarget.StartsWith($targetRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to install outside the managed Skill directory: $resolvedTarget"
    }
    if ((Test-Path -LiteralPath $resolvedTarget) -and -not $ownedNames.Contains($skillDirectory.Name)) {
        $canAdopt = -not $ownershipExists -and
            (Get-OkfSkillTreeFingerprint -Root $skillDirectory.FullName) -ceq
            (Get-OkfSkillTreeFingerprint -Root $resolvedTarget)
        if (-not $canAdopt) {
            throw "Skill target exists but is not owned by OKF Workspace and differs from the current source: $resolvedTarget"
        }
        [void]$ownedNames.Add($skillDirectory.Name)
        $adopted.Add($skillDirectory.Name)
    }
}

$stageRoot = Join-Path (Split-Path -Parent $targetRoot) (
    '.okf-skill-stage-' + [guid]::NewGuid().ToString('N')
)
$manifestTemporary = $ownershipPath + '.tmp-' + [guid]::NewGuid().ToString('N')
try {
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    foreach ($skillDirectory in $sourceDirectories) {
        Copy-Item -LiteralPath $skillDirectory.FullName `
            -Destination (Join-Path $stageRoot $skillDirectory.Name) -Recurse
    }

    foreach ($skillDirectory in $sourceDirectories) {
        $resolvedTarget = [System.IO.Path]::GetFullPath(
            (Join-Path $targetRoot $skillDirectory.Name)
        )
        if (Test-Path -LiteralPath $resolvedTarget) {
            Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
        }
        Move-Item -LiteralPath (Join-Path $stageRoot $skillDirectory.Name) `
            -Destination $resolvedTarget
        $installed.Add($skillDirectory.Name)
    }

    foreach ($ownedName in $ownedNames) {
        if ($sourceNames.Contains($ownedName)) { continue }
        $resolvedStale = [System.IO.Path]::GetFullPath((Join-Path $targetRoot $ownedName))
        if (-not $resolvedStale.StartsWith($targetRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove outside the managed Skill directory: $resolvedStale"
        }
        if (Test-Path -LiteralPath $resolvedStale) {
            Remove-Item -LiteralPath $resolvedStale -Recurse -Force
        }
    }

    [ordered]@{
        schema = 1
        owner = $ownershipOwner
        skills = @($sourceDirectories | ForEach-Object { $_.Name })
    } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $manifestTemporary -Encoding UTF8 -NoNewline
    Move-Item -LiteralPath $manifestTemporary -Destination $ownershipPath -Force
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $manifestTemporary) {
        Remove-Item -LiteralPath $manifestTemporary -Force
    }
}

[pscustomobject]@{
    vault = $vaultRoot
    source = $sourceRoot
    target = $targetRoot
    ownership = $ownershipPath
    installed = $installed.ToArray()
    adopted = $adopted.ToArray()
    note = 'Only Skills listed in the OKF ownership manifest are updated or retired; unknown user Skills are preserved.'
} | ConvertTo-Json -Depth 4
