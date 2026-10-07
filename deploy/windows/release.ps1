function Read-OkfRelease {
    param([Parameter(Mandatory)][string]$Root)
    $rootPath = Resolve-OkfPath $Root
    $metadata = Read-OkfJsonHashtable -Path (Join-Path $rootPath 'runtime-manifest.json')
    if ($metadata.schema -ne 'okf-workspace-release/v1' -or
        [string]$metadata.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or
        $metadata.files -isnot [System.Collections.IDictionary] -or $metadata.files.Count -eq 0) {
        throw 'Invalid Workspace release manifest.'
    }
    foreach ($relative in $metadata.files.Keys) {
        if ([string]$relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or
            [string]$metadata.files[$relative] -notmatch '^[a-f0-9]{64}$') {
            throw "Invalid release file entry: $relative"
        }
        $filePath = Resolve-OkfPath (Join-Path $rootPath $relative)
        if (-not $filePath.StartsWith($rootPath.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw "Release file is missing or outside the package: $relative"
        }
        $current = Get-Item -LiteralPath $filePath
        while ($current.FullName -ne $rootPath) {
            if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release file uses a link: $relative" }
            $current = if ($current -is [IO.FileInfo]) { $current.Directory } else { $current.Parent }
        }
        if ((Get-FileHash -LiteralPath $filePath).Hash.ToLowerInvariant() -ne $metadata.files[$relative]) {
            throw "Release file checksum mismatch: $relative"
        }
    }
    foreach ($required in @(
        'release-manifest.yaml', 'deploy/windows/install.ps1', 'deploy/windows/common.ps1',
        'deploy/windows/release.ps1', 'engine/requirements.lock', 'engine/requirements-vector.lock',
        'deploy/windows/uninstall.ps1', 'deploy/windows/run-service.ps1',
        'deploy/windows/maintenance.ps1', 'deploy/windows/feed-sync.ps1',
        'deploy/windows/backup.ps1', 'deploy/windows/restore-test.ps1',
        'dashboard/dist/main.js', 'dashboard/dist/styles.css', 'dashboard/manifest.json',
        'claudian/main.js', 'claudian/styles.css', 'claudian/manifest.json',
        'scripts/install-skills.ps1', 'scripts/install-okf-claudian.ps1', 'scripts/record-deployment.ps1'
    )) {
        if (-not $metadata.files.Contains($required)) { throw "Release manifest omits required file: $required" }
    }
    if (-not $metadata.files.Contains([string]$metadata.engine_wheel) -or
        [string]$metadata.engine_wheel -notmatch '^engine/okf_workspace_engine-[0-9.]+-py3-none-any\.whl$') {
        throw 'Invalid release Engine wheel.'
    }
    return $metadata
}

function Install-OkfReleaseFiles {
    param([Parameter(Mandatory)][string]$PackageRoot, [Parameter(Mandatory)][string]$ProgramRoot)
    $packagePath = Resolve-OkfPath $PackageRoot
    $metadata = Read-OkfRelease -Root $packagePath
    $manifestPath = Join-Path $packagePath 'runtime-manifest.json'
    $digest = (Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant()
    $releases = Join-Path (Resolve-OkfPath $ProgramRoot) 'releases'
    $target = Join-Path $releases "$($metadata.release)-$($digest.Substring(0, 12))"
    if (Test-Path -LiteralPath $target) {
        Read-OkfRelease -Root $target | Out-Null
        if ((Get-FileHash -LiteralPath (Join-Path $target 'runtime-manifest.json')).Hash.ToLowerInvariant() -ne $digest) {
            throw "Existing release identity differs: $target"
        }
        return $target
    }
    New-Item -ItemType Directory -Force -Path $releases | Out-Null
    $stage = Join-Path $releases ('.stage-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($relative in $metadata.files.Keys) {
            $destination = Join-Path $stage $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath (Join-Path $packagePath $relative) -Destination $destination
        }
        Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'runtime-manifest.json')
        Read-OkfRelease -Root $stage | Out-Null
        Move-Item -LiteralPath $stage -Destination $target
        return $target
    } finally {
        $resolvedStage = Resolve-OkfPath $stage
        if (-not $resolvedStage.StartsWith((Resolve-OkfPath $releases).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe release staging cleanup path.' }
        if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}

function Assert-OkfReleaseEngine {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Python)
    $metadata = Read-OkfRelease -Root $Root
    $verification = @'
import hashlib, pathlib, sys, zipfile
import okf_workspace
root = pathlib.Path(sys.argv[1]).resolve()
site = root / 'engine' / '.venv' / 'Lib' / 'site-packages'
if not pathlib.Path(okf_workspace.__file__).resolve().is_relative_to(site.resolve()):
    raise SystemExit('Engine import comes from outside the installed release')
with zipfile.ZipFile(root / sys.argv[2]) as wheel:
    for name in wheel.namelist():
        if not name.startswith('okf_workspace/') or name.endswith('/'):
            continue
        installed = site / name
        if not installed.is_file() or hashlib.sha256(installed.read_bytes()).digest() != hashlib.sha256(wheel.read(name)).digest():
            raise SystemExit('Installed Engine differs from release wheel: ' + name)
'@
    & $Python -I -c $verification $Root ([string]$metadata.engine_wheel)
    if ($LASTEXITCODE -ne 0) { throw 'Installed Engine integrity check failed' }
}

function Install-OkfReleaseEngine {
    param([Parameter(Mandatory)][string]$Root, [switch]$SkipVectorIndex)
    $metadata = Read-OkfRelease -Root $Root
    $python = Join-Path $Root 'engine\.venv\Scripts\python.exe'
    $requirements = if ($SkipVectorIndex) { 'engine/requirements.lock' } else { 'engine/requirements-vector.lock' }
    $marker = Join-Path $Root 'engine\runtime-installation.json'
    if (Test-Path -LiteralPath $marker) {
        $installed = Read-OkfJsonHashtable -Path $marker
        if ($installed.requirements_sha256 -ne $metadata.files[$requirements] -or $installed.wheel_sha256 -ne $metadata.files[[string]$metadata.engine_wheel]) {
            throw 'Release runtime options differ; use a separate program directory for this installation.'
        }
        Assert-OkfReleaseEngine -Root $Root -Python $python
        return $python
    }
    Assert-OkfCommand 'uv' | Out-Null
    & uv venv --python 3.12 (Join-Path $Root 'engine\.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Release Python environment creation failed' }
    & uv pip sync --python $python --require-hashes (Join-Path $Root $requirements)
    if ($LASTEXITCODE -ne 0) { throw 'Locked Engine dependency installation failed' }
    & uv pip install --python $python --no-deps (Join-Path $Root ([string]$metadata.engine_wheel))
    if ($LASTEXITCODE -ne 0) { throw 'Engine wheel installation failed' }
    Assert-OkfReleaseEngine -Root $Root -Python $python
    Write-OkfJson -Path $marker -Value ([ordered]@{
        requirements_sha256 = $metadata.files[$requirements]
        wheel_sha256 = $metadata.files[[string]$metadata.engine_wheel]
    })
    return $python
}
