"""Write the complete parser-output contract before publishing any note."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from .models import OriginalRecord, ParserExport, ParserName, QCReport


def _io_path(path: Path) -> Path:
    """Return a Windows extended-length path for deeply nested hashed assets."""

    if os.name != "nt":
        return path
    value = str(path.resolve())
    if value.startswith("\\\\?\\"):
        return path
    if value.startswith("\\\\"):
        return Path(f"\\\\?\\UNC\\{value[2:]}")
    return Path(f"\\\\?\\{value}")


def write_export_contract(
    directory: Path,
    *,
    conversion_id: str,
    original: OriginalRecord,
    export: ParserExport,
    qc: QCReport,
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    document = directory / "document.md"
    document.write_text(
        export.markdown.rstrip() + "\n",
        encoding="utf-8",
        newline="\n",
    )
    asset_root = directory / "assets"
    asset_paths: list[str] = []
    for relative, data in sorted(export.assets.items()):
        target = _io_path(asset_root.joinpath(*Path(relative).parts))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        asset_paths.append((Path("assets") / relative).as_posix())
    manifest: dict[str, object] = {
        "conversion_id": conversion_id,
        "source_sha256": original.sha256,
        "source_filename": original.filename,
        "parser": export.parser.value,
        "parser_version": export.parser_version,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "markdown": "document.md",
        "assets": asset_paths,
    }
    if export.degraded_from is not None:
        manifest["degraded_from"] = export.degraded_from.value
    if export.warnings:
        manifest["parser_warnings"] = list(export.warnings)
    if export.expected_image_references is not None:
        manifest["expected_image_references"] = export.expected_image_references
    if export.output_image_references is not None:
        manifest["output_image_references"] = export.output_image_references
    if export.bundle_schema is not None:
        manifest["parser_bundle_schema"] = export.bundle_schema
    if export.profile is not None:
        manifest["parser_profile"] = export.profile
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (directory / "qc-report.json").write_text(
        json.dumps(asdict(qc), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return directory


def load_export_contract(directory: Path) -> tuple[ParserExport, QCReport]:
    """Load a previously verified parser export so routing can resume without reparsing."""

    manifest_object = cast(
        object,
        json.loads((directory / "manifest.json").read_text(encoding="utf-8")),
    )
    qc_object = cast(
        object,
        json.loads((directory / "qc-report.json").read_text(encoding="utf-8")),
    )
    if not isinstance(manifest_object, dict) or not isinstance(qc_object, dict):
        raise ValueError("invalid conversion export contract")
    manifest = cast(Mapping[str, object], manifest_object)
    qc_payload = cast(Mapping[str, object], qc_object)
    markdown_name = manifest.get("markdown")
    if not isinstance(markdown_name, str):
        raise ValueError("conversion manifest has no markdown output")
    assets: dict[str, bytes] = {}
    asset_values = manifest.get("assets")
    if isinstance(asset_values, list):
        for value in cast(list[object], asset_values):
            if not isinstance(value, str):
                continue
            asset_path = _io_path(directory.joinpath(*Path(value).parts))
            relative = Path(value).relative_to("assets").as_posix()
            assets[relative] = asset_path.read_bytes()
    checks_value = qc_payload.get("checks")
    checks = (
        {
            str(key): bool(value)
            for key, value in cast(Mapping[object, object], checks_value).items()
        }
        if isinstance(checks_value, dict)
        else {}
    )
    warnings_value = qc_payload.get("warnings")
    errors_value = qc_payload.get("errors")
    degraded = manifest.get("degraded_from")
    parser_warnings = manifest.get("parser_warnings")
    expected_images = manifest.get("expected_image_references")
    output_images = manifest.get("output_image_references")
    bundle_schema = manifest.get("parser_bundle_schema")
    parser_profile = manifest.get("parser_profile")
    return (
        ParserExport(
            markdown=directory.joinpath(markdown_name).read_text(encoding="utf-8"),
            assets=assets,
            parser=ParserName(str(manifest["parser"])),
            parser_version=str(manifest.get("parser_version", "unknown")),
            degraded_from=ParserName(str(degraded)) if isinstance(degraded, str) else None,
            warnings=tuple(str(value) for value in cast(list[object], parser_warnings))
            if isinstance(parser_warnings, list)
            else (),
            expected_image_references=expected_images
            if isinstance(expected_images, int) and not isinstance(expected_images, bool)
            else None,
            output_image_references=output_images
            if isinstance(output_images, int) and not isinstance(output_images, bool)
            else None,
            bundle_schema=bundle_schema if isinstance(bundle_schema, str) else None,
            profile=parser_profile if isinstance(parser_profile, str) else None,
        ),
        QCReport(
            passed=bool(qc_payload.get("passed")),
            checks=checks,
            warnings=tuple(str(value) for value in cast(list[object], warnings_value))
            if isinstance(warnings_value, list)
            else (),
            errors=tuple(str(value) for value in cast(list[object], errors_value))
            if isinstance(errors_value, list)
            else (),
        ),
    )
