[CmdletBinding()]
param([Parameter(Mandatory)][string]$Config)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $root 'deploy\windows\common.ps1')
$deployment = Read-OkfConfig $Config
$packaged = Test-Path -LiteralPath (Join-Path $root 'runtime-manifest.json') -PathType Leaf
if ($packaged) {
    . (Join-Path $root 'deploy\windows\release.ps1')
    $release = Read-OkfRelease -Root $root
    Assert-OkfReleaseEngine -Root $root -Python (Get-OkfEnginePython $deployment)
}
$files = [ordered]@{}
foreach ($component in @('dashboard', 'claudian')) {
    $pluginId = if ($component -eq 'dashboard') { 'okf-workspace-dashboard' } else { 'okf-claudian' }
    foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
        $source = if ($component -eq 'dashboard' -and $name -ne 'manifest.json') {
            Join-Path $root "dashboard\dist\$name"
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
$engineSource = if ($packaged) { Join-Path $root 'engine\.venv\Lib\site-packages\okf_workspace' } else { Join-Path $root 'engine\src' }
foreach ($file in (Get-ChildItem -LiteralPath $engineSource -Recurse -File -Filter '*.py' | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($engineSource, $file.FullName).Replace('\', '/')
    $engineFiles[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($packaged) {
    $revision = [string]$release.source_revision
    $worktreeDirty = [bool]$release.source_worktree_dirty
} else {
    $revision = (& git -C $root rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read repository revision' }
    $worktreeDirty = @(& git -C $root status --porcelain --untracked-files=no).Count -gt 0
}
$receipt = [ordered]@{
    schema = 1
    deployed_at = [DateTimeOffset]::Now.ToString('o')
    repository_revision = $revision
    tracked_worktree_dirty = $worktreeDirty
    engine_runtime = 'editable-source; hashes identify the code at deployment time'
    release_manifest_sha256 = (Get-FileHash -LiteralPath (Join-Path $root 'release-manifest.yaml')).Hash.ToLowerInvariant()
    installed_plugin_sha256 = $files
    engine_source_sha256 = $engineFiles
}
if ($packaged) {
    $receipt['engine_runtime'] = 'wheel; installed package files verified against release artifact'
    $receipt['runtime_root'] = $root
    $receipt['runtime_manifest_sha256'] = (Get-FileHash -LiteralPath (Join-Path $root 'runtime-manifest.json')).Hash.ToLowerInvariant()
    $receipt['engine_wheel_sha256'] = $release.files[[string]$release.engine_wheel]
    $receipt['release'] = $release.release
}
$receiptPath = Join-Path ([string]$deployment.state) 'reports\deployment-receipt.json'
Write-OkfJson -Path $receiptPath -Value $receipt
Write-Host "Verified deployment receipt: $receiptPath"
