[CmdletBinding()]
param(
    [string]$Path = 'E:\ObsidianData\OKF-Brain-State\secrets\markitdown-client.token',
    [string]$Vault = 'E:\ObsidianData\OKF-Brain'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$target = [System.IO.Path]::GetFullPath($Path)
$vaultRoot = [System.IO.Path]::GetFullPath($Vault).TrimEnd('\') + '\'
if ($target.StartsWith($vaultRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The MarkItDown token must be stored outside the Vault.'
}
if (Test-Path -LiteralPath $target) {
    throw "Refusing to overwrite an existing token: $target"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
$bytes = [byte[]]::new(48)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
[System.IO.File]::WriteAllText($target, "$token`n", [System.Text.UTF8Encoding]::new($false))

if ($IsWindows) {
    & icacls.exe $target /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to restrict token permissions: $target" }
}

[pscustomobject]@{ token_file = $target; overwritten = $false }
