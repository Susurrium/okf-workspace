from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "nt", reason="native Windows PowerShell pipeline test")
@pytest.mark.parametrize("shell_name", ["powershell.exe", "pwsh.exe"])
def test_cli_json_survives_native_powershell_pipeline(
    shell_name: str,
    tmp_path: Path,
) -> None:
    shell = shutil.which(shell_name)
    if shell is None:
        pytest.skip(f"{shell_name} is not installed")

    emitter = tmp_path / "emit_json.py"
    emitter.write_text(
        "from okf_workspace.cli import _print_json\n"
        '_print_json({"label": "全文索引", "detail": "需要重建"})\n',
        encoding="utf-8",
        newline="\n",
    )
    python_path = str(Path(sys.executable)).replace("'", "''")
    emitter_path = str(emitter).replace("'", "''")
    command = (
        "$ErrorActionPreference = 'Stop'; "
        "[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); "
        f"$report = & '{python_path}' '{emitter_path}' | Out-String | ConvertFrom-Json; "
        "$labelCodes = (([int[]][char[]]$report.label) -join ','); "
        "$detailCodes = (([int[]][char[]]$report.detail) -join ','); "
        "if ($labelCodes -ne '20840,25991,32034,24341' -or "
        "$detailCodes -ne '38656,35201,37325,24314') { exit 42 }; "
        "Write-Output 'PASS'"
    )

    result = subprocess.run(
        [shell, "-NoLogo", "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert result.stdout.strip() == b"PASS"
