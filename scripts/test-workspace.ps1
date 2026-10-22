[CmdletBinding()]
param(
    [ValidateSet('Status', 'Start', 'Stop')][string]$Action = 'Status',
    [string]$Config = 'E:\ObsidianData\OKF-Test-State\config\deployment.json',
    [switch]$EnableSync,
    [string]$ObsidianCommand = ''
)

. (Join-Path $PSScriptRoot '..\deploy\windows\common.ps1')
$deployment = Assert-OkfTestEnvironment -Config $Config
$marker = Read-OkfJsonHashtable -Path (Join-Path (Split-Path -Parent $Config) 'test-environment.json')
if ($EnableSync -and $Action -ne 'Start') { throw 'EnableSync is only valid with Start.' }
$vault = Resolve-OkfPath $deployment['vault']
$state = Resolve-OkfPath $deployment['state']
$profile = Join-Path $state 'obsidian-profile'
$registryPath = Join-Path $profile 'obsidian.json'
$cdpPort = if ($marker.ContainsKey('cdp_port')) { [int]$marker['cdp_port'] } else { 9366 }
if ($cdpPort -notin 1024..65535 -or $cdpPort -in 8765, ([int]$deployment['api_port'])) {
    throw 'Invalid test CDP port.'
}
$settingsPath = Join-Path $vault '.obsidian\plugins\okf-workspace-dashboard\data.json'
$settings = Read-OkfJsonHashtable -Path $settingsPath
if (-not (Test-OkfSamePath -Left ([string]$settings['deploymentConfig']) -Right $Config) -or
    -not (Test-OkfSamePath -Left ([string]$settings['tokenFile']) -Right (Join-Path $state 'secrets\local-api-token')) -or
    $settings['baseUrl'] -ne "http://127.0.0.1:$($deployment['api_port'])") {
    throw 'Test Dashboard settings do not match the test deployment.'
}
$registry = @{vaults = @{}}
if (Test-Path -LiteralPath $registryPath) {
    $registry = Read-OkfJsonHashtable -Path $registryPath
    foreach ($entry in $registry['vaults'].Values) {
        if (-not (Test-OkfSamePath -Left $entry['path'] -Right $vault)) {
            throw 'Test Obsidian profile contains another Vault; refusing to launch or modify it.'
        }
    }
}
$defaultRegistry = Join-Path $env:APPDATA 'obsidian\obsidian.json'
if (Test-Path -LiteralPath $defaultRegistry) {
    $default = Read-OkfJsonHashtable -Path $defaultRegistry
    foreach ($entry in $default['vaults'].Values) {
        if ((Test-OkfSamePath -Left $entry['path'] -Right $vault) -and $entry.ContainsKey('open') -and $entry['open']) {
            throw 'Test Vault is open in the default profile; close its window first.'
        }
    }
}
$profilePattern = '--user-data-dir="?' + [regex]::Escape($profile) + '(?:"|\s|$)'
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Obsidian.exe'" | Where-Object {
    $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match $profilePattern
})
if ($processes.Count -gt 1) { throw 'More than one process owns the test profile.' }
$isOpen = $processes.Count -eq 1
$listening = @(Get-NetTCPConnection -LocalPort $cdpPort -State Listen -ErrorAction SilentlyContinue)
if ($listening.Count -and (-not $isOpen -or $listening[0].OwningProcess -ne $processes[0].ProcessId)) {
    throw 'Test CDP port belongs to another process.'
}
$pluginsPath = Join-Path $vault '.obsidian\community-plugins.json'
$plugins = @(Get-Content -LiteralPath $pluginsPath -Raw | ConvertFrom-Json)
if ($Action -eq 'Status') {
    [pscustomobject]@{
        environment = 'test'; vault = $vault; state = $state; api_port = $deployment['api_port']
        profile = $profile; cdp_port = $cdpPort
        engine_autostart = [bool]$settings['manageLocalService']
        livesync_enabled = $plugins -contains 'obsidian-livesync'; vault_open = $isOpen
        api_listening = [bool](Get-NetTCPConnection -LocalPort $deployment['api_port'] -State Listen -ErrorAction SilentlyContinue)
    } | ConvertTo-Json
    return
}
if ($Action -eq 'Start' -or $isOpen) {
    $node = Assert-OkfCommand 'node'
    $cdp = Join-Path $PSScriptRoot 'test-workspace-cdp.mjs'
}
if ($Action -eq 'Start' -and -not $isOpen) {
    $cli = if ($ObsidianCommand) { Resolve-OkfPath $ObsidianCommand } else { Assert-OkfCommand 'obsidian' }
    $launcher = [IO.Path]::ChangeExtension($cli, '.exe')
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Obsidian executable not found: $launcher" }
}
$settings['manageLocalService'] = $Action -eq 'Start'
$plugins = @($plugins | Where-Object { $_ -ne 'obsidian-livesync' })
if ($plugins -notcontains 'okf-workspace-dashboard') { $plugins += 'okf-workspace-dashboard' }
if ($Action -eq 'Start' -and $EnableSync) { $plugins += 'obsidian-livesync' }
Write-OkfJson -Path $settingsPath -Value $settings
Write-OkfJson -Path $pluginsPath -Value $plugins
if ($Action -eq 'Start') {
    if (-not $isOpen) {
        $registry['vaults'] = @{
            ([string]$deployment['installation_id']) = @{path = $vault; open = $true; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
        }
        Write-OkfJson -Path $registryPath -Value $registry
        Start-Process -FilePath $launcher -ArgumentList @("--user-data-dir=`"$profile`"", "--remote-debugging-port=$cdpPort") -WindowStyle Hidden
    }
    $code = '(async()=>{if(!app.workspace.layoutReady)return false;await app.plugins.setEnable(true);if(app.plugins.enabledPlugins.has("obsidian-livesync"))await app.plugins.disablePluginAndSave("obsidian-livesync");await app.plugins.unloadPlugin("okf-workspace-dashboard");await app.plugins.loadPlugin("okf-workspace-dashboard");'
    if ($EnableSync) { $code += 'await app.plugins.enablePluginAndSave("obsidian-livesync");' }
    $code += 'return !!app.plugins.plugins["okf-workspace-dashboard"];})()'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $result = & $node $cdp $Config eval $code 2>&1 | Out-String
        if ($result.Contains('VAULT_MISMATCH')) { throw $result }
        if ($LASTEXITCODE -eq 0 -and $result.Trim() -eq 'true') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "Test Obsidian startup failed: $result" }
    $token = [IO.File]::ReadAllText((Join-Path $state 'secrets\local-api-token')).Trim()
    $normalized = $vault.Replace('\', '/').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $expected = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $healthy = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        try {
            $identity = Invoke-RestMethod -Uri ($settings['baseUrl'] + '/workspace/identity') -Headers @{Authorization = 'Bearer ' + $token} -TimeoutSec 2
            if ($identity.vault_fingerprint -ne $expected) { throw 'VAULT_MISMATCH: Engine identity differs from the test Vault.' }
            $healthy = $true
            break
        } catch {
            if ($_.Exception.Message.Contains('VAULT_MISMATCH')) { throw }
            if ($attempt -eq 24) { throw "Test Engine startup failed: $($_.Exception.Message)" }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Test Engine is not ready.' }
    Write-Host "Test Vault started on port $($deployment['api_port']) with isolated profile $profile; LiveSync enabled: $([bool]$EnableSync)."
} else {
    if ($isOpen) {
        $code = '(async()=>{if(app.plugins.enabledPlugins.has("obsidian-livesync"))await app.plugins.disablePluginAndSave("obsidian-livesync");await app.plugins.unloadPlugin("okf-workspace-dashboard");setTimeout(()=>window.close(),250);return true;})()'
        & $node $cdp $Config eval $code
        if ($LASTEXITCODE -ne 0) { throw 'Closing the test window failed.' }
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $alive = @($processes | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
        $api = @(Get-NetTCPConnection -LocalPort $deployment['api_port'] -State Listen -ErrorAction SilentlyContinue)
        if (-not $alive.Count -and -not $api.Count) { break }
        if ($attempt -eq 29) { throw 'Test API or Obsidian process is still running.' }
        Start-Sleep -Milliseconds 300
    }
    if (Test-Path -LiteralPath $registryPath) {
        $stoppedRegistry = Read-OkfJsonHashtable -Path $registryPath
        foreach ($entry in $stoppedRegistry['vaults'].Values) {
            if (-not (Test-OkfSamePath -Left $entry['path'] -Right $vault)) {
                throw 'Test profile changed during shutdown; refusing to update its registry.'
            }
            $entry['open'] = $false
        }
        Write-OkfJson -Path $registryPath -Value $stoppedRegistry
    }
    # 插件退出时可能保存内存中的旧设置；进程退出后读取最新值并持久化停机状态。
    $stoppedSettings = Read-OkfJsonHashtable -Path $settingsPath
    if (-not (Test-OkfSamePath -Left ([string]$stoppedSettings['deploymentConfig']) -Right $Config) -or
        -not (Test-OkfSamePath -Left ([string]$stoppedSettings['tokenFile']) -Right (Join-Path $state 'secrets\local-api-token')) -or
        $stoppedSettings['baseUrl'] -ne "http://127.0.0.1:$($deployment['api_port'])") {
        throw 'Test Dashboard identity changed during shutdown; refusing to update its settings.'
    }
    $stoppedPlugins = @(Get-Content -LiteralPath $pluginsPath -Raw | ConvertFrom-Json)
    $stoppedSettings['manageLocalService'] = $false
    Write-OkfJson -Path $settingsPath -Value $stoppedSettings
    Write-OkfJson -Path $pluginsPath -Value @($stoppedPlugins | Where-Object { $_ -ne 'obsidian-livesync' })
    Write-Host 'Test Vault stopped; Engine autostart and LiveSync are disabled.'
}
