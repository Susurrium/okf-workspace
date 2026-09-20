[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $root 'deploy\windows\common.ps1')
$deployment = Read-OkfConfig $Config
$files = [ordered]@{}
foreach ($component in @('dashboard', 'claudian')) {
    $pluginId = if ($component -eq 'dashboard') { 'okf-workspace-dashboard' } else { 'okf-claudian' }
    foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
        $source = if ($component -eq 'dashboard' -and $name -eq 'main.js') {
            Join-Path $root 'dashboard\dist\main.js'
        } else {
            Join-Path $root "$component\$name"
        }
        $installed = Join-Path ([string]$deployment.vault) ".obsidian\plugins\$pluginId\$name"
        $expected = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        $actual = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
        if ($actual -ne $expected) { throw "Installed artifact differs from build: $pluginId/$name" }
        $files["$pluginId/$name"] = $actual.ToLowerInvariant()
    }
}
$engineFiles = [ordered]@{}
$engineSource = Join-Path $root 'engine\src'
foreach ($file in (Get-ChildItem -LiteralPath $engineSource -Recurse -File -Filter '*.py' | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($engineSource, $file.FullName).Replace('\', '/')
    $engineFiles[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$revision = (& git -C $root rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read repository revision' }
$changed = @(& git -C $root status --porcelain --untracked-files=no)
$receipt = [ordered]@{
    schema = 1
    deployed_at = [DateTimeOffset]::Now.ToString('o')
    repository_revision = $revision
    tracked_worktree_dirty = ($changed.Count -gt 0)
    engine_runtime = 'editable-source; hashes identify the code at deployment time'
    release_manifest_sha256 = (Get-FileHash -LiteralPath (Join-Path $root 'release-manifest.yaml')).Hash.ToLowerInvariant()
    installed_plugin_sha256 = $files
    engine_source_sha256 = $engineFiles
}
$receiptPath = Join-Path ([string]$deployment.state) 'reports\deployment-receipt.json'
Write-OkfJson -Path $receiptPath -Value $receipt
Write-Host "Verified deployment receipt: $receiptPath"
