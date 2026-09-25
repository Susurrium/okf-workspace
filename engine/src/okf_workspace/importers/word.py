"""Normalize legacy DOC/PPT through installed Microsoft Office COM."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

_WORD_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($env:OKF_OFFICE_COM_SOURCE)
$target = [System.IO.Path]::GetFullPath($env:OKF_OFFICE_COM_TARGET)
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$document = $null
try {
    $document = $word.Documents.Open($source, $false, $true)
    $document.SaveAs2($target, 16)
}
finally {
    if ($null -ne $document) { $document.Close($false) }
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null
}
"""

_POWERPOINT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($env:OKF_OFFICE_COM_SOURCE)
$target = [System.IO.Path]::GetFullPath($env:OKF_OFFICE_COM_TARGET)
$powerpoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerpoint.Presentations.Open($source, $true, $false, $false)
    $presentation.SaveAs($target, 24)
}
finally {
    if ($null -ne $presentation) { $presentation.Close() }
    $powerpoint.Quit()
    [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint) | Out-Null
}
"""


class OfficeComConverter:
    def convert(self, source: Path, destination: Path) -> Path:
        extension = source.suffix.casefold()
        if extension not in {".doc", ".ppt"}:
            return source
        destination.parent.mkdir(parents=True, exist_ok=True)
        script = _WORD_SCRIPT if extension == ".doc" else _POWERPOINT_SCRIPT
        environment = os.environ.copy()
        environment["OKF_OFFICE_COM_SOURCE"] = str(source.resolve())
        environment["OKF_OFFICE_COM_TARGET"] = str(destination.resolve())
        try:
            result = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                env=environment,
                timeout=180,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"{extension.upper().lstrip('.')} conversion timed out") from exc
        if result.returncode != 0 or not destination.is_file():
            detail = result.stderr.strip() or result.stdout.strip() or "unknown Word COM error"
            target_kind = "DOCX" if extension == ".doc" else "PPTX"
            raise RuntimeError(
                f"{extension.upper().lstrip('.')} to {target_kind} conversion failed: {detail}"
            )
        return destination
