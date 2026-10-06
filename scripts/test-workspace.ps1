[CmdletBinding()]
param(
    [ValidateSet('Status', 'Start', 'Stop')][string]$Action = 'Status',
    [string]$Config = 'E:\ObsidianData\OKF-Test-State\config\deployment.json',
    [switch]$EnableSync,
    [string]$ObsidianCommand = ''
)

. (Join-Path $PSScriptRoot '..\deploy\windows\common.ps1')
$deployment = Read-OkfConfig $Config
$marker = Read-OkfConfig (Join-Path (Split-Path -Parent $Config) 'test-environment.json')
if ([string]$marker.environment -ne 'test' -or
    [string]$marker.installation_id -ne [string]$deployment.installation_id -or
    -not (Test-OkfSamePath -Left ([string]$marker.vault) -Right ([string]$deployment.vault)) -or
    -not (Test-OkfSamePath -Left ([string]$marker.state) -Right ([string]$deployment.state)) -or
    [int]$marker.api_port -ne [int]$deployment.api_port -or
    [int]$deployment.api_port -eq 8765) {
    throw 'Refusing to control an environment without a matching isolated test marker.'
}
if ($EnableSync -and $Action -ne 'Start') { throw 'EnableSync is only valid with Start.' }
$vault = Resolve-OkfPath ([string]$deployment.vault)
$state = Resolve-OkfPath ([string]$deployment.state)
$settingsPath = Join-Path $vault '.obsidian\plugins\okf-workspace-dashboard\data.json'
$settings = Read-OkfJsonHashtable -Path $settingsPath
if (-not (Test-OkfSamePath -Left ([string]$settings.deploymentConfig) -Right $Config) -or
    -not (Test-OkfSamePath -Left ([string]$settings.tokenFile) -Right (Join-Path $state 'secrets\local-api-token')) -or
    [string]$settings.baseUrl -ne "http://127.0.0.1:$($deployment.api_port)") {
    throw 'Test Dashboard settings do not match the test deployment.'
}
$pluginsPath = Join-Path $vault '.obsidian\community-plugins.json'
$plugins = @(Get-Content -LiteralPath $pluginsPath -Raw | ConvertFrom-Json)
$registryPath = Join-Path $env:APPDATA 'obsidian\obsidian.json'
$isOpen = $false
if (Test-Path -LiteralPath $registryPath -PathType Leaf) {
    $registry = Read-OkfJsonHashtable -Path $registryPath
    $isOpen = @($registry.vaults.Values | Where-Object {
        (Test-OkfSamePath -Left ([string]$_.path) -Right $vault) -and $_.ContainsKey('open') -and $_.open
    }).Count -gt 0
}
if ($Action -eq 'Status') {
    [pscustomobject]@{
        environment = 'test'; vault = $vault; state = $state; api_port = $deployment.api_port
        engine_autostart = [bool]$settings.manageLocalService
        livesync_enabled = $plugins -contains 'obsidian-livesync'; vault_open = $isOpen
        api_listening = [bool](Get-NetTCPConnection -LocalPort $deployment.api_port -State Listen -ErrorAction SilentlyContinue)
    } | ConvertTo-Json
    return
}

# Resolve the application before persisting a start request or stopping an open Vault.
if ($Action -eq 'Start' -or $isOpen) {
    $cli = if ($ObsidianCommand) { Resolve-OkfPath $ObsidianCommand } else { Assert-OkfCommand 'obsidian' }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "Obsidian CLI not found: $cli" }
}
$settings['manageLocalService'] = $Action -eq 'Start'
$plugins = @($plugins | Where-Object { $_ -ne 'obsidian-livesync' })
if ($plugins -notcontains 'okf-workspace-dashboard') { $plugins += 'okf-workspace-dashboard' }
if ($Action -eq 'Start' -and $EnableSync) { $plugins += 'obsidian-livesync' }
Write-OkfJson -Path $settingsPath -Value $settings
Write-OkfJson -Path $pluginsPath -Value $plugins
$vaultArgument = 'vault=' + (Split-Path -Leaf $vault)
$expectedVault = $vault.Replace('\', '/') | ConvertTo-Json -Compress
if ($Action -eq 'Start') {
    $launcher = [IO.Path]::ChangeExtension($cli, '.exe')
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { $launcher = $cli }
    Start-Process -FilePath $launcher -ArgumentList ('obsidian://open?vault=' + [Uri]::EscapeDataString((Split-Path -Leaf $vault)) + '&file=dashboard.md')
    $code = '(async()=>{if(!app.workspace.layoutReady||!app.appId||app.vault.adapter.basePath.split(String.fromCharCode(92)).join("/")!==' + $expectedVault + '||!app.plugins.manifests["okf-workspace-dashboard"])return "PENDING";await app.plugins.setEnable(true);if(app.plugins.enabledPlugins.has("obsidian-livesync"))await app.plugins.disablePluginAndSave("obsidian-livesync");await app.plugins.unloadPlugin("okf-workspace-dashboard");await app.plugins.loadPlugin("okf-workspace-dashboard");'
    if ($EnableSync) { $code += 'await app.plugins.enablePluginAndSave("obsidian-livesync");' }
    $code += 'return app.plugins.plugins["okf-workspace-dashboard"]?"TEST_WORKSPACE_READY":"PENDING";})()'
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $result = & $cli eval $vaultArgument ('code=' + $code) 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $result.Contains('TEST_WORKSPACE_READY')) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Test Vault did not open; its start settings are saved, but application startup is unconfirmed.' }
    $token = [IO.File]::ReadAllText((Join-Path $state 'secrets\local-api-token')).Trim()
    $healthy = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        try {
            $identity = Invoke-RestMethod -Uri ($settings.baseUrl + '/workspace/identity') -Headers @{Authorization = 'Bearer ' + $token} -TimeoutSec 2
            if ($identity.vault_fingerprint) { $healthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Test window opened, but its authenticated Engine did not become ready; check test State logs.' }
    Write-Host "Test Vault started on port $($deployment.api_port); LiveSync enabled: $([bool]$EnableSync)."
} elseif ($isOpen) {
    $code = '(async()=>{if(app.vault.adapter.basePath.split(String.fromCharCode(92)).join("/")!==' + $expectedVault + ')return "NOT_TEST_TARGET";if(app.plugins.enabledPlugins.has("obsidian-livesync"))await app.plugins.disablePluginAndSave("obsidian-livesync");await app.plugins.unloadPlugin("okf-workspace-dashboard");setTimeout(()=>require("electron").remote.getCurrentWindow().close(),100);return "TEST_WORKSPACE_STOPPED";})()'
    $result = & $cli eval $vaultArgument ('code=' + $code) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $result.Contains('TEST_WORKSPACE_STOPPED')) { throw 'Test stop settings are saved, but closing its application window failed.' }
    $stopped = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $listening = Get-NetTCPConnection -LocalPort $deployment.api_port -State Listen -ErrorAction SilentlyContinue
        $currentRegistry = Read-OkfJsonHashtable -Path $registryPath
        $stillOpen = @($currentRegistry.vaults.Values | Where-Object {
            (Test-OkfSamePath -Left ([string]$_.path) -Right $vault) -and $_.ContainsKey('open') -and $_.open
        }).Count -gt 0
        if (-not $listening -and -not $stillOpen) { $stopped = $true; break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $stopped) { throw 'Test stop was requested, but its API or application window is still open.' }
    Write-Host 'Test Vault stopped; Engine autostart and LiveSync are disabled.'
} else {
    Write-Host 'Test Vault is closed; Engine autostart and LiveSync are disabled.'
}
