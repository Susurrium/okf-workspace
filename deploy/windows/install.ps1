[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$DataRoot = 'E:\ObsidianData',
    [string]$Vault = '',
    [string]$Originals = '',
    [string]$State = '',
    [int]$ApiPort = 8765,
    [string]$MinerUUrl = 'http://127.0.0.1:18000',
    [bool]$MinerUSshManaged = $true,
    [string]$MinerUSshHost = 'bjmu-inner',
    [int]$MinerUSshRemotePort = 8000,
    [string]$MarkItDownUrl = 'http://127.0.0.1:18010',
    [string]$MarkItDownTokenFile = '',
    [ValidateSet('codex', 'provider')][string]$AIMode = 'codex',
    [string]$CodexCommand = '',
    [string]$CodexModel = '',
    [int]$SemanticTimeoutSeconds = 600,
    [int]$SemanticRetrievalTimeoutSeconds = 12,
    [string]$AIBaseUrl = '',
    [string]$AIModel = '',
    [string]$AIApiKeyFile = '',
    [string]$BackupRepository = 'E:\backups\OKF-Brain-Restic',
    [string]$ResticPasswordFile = '',
    [string]$LiveSyncPluginSource = '',
    [string]$ClaudianRepository = '',
    [bool]$LiveSyncRequired = $false,
    [switch]$SkipVectorIndex,
    [switch]$SkipScheduledTasks,
    [switch]$EnableBackupSetup,
    [switch]$SkipAcceptance
)

. (Join-Path $PSScriptRoot 'common.ps1')

$repo = Resolve-OkfPath $RepositoryRoot
$claudianRepo = Resolve-OkfPath $(if ($ClaudianRepository) {
    $ClaudianRepository
} else {
    Join-Path $repo 'claudian'
})
$data = Resolve-OkfPath $DataRoot
$vaultPath = Resolve-OkfPath $(if ($Vault) { $Vault } else { Join-Path $data 'OKF-Brain' })
$originalsPath = Resolve-OkfPath $(if ($Originals) { $Originals } else { Join-Path $data 'OKF-Brain-Originals' })
$statePath = Resolve-OkfPath $(if ($State) { $State } else { Join-Path $data 'OKF-Brain-State' })
$dataLayout = Assert-OkfDataPathLayout `
    -Vault $vaultPath `
    -Originals $originalsPath `
    -State $statePath `
    -RepositoryRoot $repo
$vaultPath = $dataLayout.vault
$originalsPath = $dataLayout.originals
$statePath = $dataLayout.state
$configPath = Join-Path $statePath 'config\deployment.json'

$existingConfig = $null
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existingConfig = Read-OkfConfig $configPath
    if (-not $PSBoundParameters.ContainsKey('ApiPort') -and $existingConfig.PSObject.Properties.Name -contains 'api_port') {
        $ApiPort = [int]$existingConfig.api_port
    }
    if (-not $PSBoundParameters.ContainsKey('MinerUUrl') -and $existingConfig.PSObject.Properties.Name -contains 'mineru_url') {
        $MinerUUrl = [string]$existingConfig.mineru_url
    }
    if (-not $PSBoundParameters.ContainsKey('MinerUSshManaged') -and $existingConfig.PSObject.Properties.Name -contains 'mineru_ssh_managed') {
        $MinerUSshManaged = [bool]$existingConfig.mineru_ssh_managed
    }
    if (-not $PSBoundParameters.ContainsKey('MinerUSshHost') -and $existingConfig.PSObject.Properties.Name -contains 'mineru_ssh_host') {
        $MinerUSshHost = [string]$existingConfig.mineru_ssh_host
    }
    if (-not $PSBoundParameters.ContainsKey('MinerUSshRemotePort') -and $existingConfig.PSObject.Properties.Name -contains 'mineru_ssh_remote_port') {
        $MinerUSshRemotePort = [int]$existingConfig.mineru_ssh_remote_port
    }
    if (-not $PSBoundParameters.ContainsKey('MarkItDownUrl') -and $existingConfig.PSObject.Properties.Name -contains 'markitdown_url') {
        $MarkItDownUrl = [string]$existingConfig.markitdown_url
    }
    if (-not $PSBoundParameters.ContainsKey('MarkItDownTokenFile') -and $existingConfig.PSObject.Properties.Name -contains 'markitdown_token_file') {
        $MarkItDownTokenFile = [string]$existingConfig.markitdown_token_file
    }
    if (-not $PSBoundParameters.ContainsKey('BackupRepository') -and
        $existingConfig.PSObject.Properties.Name -contains 'backup_repository' -and
        [bool][string]$existingConfig.backup_repository) {
        $BackupRepository = [string]$existingConfig.backup_repository
    }
    if (-not $PSBoundParameters.ContainsKey('ResticPasswordFile') -and $existingConfig.PSObject.Properties.Name -contains 'restic_password_file') {
        $ResticPasswordFile = [string]$existingConfig.restic_password_file
    }
    if (-not $PSBoundParameters.ContainsKey('AIBaseUrl') -and $existingConfig.PSObject.Properties.Name -contains 'ai_base_url') {
        $AIBaseUrl = [string]$existingConfig.ai_base_url
    }
    if (-not $PSBoundParameters.ContainsKey('AIModel') -and $existingConfig.PSObject.Properties.Name -contains 'ai_model') {
        $AIModel = [string]$existingConfig.ai_model
    }
    if (-not $PSBoundParameters.ContainsKey('AIApiKeyFile') -and $existingConfig.PSObject.Properties.Name -contains 'ai_api_key_file') {
        $AIApiKeyFile = [string]$existingConfig.ai_api_key_file
    }
    if (-not $PSBoundParameters.ContainsKey('AIMode') -and $existingConfig.PSObject.Properties.Name -contains 'ai_mode') {
        $AIMode = [string]$existingConfig.ai_mode
    }
    if (-not $PSBoundParameters.ContainsKey('CodexCommand') -and $existingConfig.PSObject.Properties.Name -contains 'codex_command') {
        $CodexCommand = [string]$existingConfig.codex_command
    }
    if (-not $PSBoundParameters.ContainsKey('CodexModel') -and $existingConfig.PSObject.Properties.Name -contains 'codex_model') {
        $CodexModel = [string]$existingConfig.codex_model
    }
    if (-not $PSBoundParameters.ContainsKey('SemanticTimeoutSeconds') -and $existingConfig.PSObject.Properties.Name -contains 'semantic_timeout_seconds') {
        $SemanticTimeoutSeconds = [int]$existingConfig.semantic_timeout_seconds
    }
    if (-not $PSBoundParameters.ContainsKey('SemanticRetrievalTimeoutSeconds') -and $existingConfig.PSObject.Properties.Name -contains 'semantic_retrieval_timeout_seconds') {
        $SemanticRetrievalTimeoutSeconds = [int]$existingConfig.semantic_retrieval_timeout_seconds
    }
    if (-not $PSBoundParameters.ContainsKey('LiveSyncRequired') -and $existingConfig.PSObject.Properties.Name -contains 'livesync_required') {
        $LiveSyncRequired = [bool]$existingConfig.livesync_required
    }
    if (-not $PSBoundParameters.ContainsKey('SkipVectorIndex') -and $existingConfig.PSObject.Properties.Name -contains 'enable_vectors') {
        $SkipVectorIndex = -not [bool]$existingConfig.enable_vectors
    }
    if (-not $PSBoundParameters.ContainsKey('EnableBackupSetup') -and
        $existingConfig.PSObject.Properties.Name -contains 'backup_repository' -and
        [bool][string]$existingConfig.backup_repository) {
        $EnableBackupSetup = $true
    }
}
$existingInstallationId = ''
if ($null -ne $existingConfig -and
    $existingConfig.PSObject.Properties.Name -contains 'installation_id') {
    $existingInstallationId = [string]$existingConfig.installation_id
}
$discoveredInstallationIds = @()
foreach ($ownedPath in @(
    @{ role = 'vault'; path = $vaultPath },
    @{ role = 'originals'; path = $originalsPath },
    @{ role = 'state'; path = $statePath }
)) {
    $ownedRole = [string]$ownedPath.role
    $ownedTarget = [string]$ownedPath.path
    $markerPath = Get-OkfOwnershipMarkerPath $ownedTarget
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { continue }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ([string]$marker.product -ne 'okf-workspace' -or
        [string]$marker.role -ne $ownedRole -or
        -not (Test-OkfSamePath -Left ([string]$marker.path) -Right $ownedTarget)) {
        throw "Existing ownership marker is invalid for $($ownedPath.role): $markerPath"
    }
    $markerInstallationId = [string]$marker.installation_id
    if (-not $markerInstallationId) { throw "Ownership marker has no installation id: $markerPath" }
    $discoveredInstallationIds += $markerInstallationId
}
$uniqueInstallationIds = @($discoveredInstallationIds | Select-Object -Unique)
if ($uniqueInstallationIds.Count -gt 1) {
    throw 'Vault, Originals and State ownership markers belong to different installations.'
}
if ($existingInstallationId -and $uniqueInstallationIds.Count -eq 1 -and
    $existingInstallationId -ne $uniqueInstallationIds[0]) {
    throw 'Deployment config and data ownership markers belong to different installations.'
}
$installationId = if ($existingInstallationId) {
    $existingInstallationId
} elseif ($uniqueInstallationIds.Count -eq 1) {
    $uniqueInstallationIds[0]
} else {
    [guid]::NewGuid().ToString('D')
}
$passwordPath = Resolve-OkfPath $(if ($ResticPasswordFile) { $ResticPasswordFile } else { Join-Path $statePath 'secrets\restic-password' })

if ($AIMode -eq 'provider' -and (-not $AIBaseUrl -or -not $AIModel)) {
    throw 'AIBaseUrl and AIModel are required when AIMode is provider.'
}
if ($AIMode -eq 'codex' -and -not $CodexCommand) {
    $CodexCommand = Assert-OkfCommand 'codex.cmd'
}
if ($AIMode -eq 'codex' -and -not (Test-Path -LiteralPath $CodexCommand -PathType Leaf)) {
    throw "Codex command not found: $CodexCommand"
}
if ($AIMode -eq 'provider' -and ([bool]$AIBaseUrl -xor [bool]$AIModel)) {
    throw 'AIBaseUrl and AIModel must be configured together.'
}
if ($AIApiKeyFile -and -not (Test-Path -LiteralPath $AIApiKeyFile -PathType Leaf)) {
    throw "AI API key file not found: $AIApiKeyFile"
}

foreach ($name in @('uv', 'node', 'npm', 'git', 'obsidian')) { Assert-OkfCommand $name | Out-Null }
if ($EnableBackupSetup) { Assert-OkfCommand 'restic' | Out-Null }
& uv python find 3.12 | Out-Null

New-Item -ItemType Directory -Force -Path $vaultPath, $originalsPath, $statePath | Out-Null
Write-OkfOwnershipMarker -Target $vaultPath -Role vault -InstallationId $installationId
Write-OkfOwnershipMarker -Target $originalsPath -Role originals -InstallationId $installationId
Write-OkfOwnershipMarker -Target $statePath -Role state -InstallationId $installationId

Push-Location (Join-Path $repo 'engine')
try {
    & uv sync --frozen --extra dev --extra vector
    if ($LASTEXITCODE -ne 0) { throw 'Engine dependency installation failed' }
} finally {
    Pop-Location
}

Push-Location (Join-Path $repo 'dashboard')
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard dependency installation failed' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed' }
} finally {
    Pop-Location
}

$python = Join-Path $repo 'engine\.venv\Scripts\python.exe'
$okf = Join-Path $repo 'engine\.venv\Scripts\okf.exe'
if (-not (Test-Path -LiteralPath (Join-Path $vaultPath 'index.md'))) {
    & $okf init --vault $vaultPath
    if ($LASTEXITCODE -ne 0) { throw 'Vault initialization failed' }
}
& $okf migrate --vault $vaultPath --state $statePath
if ($LASTEXITCODE -ne 0) { throw 'Vault layout migration failed' }

& (Join-Path $repo 'scripts\install-skills.ps1') -Vault $vaultPath
if ($LASTEXITCODE -ne 0) { throw 'Codex Skill installation failed' }

$tokenFile = Join-Path $statePath 'secrets\local-api-token'
$serviceLogs = Join-Path $statePath 'logs'
& $python -c 'import sys; from pathlib import Path; from okf_workspace.api import LocalTokenStore; LocalTokenStore(Path(sys.argv[1])).ensure()' $statePath
if ($LASTEXITCODE -ne 0) { throw 'Local token creation failed' }

if ($EnableBackupSetup -and -not (Test-Path -LiteralPath $passwordPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $passwordPath) | Out-Null
    $bytes = [byte[]]::new(48)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $passwordPath -Encoding ascii -NoNewline
}

$config = [ordered]@{
    installation_id = $installationId
    repository_root = $repo
    vault = $vaultPath
    originals = $originalsPath
    state = $statePath
    api_port = $ApiPort
    mineru_url = $MinerUUrl
    mineru_ssh_managed = $MinerUSshManaged
    mineru_ssh_host = $MinerUSshHost
    mineru_ssh_remote_port = $MinerUSshRemotePort
    markitdown_url = $MarkItDownUrl
    markitdown_token_file = $(if ($MarkItDownTokenFile) { Resolve-OkfPath $MarkItDownTokenFile } else { '' })
    ai_mode = $AIMode
    codex_command = $(if ($CodexCommand) { Resolve-OkfPath $CodexCommand } else { '' })
    codex_model = $CodexModel.Trim()
    ai_base_url = $AIBaseUrl.Trim()
    ai_model = $AIModel.Trim()
    ai_api_key_file = $(if ($AIApiKeyFile) { Resolve-OkfPath $AIApiKeyFile } else { '' })
    semantic_automation = $true
    semantic_timeout_seconds = $SemanticTimeoutSeconds
    semantic_retrieval_timeout_seconds = $SemanticRetrievalTimeoutSeconds
    enable_vectors = -not $SkipVectorIndex
    livesync_required = $LiveSyncRequired
    backup_repository = $(if ($EnableBackupSetup) { Resolve-OkfPath $BackupRepository } else { '' })
    restic_password_file = $(if ($EnableBackupSetup) { $passwordPath } else { '' })
    ownership_markers = [ordered]@{
        vault = $(Get-OkfOwnershipMarkerPath $vaultPath)
        originals = $(Get-OkfOwnershipMarkerPath $originalsPath)
        state = $(Get-OkfOwnershipMarkerPath $statePath)
    }
}
Write-OkfJson -Path $configPath -Value $config

$pluginTarget = Join-Path $vaultPath '.obsidian\plugins\okf-workspace-dashboard'
$legacyPluginTarget = Join-Path $vaultPath '.obsidian\plugins\okf-brain-dashboard'
$pluginDataPath = Join-Path $pluginTarget 'data.json'
$legacyPluginDataPath = Join-Path $legacyPluginTarget 'data.json'
$pluginData = @{}
if (Test-Path -LiteralPath $pluginDataPath -PathType Leaf) {
    $pluginData = Read-OkfJsonHashtable -Path $pluginDataPath -Description 'Dashboard settings'
} elseif (Test-Path -LiteralPath $legacyPluginDataPath -PathType Leaf) {
    $pluginData = Read-OkfJsonHashtable -Path $legacyPluginDataPath -Description 'Legacy Dashboard settings'
}

$obsidianAppConfig = Join-Path $vaultPath '.obsidian\app.json'
$obsidianAppSettings = @{}
if (Test-Path -LiteralPath $obsidianAppConfig -PathType Leaf) {
    $obsidianAppSettings = Read-OkfJsonHashtable -Path $obsidianAppConfig -Description 'Obsidian app settings'
}

$templaterManifest = Join-Path $vaultPath '.obsidian\plugins\templater-obsidian\manifest.json'
$templaterDataPath = Join-Path $vaultPath '.obsidian\plugins\templater-obsidian\data.json'
$templaterData = @{}
if ((Test-Path -LiteralPath $templaterManifest -PathType Leaf) -and
    (Test-Path -LiteralPath $templaterDataPath -PathType Leaf)) {
    $templaterData = Read-OkfJsonHashtable -Path $templaterDataPath -Description 'Templater settings'
}

# Read and validate every existing JSON input before replacing Dashboard artifacts.
& (Join-Path $repo 'scripts\install-okf-claudian.ps1') `
    -Vault $vaultPath `
    -ClaudianRepository $claudianRepo
if ($LASTEXITCODE -ne 0) { throw 'OKF Claudian installation failed' }
$dashboardMigration = Get-OkfDashboardPluginMigrationPlan -Vault $vaultPath
Install-OkfDashboardPluginAtomic `
    -DashboardRoot (Join-Path $repo 'dashboard') `
    -Target $pluginTarget | Out-Null
$pluginData['baseUrl'] = "http://127.0.0.1:$ApiPort"
$pluginData['tokenFile'] = $tokenFile
$pluginData['pythonExecutable'] = $python
$pluginData['deploymentConfig'] = $configPath
$pluginData['serviceLogDirectory'] = $serviceLogs
if (-not $pluginData.ContainsKey('manageLocalService')) { $pluginData['manageLocalService'] = $true }
$pluginData.Remove('token')
Write-OkfJson -Path $pluginDataPath -Value $pluginData

# Only after the replacement plugin and its settings are durable do we switch
# Obsidian's load order and retire the explicitly supported legacy plugin id.
$enabled = @(Complete-OkfDashboardPluginMigration `
    -Vault $vaultPath `
    -Preflight $dashboardMigration)

$obsidianAppSettings['alwaysUpdateLinks'] = $true
$obsidianAppSettings['showInlineTitle'] = $false
$obsidianAppSettings['propertiesInDocument'] = 'visible'
Write-OkfJson -Path $obsidianAppConfig -Value $obsidianAppSettings

$communityPlugins = Join-Path $vaultPath '.obsidian\community-plugins.json'

if (Test-Path -LiteralPath $templaterManifest -PathType Leaf) {
    $templaterData['templates_folder'] = 'system/templates/interactive'
    if (-not $templaterData.ContainsKey('command_timeout')) { $templaterData['command_timeout'] = 5 }
    if (-not $templaterData.ContainsKey('trigger_on_file_creation_mode')) {
        $templaterData['trigger_on_file_creation_mode'] = 'none'
    }
    Write-OkfJson -Path $templaterDataPath -Value $templaterData
}

Write-OkfJson -Path (Join-Path $vaultPath '.obsidian\okf-livesync-exclusions.json') -Value ([ordered]@{
    note = 'Copy these patterns into Self-hosted LiveSync sync exclusions.'
    patterns = @('^.git/', '^.trash/', '^sources/assets/treehole-media/', '^.obsidian/plugins/okf-workspace-dashboard/data.json$')
    outside_vault = @($originalsPath, $statePath)
})

if ($LiveSyncPluginSource) {
    $liveSyncSource = Resolve-OkfPath $LiveSyncPluginSource
    $liveSyncTarget = Join-Path $vaultPath '.obsidian\plugins\obsidian-livesync'
    Install-OkfPluginAtomic `
        -Source $liveSyncSource `
        -Target $liveSyncTarget `
        -ExpectedId 'obsidian-livesync' | Out-Null
    if ($enabled -notcontains 'obsidian-livesync') {
        $enabled += 'obsidian-livesync'
        Write-OkfJson -Path $communityPlugins -Value $enabled
    }
}

Set-OkfEnvironment ([pscustomobject]$config)
$indexArguments = @('index', 'rebuild', '--vault', $vaultPath, '--state', $statePath, '--force')
if (-not $SkipVectorIndex) { $indexArguments += '--vectors' }
& $okf @indexArguments
if ($LASTEXITCODE -ne 0) { throw 'Initial index build failed' }

if (-not $SkipAcceptance) {
    $acceptanceReport = Join-Path $statePath 'reports\install-acceptance.json'
    & $okf test all --quick-performance --report $acceptanceReport
    if ($LASTEXITCODE -ne 0) { throw 'OKF Brain acceptance suite failed' }
    & $okf validate --vault $vaultPath
    if ($LASTEXITCODE -ne 0) { throw 'Production Vault validation failed' }
    Write-Host "Acceptance: passed ($acceptanceReport)"
}

if (-not $SkipScheduledTasks) {
    $maintenanceShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $maintenanceShell -PathType Leaf)) {
        throw "Stable Windows PowerShell executable not found: $maintenanceShell"
    }
    $legacyServiceTask = Get-ScheduledTask -TaskName 'OKF Brain Local Service' -ErrorAction SilentlyContinue
    if ($legacyServiceTask) {
        Stop-ScheduledTask -TaskName 'OKF Brain Local Service' -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName 'OKF Brain Local Service' -Confirm:$false
    }

    $maintenanceAction = New-ScheduledTaskAction -Execute $maintenanceShell -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'maintenance.ps1')`" -Config `"$configPath`""
    $maintenanceTrigger = New-ScheduledTaskTrigger -Daily -At '02:30'
    Register-ScheduledTask -TaskName 'OKF Workspace Daily Maintenance' -Action $maintenanceAction -Trigger $maintenanceTrigger -Description 'Refresh indexes; run optional backup and restore checks when enabled.' -Force | Out-Null

    $feedSyncAction = New-ScheduledTaskAction -Execute $maintenanceShell -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'feed-sync.ps1')`" -Config `"$configPath`""
    $feedSyncTrigger = New-ScheduledTaskTrigger -Daily -At '06:50'
    $feedSyncSettings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName 'OKF Workspace Feed Sync' -Action $feedSyncAction -Trigger $feedSyncTrigger -Settings $feedSyncSettings -Description 'Incrementally synchronize all AI Daily editions after the remote publish window; retry after transient offline failures.' -Force | Out-Null
}

Write-Host 'OKF Workspace installation complete.'
Write-Host "Vault: $vaultPath"
Write-Host "Dashboard: $pluginTarget"
Write-Host "Local API: http://127.0.0.1:$ApiPort (started and stopped by the Obsidian plugin)"
Write-Host "Config: $configPath"
if ($EnableBackupSetup) { Write-Host "Backup repository: $($config.backup_repository)" }
