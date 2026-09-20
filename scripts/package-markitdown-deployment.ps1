[CmdletBinding()]
param([string]$OutputDirectory = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$output = if ($OutputDirectory.Trim()) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    Join-Path $repository 'dist\markitdown'
}
$temporaryRoot = Join-Path $repository '.tmp'
$stage = Join-Path $temporaryRoot ("markitdown-release-" + [guid]::NewGuid().ToString('N'))
$utf8 = [System.Text.UTF8Encoding]::new($false)

$files = [System.Collections.Generic.List[string]]::new()
foreach ($root in @('deploy\markitdown', 'services\markitdown\src')) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $repository $root) -Recurse -File) {
        $relative = [System.IO.Path]::GetRelativePath($repository, $file.FullName)
        $isPrivateEnvironment = $file.Name -eq '.env' -or
            ($file.Name -like '.env.*' -and $file.Name -ne '.env.example')
        if ($isPrivateEnvironment -or $relative -match '(^|\\)__pycache__(\\|$)' -or
            $relative.EndsWith('.pyc', [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $files.Add($relative)
    }
}
foreach ($relative in @(
    'services\markitdown\Dockerfile',
    'services\markitdown\README.md',
    'services\markitdown\pyproject.toml',
    'services\markitdown\requirements.lock',
    'services\markitdown\uv.lock'
)) {
    $files.Add($relative)
}

New-Item -ItemType Directory -Force -Path $stage, $output | Out-Null
try {
    foreach ($relative in $files | Sort-Object -Unique) {
        $source = Join-Path $repository $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required MarkItDown release file is missing: $relative"
        }
        $destination = Join-Path $stage $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }

    $metadata = [ordered]@{
        schema = 'okf-markitdown-release/v1'
        created_at = [DateTimeOffset]::UtcNow.ToString('o')
        service_version = '1.4.0'
        engine_build_id = 'markitdown-0.1.6-py31213-assets-v3'
        result_schema = 'markitdown-result/v3'
        default_profile = 'fallback-assets-v2'
        source = 'okf-workspace-monorepo'
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $stage 'release-metadata.json'),
        (($metadata | ConvertTo-Json -Depth 4) + "`n"),
        $utf8
    )

    $manifestLines = foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName) {
        $relative = [System.IO.Path]::GetRelativePath($stage, $file.FullName).Replace('\', '/')
        $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$digest  $relative"
    }
    $manifestPath = Join-Path $stage 'release-manifest.sha256'
    [System.IO.File]::WriteAllText($manifestPath, (($manifestLines -join "`n") + "`n"), $utf8)
    $manifestDigest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $archiveName = "markitdown-release-$stamp-$($manifestDigest.Substring(0, 12)).tar.gz"
    $archivePath = Join-Path $output $archiveName
    $tar = Get-Command tar -ErrorAction Stop
    & $tar.Source -czf $archivePath -C $stage .
    if ($LASTEXITCODE -ne 0) { throw 'tar failed while packaging MarkItDown' }
    $archiveDigest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        "$archivePath.sha256",
        "$archiveDigest  $archiveName`n",
        $utf8
    )

    [pscustomobject]@{
        archive = $archivePath
        sha256 = $archiveDigest
        manifest_sha256 = $manifestDigest
        files = $manifestLines.Count
    }
}
finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath($temporaryRoot).TrimEnd('\') + '\'
    $resolvedStage = [System.IO.Path]::GetFullPath($stage)
    if (-not $resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean unsafe staging path: $resolvedStage"
    }
    if (Test-Path -LiteralPath $resolvedStage) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
