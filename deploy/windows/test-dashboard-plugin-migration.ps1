[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'common.ps1')

function Assert-Test {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Sequence {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Actual,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    $actualJson = ConvertTo-Json -InputObject @($Actual) -Compress
    $expectedJson = ConvertTo-Json -InputObject @($Expected) -Compress
    Assert-Test -Condition ($actualJson -ceq $expectedJson) `
        -Message "$Message; expected=$expectedJson actual=$actualJson"
}

function Assert-Throws {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$MessagePattern
    )
    $caught = $null
    try {
        & $Action | Out-Null
    } catch {
        $caught = $_
    }
    Assert-Test -Condition ($null -ne $caught) -Message "Expected failure matching: $MessagePattern"
    Assert-Test -Condition ($caught.Exception.Message -like "*$MessagePattern*") `
        -Message "Unexpected failure: $($caught.Exception.Message)"
}

function New-TestPlugin {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Id,
        [string]$Main = 'main',
        [string]$Styles = 'styles'
    )
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Root 'main.js'), $Main)
    [System.IO.File]::WriteAllText(
        (Join-Path $Root 'manifest.json'),
        (ConvertTo-Json -InputObject ([ordered]@{ id = $Id; version = 'test' }) -Compress)
    )
    [System.IO.File]::WriteAllText((Join-Path $Root 'styles.css'), $Styles)
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = Join-Path $temporaryRoot "okf-dashboard-migration-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    # The rollback snapshot reports only hashes/status. Volatile auth tokens,
    # receipt timestamps, and copied->already-copied transitions normalize,
    # while any native-data byte change must block acceptance.
    $snapshotVault = Join-Path $testRoot 'snapshot-vault'
    $snapshotPlugin = Join-Path $snapshotVault '.obsidian\plugins\okf-workspace-dashboard'
    New-Item -ItemType Directory -Force -Path $snapshotPlugin | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $snapshotVault '.obsidian') | Out-Null
    $snapshotScript = [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot '..\..\scripts\dashboard-rollback-snapshot.ps1')
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotPlugin 'manifest.json'),
        '{"id":"okf-workspace-dashboard","version":"2"}'
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotPlugin 'data.json'),
        '{"engineUrl":"http://localhost:18765","token":"first-secret"}'
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotVault '.obsidian\community-plugins.json'),
        '["okf-workspace-dashboard"]'
    )
    foreach ($nativeFile in @('habits.json', 'expense.json', 'pomodoro.json', 'reading.json', 'weread-progress.json')) {
        [System.IO.File]::WriteAllText((Join-Path $snapshotPlugin $nativeFile), '{"fixture":true}')
    }
    $receipt = [ordered]@{
        version = 1
        sourcePluginId = 'apex-dashboard'
        targetPluginId = 'okf-workspace-dashboard'
        completedAt = '2026-09-28T01:00:00Z'
        entries = @([ordered]@{
            file = 'reading.json'
            status = 'copied'
            sourceBytes = 15
            targetBytes = 15
        })
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotPlugin 'apex-native-data-takeover.json'),
        (ConvertTo-Json -InputObject $receipt -Depth 10)
    )
    $snapshotBefore = Join-Path $testRoot 'rollback-before.json'
    $snapshotAfter = Join-Path $testRoot 'rollback-after.json'
    & $snapshotScript -Vault $snapshotVault -OutputPath $snapshotBefore | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotPlugin 'data.json'),
        '{"engineUrl":"http://localhost:18765","token":"second-secret"}'
    )
    $receipt.completedAt = '2026-09-28T01:10:00Z'
    $receipt.entries[0].status = 'already-copied'
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotPlugin 'apex-native-data-takeover.json'),
        (ConvertTo-Json -InputObject $receipt -Depth 10)
    )
    $snapshotOutput = & $snapshotScript `
        -Vault $snapshotVault `
        -OutputPath $snapshotAfter `
        -CompareTo $snapshotBefore | Out-String
    Assert-Test -Condition ($snapshotOutput -match '"allPassed": true') `
        -Message 'Equivalent rollback state failed its normalized snapshot comparison'
    Assert-Test -Condition ($snapshotOutput -notmatch 'first-secret|second-secret') `
        -Message 'Rollback snapshot output exposed a transient token'
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotVault '.obsidian\community-plugins.json'),
        '["okf-workspace-dashboard","apex-dashboard"]'
    )
    Assert-Throws `
        -Action {
            & $snapshotScript `
                -Vault $snapshotVault `
                -OutputPath (Join-Path $testRoot 'rollback-conflicting-plugin.json') `
                -CompareTo $snapshotBefore
        } `
        -MessagePattern 'comparison failed'
    [System.IO.File]::WriteAllText(
        (Join-Path $snapshotVault '.obsidian\community-plugins.json'),
        '["okf-workspace-dashboard"]'
    )
    Assert-Throws `
        -Action {
            & $snapshotScript `
                -Vault $snapshotVault `
                -OutputPath (Join-Path $snapshotVault 'snapshot.json')
        } `
        -MessagePattern 'outside the Vault'
    [System.IO.File]::WriteAllText((Join-Path $snapshotPlugin 'reading.json'), '{"fixture":false}')
    Assert-Throws `
        -Action {
            & $snapshotScript `
                -Vault $snapshotVault `
                -OutputPath (Join-Path $testRoot 'rollback-drift.json') `
                -CompareTo $snapshotBefore
        } `
        -MessagePattern 'comparison failed'

    # An upgrade replaces code as one staged directory swap and preserves the
    # target's user-owned data.json. Invalid source artifacts never touch it.
    $packageRoot = Join-Path $testRoot 'dashboard-package'
    New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'dist') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $packageRoot 'dist\main.js'), 'new-main')
    [System.IO.File]::WriteAllText(
        (Join-Path $packageRoot 'manifest.json'),
        '{"id":"okf-workspace-dashboard","version":"2"}'
    )
    [System.IO.File]::WriteAllText((Join-Path $packageRoot 'styles.css'), 'unbundled-styles')
    [System.IO.File]::WriteAllText((Join-Path $packageRoot 'dist\styles.css'), 'new-styles')

    $installVault = Join-Path $testRoot 'install-vault'
    $installPlugins = Join-Path $installVault '.obsidian\plugins'
    $installTarget = Join-Path $installPlugins 'okf-workspace-dashboard'
    New-TestPlugin -Root $installTarget -Id 'okf-workspace-dashboard' `
        -Main 'old-main' -Styles 'old-styles'
    [System.IO.File]::WriteAllText((Join-Path $installTarget 'data.json'), '{"userSetting":true}')

    Install-OkfDashboardPluginAtomic -DashboardRoot $packageRoot -Target $installTarget | Out-Null
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'main.js') -Raw) -ceq 'new-main') `
        -Message 'Dashboard main.js was not upgraded'
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'styles.css') -Raw) -ceq 'new-styles') `
        -Message 'Dashboard bundled styles.css was not upgraded'
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'data.json') -Raw) -ceq '{"userSetting":true}') `
        -Message 'Atomic Dashboard upgrade did not preserve data.json'

    # Rollback is the same atomic artifact install with the backed-up prior
    # bundle. It must restore the old code without rolling settings backward.
    $rollbackPackageRoot = Join-Path $testRoot 'rollback-package'
    New-Item -ItemType Directory -Force -Path (Join-Path $rollbackPackageRoot 'dist') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $rollbackPackageRoot 'dist\main.js'), 'old-main')
    [System.IO.File]::WriteAllText((Join-Path $rollbackPackageRoot 'dist\styles.css'), 'old-styles')
    [System.IO.File]::WriteAllText(
        (Join-Path $rollbackPackageRoot 'manifest.json'),
        '{"id":"okf-workspace-dashboard","version":"1"}'
    )
    Install-OkfDashboardPluginAtomic -DashboardRoot $rollbackPackageRoot -Target $installTarget | Out-Null
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'main.js') -Raw) -ceq 'old-main') `
        -Message 'Rollback did not restore the backed-up main.js'
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'styles.css') -Raw) -ceq 'old-styles') `
        -Message 'Rollback did not restore the backed-up styles.css'
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'manifest.json') -Raw | ConvertFrom-Json).version -ceq '1') `
        -Message 'Rollback did not restore the prior plugin version'
    Assert-Test -Condition ((Get-Content -LiteralPath (Join-Path $installTarget 'data.json') -Raw) -ceq '{"userSetting":true}') `
        -Message 'Rollback changed user-owned plugin settings'

    $installedMain = [System.IO.File]::ReadAllBytes((Join-Path $installTarget 'main.js'))
    [System.IO.File]::WriteAllText((Join-Path $packageRoot 'dist\main.js'), 'must-not-install')
    [System.IO.File]::WriteAllText(
        (Join-Path $packageRoot 'manifest.json'),
        '{"id":"some-other-plugin","version":"3"}'
    )
    Assert-Throws `
        -Action { Install-OkfDashboardPluginAtomic -DashboardRoot $packageRoot -Target $installTarget } `
        -MessagePattern "manifest id must be 'okf-workspace-dashboard'"
    Assert-Test `
        -Condition ([System.Linq.Enumerable]::SequenceEqual(
            [byte[]]$installedMain,
            [byte[]][System.IO.File]::ReadAllBytes((Join-Path $installTarget 'main.js'))
        )) `
        -Message 'Invalid Dashboard package changed the installed plugin'
    Assert-Test -Condition (@(
            Get-ChildItem -LiteralPath $installPlugins -Force |
                Where-Object { $_.Name -like '.okf-workspace-dashboard.*' }
        ).Count -eq 0) -Message 'Atomic plugin install left staging or backup directories'

    # Migration removes only the exact retired Dashboard id. The current id is
    # first for deterministic plugin load/Ribbon registration; every other id
    # keeps its original order, including duplicates and case-distinct ids.
    $migrationVault = Join-Path $testRoot 'migration-vault'
    $migrationPlugins = Join-Path $migrationVault '.obsidian\plugins'
    New-TestPlugin `
        -Root (Join-Path $migrationPlugins 'okf-workspace-dashboard') `
        -Id 'okf-workspace-dashboard'
    New-TestPlugin `
        -Root (Join-Path $migrationPlugins 'okf-brain-dashboard') `
        -Id 'okf-brain-dashboard'
    New-TestPlugin -Root (Join-Path $migrationPlugins 'user-alpha') -Id 'user-alpha'
    New-TestPlugin -Root (Join-Path $migrationPlugins 'templater-obsidian') -Id 'templater-obsidian'
    $communityPlugins = Join-Path $migrationVault '.obsidian\community-plugins.json'
    Write-OkfJson -Path $communityPlugins -Value @(
        'user-alpha',
        'okf-brain-dashboard',
        'templater-obsidian',
        'okf-workspace-dashboard',
        'OKF-BRAIN-DASHBOARD',
        'user-alpha'
    )

    Complete-OkfDashboardPluginMigration -Vault $migrationVault | Out-Null
    $expectedEnabled = @(
        'okf-workspace-dashboard',
        'user-alpha',
        'templater-obsidian',
        'OKF-BRAIN-DASHBOARD',
        'user-alpha'
    )
    $parsedEnabled = Get-Content -LiteralPath $communityPlugins -Raw | ConvertFrom-Json
    $actualEnabled = @($parsedEnabled)
    Assert-Sequence -Actual $actualEnabled -Expected $expectedEnabled `
        -Message 'Dashboard migration did not preserve user plugin order'
    Assert-Test `
        -Condition (-not (Test-Path -LiteralPath (Join-Path $migrationPlugins 'okf-brain-dashboard'))) `
        -Message 'Legacy Dashboard directory was not removed'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $migrationPlugins 'user-alpha\manifest.json') -PathType Leaf) `
        -Message 'A user-owned plugin directory was removed'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $migrationPlugins 'templater-obsidian\manifest.json') -PathType Leaf) `
        -Message 'Templater plugin directory was removed'

    Complete-OkfDashboardPluginMigration -Vault $migrationVault | Out-Null
    $parsedEnabledAfterRetry = Get-Content -LiteralPath $communityPlugins -Raw | ConvertFrom-Json
    $enabledAfterRetry = @($parsedEnabledAfterRetry)
    Assert-Sequence -Actual $enabledAfterRetry -Expected $expectedEnabled `
        -Message 'Dashboard migration is not idempotent'
    Assert-Test -Condition (@(
            Get-ChildItem -LiteralPath (Join-Path $migrationVault '.obsidian') -Force |
                Where-Object { $_.Name -like '.community-plugins.json.*' }
        ).Count -eq 0) -Message 'Atomic JSON update left temporary files'

    # Configuration validation happens before deletion. A broken Obsidian file
    # leaves the old working plugin untouched for a safe retry.
    $invalidConfigVault = Join-Path $testRoot 'invalid-config-vault'
    $invalidConfigPlugins = Join-Path $invalidConfigVault '.obsidian\plugins'
    New-TestPlugin `
        -Root (Join-Path $invalidConfigPlugins 'okf-workspace-dashboard') `
        -Id 'okf-workspace-dashboard'
    New-TestPlugin `
        -Root (Join-Path $invalidConfigPlugins 'okf-brain-dashboard') `
        -Id 'okf-brain-dashboard'
    $invalidCommunityPlugins = Join-Path $invalidConfigVault '.obsidian\community-plugins.json'
    [System.IO.File]::WriteAllText($invalidCommunityPlugins, '{"not":"an array"}')
    $invalidConfigBefore = [System.IO.File]::ReadAllBytes($invalidCommunityPlugins)
    Assert-Throws `
        -Action { Complete-OkfDashboardPluginMigration -Vault $invalidConfigVault } `
        -MessagePattern 'must be a JSON array'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $invalidConfigPlugins 'okf-brain-dashboard') -PathType Container) `
        -Message 'Legacy Dashboard was removed after configuration validation failed'
    Assert-Test `
        -Condition ([System.Linq.Enumerable]::SequenceEqual(
            [byte[]]$invalidConfigBefore,
            [byte[]][System.IO.File]::ReadAllBytes($invalidCommunityPlugins)
        )) `
        -Message 'Invalid community plugin configuration was modified'

    # A directory with an unexpected manifest is never treated as the known
    # retired Dashboard solely because of its folder name.
    $unexpectedManifestVault = Join-Path $testRoot 'unexpected-manifest-vault'
    $unexpectedManifestPlugins = Join-Path $unexpectedManifestVault '.obsidian\plugins'
    New-TestPlugin `
        -Root (Join-Path $unexpectedManifestPlugins 'okf-workspace-dashboard') `
        -Id 'okf-workspace-dashboard'
    New-TestPlugin `
        -Root (Join-Path $unexpectedManifestPlugins 'okf-brain-dashboard') `
        -Id 'user-plugin'
    $unexpectedCommunityPlugins = Join-Path $unexpectedManifestVault '.obsidian\community-plugins.json'
    Write-OkfJson -Path $unexpectedCommunityPlugins -Value @('user-alpha', 'okf-brain-dashboard')
    $unexpectedConfigBefore = [System.IO.File]::ReadAllBytes($unexpectedCommunityPlugins)
    Assert-Throws `
        -Action { Complete-OkfDashboardPluginMigration -Vault $unexpectedManifestVault } `
        -MessagePattern 'Refusing to remove legacy Dashboard directory'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $unexpectedManifestPlugins 'okf-brain-dashboard') -PathType Container) `
        -Message 'Unexpected plugin directory was removed'
    Assert-Test `
        -Condition ([System.Linq.Enumerable]::SequenceEqual(
            [byte[]]$unexpectedConfigBefore,
            [byte[]][System.IO.File]::ReadAllBytes($unexpectedCommunityPlugins)
        )) `
        -Message 'Enabled plugin ids changed before legacy directory validation completed'

    # Generic retired-plugin cleanup owns only an exact directory with an
    # explicitly allowed manifest identity.
    $retiredVault = Join-Path $testRoot 'retired-plugin-vault'
    $retiredPlugins = Join-Path $retiredVault '.obsidian\plugins'
    New-TestPlugin -Root (Join-Path $retiredPlugins 'realclaudian') -Id 'realclaudian'
    New-TestPlugin -Root (Join-Path $retiredPlugins 'claudian') -Id 'okf-claudian'
    $removed = Remove-OkfRetiredPluginDirectory `
        -Vault $retiredVault `
        -DirectoryName 'claudian' `
        -AllowedManifestIds @('okf-claudian')
    Assert-Test -Condition $removed -Message 'Known retired Claudian directory was not removed'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $retiredPlugins 'realclaudian') -PathType Container) `
        -Message 'Official realclaudian directory was removed'

    New-TestPlugin -Root (Join-Path $retiredPlugins 'claudian') -Id 'claudian'
    Assert-Throws `
        -Action {
            Remove-OkfRetiredPluginDirectory `
                -Vault $retiredVault `
                -DirectoryName 'claudian' `
                -AllowedManifestIds @('okf-claudian')
        } `
        -MessagePattern 'Refusing to remove retired plugin directory'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $retiredPlugins 'claudian') -PathType Container) `
        -Message 'Upstream Claudian identity was removed as a retired OKF copy'

    Remove-Item -LiteralPath (Join-Path $retiredPlugins 'claudian') -Recurse -Force
    New-Item -ItemType Directory -Path (Join-Path $retiredPlugins 'claudian') | Out-Null
    Set-Content `
        -LiteralPath (Join-Path $retiredPlugins 'claudian\keep.txt') `
        -Value 'unowned' `
        -NoNewline
    Assert-Throws `
        -Action {
            Remove-OkfRetiredPluginDirectory `
                -Vault $retiredVault `
                -DirectoryName 'claudian' `
                -AllowedManifestIds @('okf-claudian')
        } `
        -MessagePattern 'without a manifest'
    Assert-Test `
        -Condition (Test-Path -LiteralPath (Join-Path $retiredPlugins 'claudian\keep.txt') -PathType Leaf) `
        -Message 'Manifestless Claudian directory was removed'

    Write-Host 'Dashboard plugin migration tests passed.'
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = $temporaryRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing test cleanup outside the temporary directory: $resolvedTestRoot"
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
