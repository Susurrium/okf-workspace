[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Vault,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$CompareTo
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '..\deploy\windows\common.ps1')

function ConvertTo-CanonicalValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[[string]$key] = ConvertTo-CanonicalValue $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [System.Array] -or $Value -is [System.Collections.IList]) {
        $items = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Value) { $items.Add((ConvertTo-CanonicalValue $item)) }
        return ,$items.ToArray()
    }
    return $Value
}

function Get-CanonicalSha256 {
    param([AllowNull()][object]$Value)

    $json = ConvertTo-Json -InputObject (ConvertTo-CanonicalValue $Value) -Depth 100 -Compress
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Read-JsonHashtable {
    param([Parameter(Mandatory)][string]$Path)

    try {
        return Read-OkfJsonHashtable -Path $Path -Description 'Dashboard rollback snapshot JSON'
    } catch {
        throw "Invalid JSON in $Path"
    }
}

$vaultRoot = [System.IO.Path]::GetFullPath($Vault)
$pluginRoot = Join-Path $vaultRoot '.obsidian\plugins\okf-workspace-dashboard'
$manifestPath = Join-Path $pluginRoot 'manifest.json'
$settingsPath = Join-Path $pluginRoot 'data.json'
$receiptPath = Join-Path $pluginRoot 'apex-native-data-takeover.json'
$enabledPath = Join-Path $vaultRoot '.obsidian\community-plugins.json'

foreach ($path in @($manifestPath, $settingsPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required Dashboard state file is missing: $path"
    }
}

$manifest = Read-JsonHashtable -Path $manifestPath
if ([string]$manifest.id -cne 'okf-workspace-dashboard') {
    throw "Unexpected Dashboard plugin id: $([string]$manifest.id)"
}

$settings = Read-JsonHashtable -Path $settingsPath
$settings.Remove('token')
$nativeHashes = [ordered]@{}
foreach ($name in @('habits.json', 'expense.json', 'pomodoro.json', 'reading.json', 'weread-progress.json')) {
    $path = Join-Path $pluginRoot $name
    $nativeHashes[$name] = if (Test-Path -LiteralPath $path -PathType Leaf) {
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
        $null
    }
}

$auditHash = $null
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw "Required native-data takeover receipt is missing: $receiptPath"
}
$audit = Read-JsonHashtable -Path $receiptPath
$null = $audit.Remove('completedAt')
foreach ($entry in @($audit.entries)) {
    if ($entry.status -eq 'copied' -or $entry.status -eq 'already-copied') {
        $entry.status = 'target-present'
    }
}
$auditHash = Get-CanonicalSha256 $audit

$enabled = @()
if (Test-Path -LiteralPath $enabledPath -PathType Leaf) {
    $enabled = @(Get-Content -LiteralPath $enabledPath -Raw | ConvertFrom-Json)
}
$conflictingDashboardIds = @('okf-brain-dashboard', 'apex-dashboard')
$snapshot = [ordered]@{
    pluginId = [string]$manifest.id
    pluginVersion = [string]$manifest.version
    dashboardEnabledExactlyOnce = (@($enabled | Where-Object { $_ -ceq 'okf-workspace-dashboard' }).Count -eq 1) -and
        (@($enabled | Where-Object { $_ -cin $conflictingDashboardIds }).Count -eq 0)
    settingsSha256WithoutTransientToken = Get-CanonicalSha256 $settings
    nativeDataSha256 = $nativeHashes
    normalizedTakeoverReceiptSha256 = $auditHash
}

$result = [ordered]@{ snapshot = $snapshot }
if ($CompareTo) {
    if (-not (Test-Path -LiteralPath $CompareTo -PathType Leaf)) {
        throw "Comparison snapshot is missing: $CompareTo"
    }
    $before = (Read-JsonHashtable -Path $CompareTo).snapshot
    $checks = [ordered]@{
        unifiedPluginIdentity = ($before.pluginId -ceq $snapshot.pluginId) -and
            ($snapshot.pluginId -ceq 'okf-workspace-dashboard')
        unifiedPluginEnabled = [bool]$before.dashboardEnabledExactlyOnce -and
            [bool]$snapshot.dashboardEnabledExactlyOnce
        semanticSettings = $before.settingsSha256WithoutTransientToken -ceq $snapshot.settingsSha256WithoutTransientToken
        nativeDataBytes = (Get-CanonicalSha256 $before.nativeDataSha256) -ceq
            (Get-CanonicalSha256 $snapshot.nativeDataSha256)
        normalizedTakeoverReceipt = $before.normalizedTakeoverReceiptSha256 -ceq
            $snapshot.normalizedTakeoverReceiptSha256
    }
    $result.checks = $checks
    $result.allPassed = @($checks.Values | Where-Object { -not $_ }).Count -eq 0
    $result.priorPluginVersion = [string]$before.pluginVersion
}

$output = ConvertTo-Json -InputObject $result -Depth 100
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
if ($resolvedOutput.StartsWith($vaultRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Write the rollback snapshot outside the Vault so it cannot become Vault content.'
}
$outputDirectory = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
[System.IO.File]::WriteAllText(
    $resolvedOutput,
    $output,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Output $output

if ($CompareTo -and -not $result.allPassed) {
    throw 'Dashboard rollback state comparison failed; inspect the redacted check results above.'
}
