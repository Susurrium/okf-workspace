[CmdletBinding()]
param([string]$OutputDirectory = '', [switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $repository 'deploy\windows\common.ps1')
$output = if ($OutputDirectory) { Resolve-OkfPath $OutputDirectory } else { Join-Path $repository 'dist\workspace' }
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
$python = Join-Path $repository 'engine\.venv\Scripts\python.exe'
$versions = & $python -c 'import json,sys; from ruamel.yaml import YAML; print(json.dumps(YAML(typ="safe").load(open(sys.argv[1], encoding="utf-8"))))' (Join-Path $repository 'release-manifest.yaml')
if ($LASTEXITCODE -ne 0) { throw 'Cannot read release versions' }
$release = ConvertTo-OkfHashtable (ConvertFrom-Json ($versions | Out-String))
$version = [string]$release.release
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid release version' }
foreach ($component in @('dashboard', 'claudian')) {
    $manifest = Read-OkfJsonHashtable -Path (Join-Path $repository "$component\manifest.json")
    if ($manifest.version -ne $release.components[$component]) { throw "Release version mismatch: $component" }
}
$wheelName = "okf_workspace_engine-$($release.components.engine)-py3-none-any.whl"
$temporaryRoot = Join-Path $repository '.tmp'
$stage = Join-Path $temporaryRoot ('workspace-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage, $output | Out-Null
try {
    $files = @{
        'release-manifest.yaml' = 'release-manifest.yaml'
        "engine/$wheelName" = "engine/dist/$wheelName"
        'dashboard/dist/main.js' = 'dashboard/dist/main.js'
        'dashboard/dist/styles.css' = 'dashboard/dist/styles.css'
        'dashboard/manifest.json' = 'dashboard/manifest.json'
        'claudian/main.js' = 'claudian/main.js'
        'claudian/styles.css' = 'claudian/styles.css'
        'claudian/manifest.json' = 'claudian/manifest.json'
    }
    foreach ($name in @('common', 'release', 'install', 'uninstall', 'run-service', 'maintenance', 'feed-sync', 'backup', 'restore-test')) { $files["deploy/windows/$name.ps1"] = "deploy/windows/$name.ps1" }
    foreach ($name in @('install-skills', 'install-okf-claudian', 'record-deployment')) { $files["scripts/$name.ps1"] = "scripts/$name.ps1" }
    foreach ($relative in $files.Keys) {
        $source = Join-Path $repository ([string]$files[$relative])
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing release artifact: $source" }
        $target = Join-Path $stage $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Push-Location (Join-Path $repository 'engine')
    try {
        foreach ($extra in @('', 'vector')) {
            $name = if ($extra) { 'requirements-vector.lock' } else { 'requirements.lock' }
            $arguments = @('export', '--frozen', '--no-dev', '--no-emit-project', '--no-header', '--no-annotate', '--output-file', (Join-Path $stage "engine/$name"))
            if ($extra) { $arguments += @('--extra', $extra) }
            & uv @arguments | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Engine dependency export failed' }
        }
    } finally { Pop-Location }
    $hashes = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName) {
        $relative = [IO.Path]::GetRelativePath($stage, $file.FullName).Replace('\', '/')
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    }
    $revision = (& git -C $repository rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read source revision' }
    $dirty = @(& git -C $repository status --porcelain --untracked-files=normal).Count -gt 0
    Write-OkfJson -Path (Join-Path $stage 'runtime-manifest.json') -Value ([ordered]@{
        schema = 'okf-workspace-release/v1'; release = $version; components = $release.components
        source_revision = $revision; source_worktree_dirty = $dirty
        engine_wheel = "engine/$wheelName"; files = $hashes
    })
    $digest = (Get-FileHash -LiteralPath (Join-Path $stage 'runtime-manifest.json')).Hash.ToLowerInvariant()
    $target = Join-Path $output "$version-$($digest.Substring(0, 12))"
    if (Test-Path -LiteralPath $target) { throw "Release already exists: $target" }
    Move-Item -LiteralPath $stage -Destination $target
    $archive = "$target.zip"
    Compress-Archive -Path (Join-Path $target '*') -DestinationPath $archive
    $archiveHash = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$archive.sha256", "$archiveHash  $([IO.Path]::GetFileName($archive))`n")
    [pscustomobject]@{ package = $target; archive = $archive; sha256 = $archiveHash; release = $version }
} finally {
    $resolvedStage = Resolve-OkfPath $stage
    if (-not $resolvedStage.StartsWith((Resolve-OkfPath $temporaryRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe package staging cleanup path.' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
