"""Resumable client for MinerU's token-authenticated precision API."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import cast
from urllib.parse import quote, urlsplit

import httpx

from .adaptive_ocr import (
    Page,
    SlideImage,
    page_markdown,
    pptx_slide_images,
    read_mineru_pages,
    visible_characters,
)
from .archive import normalize_zip
from .clients import MAX_RESULT_BYTES, ParserClientError, RetryableConversionError
from .models import ParserExport, ParserName

_UPLOAD_HOSTS = {"mineru.oss-cn-shanghai.aliyuncs.com", "oss-mineru.openxlab.org.cn"}
_RESULT_HOSTS = {"cdn-mineru.openxlab.org.cn"}
_RETRYABLE_CODES = {-10001, -60001, -60007, -60009, -60010, -60020}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
_MAX_OCR_PAGES = 40
_MAX_IMAGES_PER_PAGE = 4


class RetryableMinerUError(RetryableConversionError):
    """The cloud task can be queried or submitted again after a delay."""


def _safe_vendor_url(value: str, hosts: set[str]) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in hosts
        or parsed.username
        or parsed.password
    ):
        raise ParserClientError("MinerU returned an untrusted transfer URL")
    return value


def _payload(response: httpx.Response, operation: str) -> Mapping[str, object]:
    if response.status_code == 429 or response.status_code >= 500:
        raise RetryableMinerUError(f"MinerU {operation} is temporarily unavailable")
    if response.status_code != 200:
        raise ParserClientError(f"MinerU {operation} returned HTTP {response.status_code}")
    try:
        loaded = cast(object, response.json())
    except (ValueError, UnicodeDecodeError) as exc:
        raise ParserClientError(f"MinerU {operation} returned invalid JSON") from exc
    if not isinstance(loaded, dict):
        raise ParserClientError(f"MinerU {operation} returned invalid data")
    result = cast(Mapping[str, object], loaded)
    code = result.get("code")
    if code != 0:
        message = str(result.get("msg", "request failed"))[:300]
        error_type = RetryableMinerUError if code in _RETRYABLE_CODES else ParserClientError
        raise error_type(f"MinerU {operation} failed ({code}): {message}")
    data = result.get("data")
    if not isinstance(data, dict):
        raise ParserClientError(f"MinerU {operation} returned no data")
    return cast(Mapping[str, object], data)


def _required(data: Mapping[str, object], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ParserClientError(f"MinerU response is missing {key}")
    return value


def _read_state(path: Path, identity: str) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        raise ParserClientError("MinerU task state is unreadable") from exc
    if not isinstance(loaded, dict):
        raise ParserClientError("MinerU task state is invalid")
    state = cast(dict[str, object], loaded)
    return state if state.get("identity") == identity else {}


def _write_state(path: Path, state: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".cloud-mineru-", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class CloudMinerUClient:
    parser = ParserName.MINERU

    def __init__(
        self,
        token_file: Path,
        *,
        base_url: str = "https://mineru.net/api/v4",
        model: str = "vlm",
        client: httpx.Client | None = None,
        poll_seconds: float = 5.0,
    ) -> None:
        if base_url.rstrip("/") != "https://mineru.net/api/v4":
            raise ValueError("MinerU cloud API URL must be https://mineru.net/api/v4")
        if model not in {"vlm", "pipeline"}:
            raise ValueError("MinerU cloud model must be vlm or pipeline")
        self.token_file = token_file
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.poll_seconds = poll_seconds
        self._owns_client = client is None
        self.client = client or httpx.Client(
            timeout=120.0, follow_redirects=False, trust_env=False,
        )

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def _headers(self) -> dict[str, str]:
        token = self.token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise ParserClientError("MinerU token file is empty")
        return {"Authorization": f"Bearer {token}"}

    def _get_result(self, batch_id: str, headers: Mapping[str, str]) -> Mapping[str, object]:
        response = self.client.get(
            f"{self.base_url}/extract-results/batch/{quote(batch_id, safe='')}",
            headers=headers,
        )
        if response.status_code == 404:
            raise RetryableMinerUError("MinerU batch is not available for querying yet")
        data = _payload(response, "query")
        results = data.get("extract_result")
        if not isinstance(results, list):
            raise ParserClientError("MinerU returned an unexpected batch result")
        entries = cast(list[object], results)
        if len(entries) != 1 or not isinstance(entries[0], dict):
            raise ParserClientError("MinerU returned an unexpected batch result")
        return cast(Mapping[str, object], entries[0])

    def _download(self, url: str, target: Path) -> None:
        _safe_vendor_url(url, _RESULT_HOSTS)
        size = 0
        prefix = bytearray()
        with self.client.stream("GET", url) as response:
            if response.status_code == 429 or response.status_code >= 500:
                raise RetryableMinerUError("MinerU result download is temporarily unavailable")
            if response.status_code != 200:
                raise ParserClientError(
                    f"MinerU result download returned HTTP {response.status_code}"
                )
            with target.open("wb") as handle:
                for block in response.iter_bytes(chunk_size=1024 * 1024):
                    size += len(block)
                    if size > MAX_RESULT_BYTES:
                        raise ParserClientError("MinerU result exceeds the ZIP size limit")
                    if len(prefix) < 4:
                        prefix.extend(block[: 4 - len(prefix)])
                    handle.write(block)
        if bytes(prefix) not in {b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"}:
            raise ParserClientError("MinerU result is not a ZIP archive")

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        if source.suffix.casefold() in _IMAGE_EXTENSIONS:
            export = self._convert_one(
                source, working_directory, is_ocr=True, timeout_seconds=timeout_seconds,
            )
            image_path = f"images/original{source.suffix.casefold()}"
            if image_path not in export.assets:
                assets = {**export.assets, image_path: source.read_bytes()}
                export = replace(
                    export,
                    markdown=export.markdown.rstrip() + f"\n\n![原始图片]({image_path})\n",
                    assets=assets,
                )
            return export
        baseline = self._convert_one(
            source, working_directory, is_ocr=False, timeout_seconds=timeout_seconds,
        )
        return self._enrich_pages(source, working_directory, baseline, timeout_seconds)

    def _enrich_pages(
        self, source: Path, working: Path, baseline: ParserExport, timeout_seconds: float,
    ) -> ParserExport:
        pages = read_mineru_pages(working / "cloud-mineru-result.zip", baseline)
        if not pages:
            return replace(baseline, warnings=(*baseline.warnings,
                "MinerU did not return usable page metadata; visual OCR was not scheduled",
            ))
        slide_images = pptx_slide_images(source)
        page_by_number = {page.number: page for page in pages}
        assets = dict(baseline.assets)
        supplemental: dict[int, list[str]] = {}
        warnings = list(baseline.warnings)
        candidates: list[tuple[Page, bool, bool, tuple[SlideImage, ...]]] = []
        for page in pages:
            originals = slide_images.get(page.number, ())
            visible = visible_characters(page.visible_text)
            sparse = visible < 50
            large = any(image.area_fraction >= 1 / 3 for image in originals)
            blank_pdf_page = source.suffix.casefold() == ".pdf" and visible == 0
            if (sparse and (page.images or originals)) or large or blank_pdf_page:
                candidates.append((page, sparse, large, originals))
        if len(candidates) > _MAX_OCR_PAGES:
            warnings.append(
                f"visual OCR budget reached: {len(candidates) - _MAX_OCR_PAGES} page(s) deferred"
            )
            for page, _, _, _ in candidates[_MAX_OCR_PAGES:]:
                supplemental[page.number] = [
                    "本页有图片，尚未补充 OCR；分析图示时请查看原图或原件。"
                ]
        for page, sparse, large, originals in candidates[:_MAX_OCR_PAGES]:
            results: list[str] = []
            if source.suffix.casefold() == ".pdf":
                try:
                    result = self._convert_one(
                        source, working / "ocr" / f"page-{page.number}",
                        is_ocr=True, page_ranges=str(page.number), timeout_seconds=timeout_seconds,
                    )
                    results.append(result.markdown)
                except RetryableMinerUError:
                    raise
                except ParserClientError as exc:
                    warnings.append(f"page {page.number} visual OCR failed: {exc}")
            else:
                inputs: list[tuple[str, bytes]] = []
                usable_originals = [
                    image for image in originals
                    if image.data and Path(image.name).suffix.casefold() in _IMAGE_EXTENSIONS
                ]
                if usable_originals:
                    selected = (
                        [image for image in usable_originals if image.area_fraction >= 1 / 3]
                        if not sparse else
                        [image for image in usable_originals if image.area_fraction >= 0.02]
                    )
                    inputs = [(image.name, image.data) for image in selected[:_MAX_IMAGES_PER_PAGE]]
                selected_from_originals = bool(inputs)
                if not inputs and (sparse or large):
                    inputs = [
                        (Path(path).name, assets[path]) for path in page.images
                        if path in assets
                    ][:_MAX_IMAGES_PER_PAGE]
                for index, (name, data) in enumerate(inputs, start=1):
                    suffix = Path(name).suffix.casefold()
                    if suffix not in _IMAGE_EXTENSIONS:
                        continue
                    target = working / "ocr-input" / f"page-{page.number}-{index}{suffix}"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    if selected_from_originals:
                        asset_path = f"images/source-slide-{page.number}-{index}{suffix}"
                        assets[asset_path] = data
                        results.append(f"![原始幻灯片图片]({asset_path})")
                    try:
                        result = self._convert_one(
                            target, working / "ocr" / f"page-{page.number}-image-{index}",
                            is_ocr=True, timeout_seconds=timeout_seconds,
                        )
                        results.append(result.markdown)
                    except RetryableMinerUError:
                        raise
                    except ParserClientError as exc:
                        warnings.append(f"page {page.number} image {index} OCR failed: {exc}")
            native = "".join(
                character.casefold() for character in page.visible_text if character.isalnum()
            )
            additions: list[str] = []
            for result in results:
                if result.startswith("![原始幻灯片图片]"):
                    additions.append(result)
                    continue
                text_only = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", result)
                lines: list[str] = []
                for raw_line in text_only.splitlines():
                    line = raw_line.strip()
                    folded_line = "".join(
                        character.casefold() for character in line if character.isalnum()
                    )
                    if line and folded_line and folded_line not in native:
                        lines.append(line)
                        native += folded_line
                useful = "\n".join(lines).strip()
                folded = "".join(
                    character.casefold() for character in useful if character.isalnum()
                )
                if len(folded) >= 3 and useful not in additions:
                    additions.append(f"**图片 OCR 文字（机器解析，可能有误）：**\n\n{useful}")  # noqa: RUF001
            if not any(item.startswith("**图片 OCR") for item in additions):
                additions.append("本页图片未提取到更多文字；分析图示时请查看原图或原件。")
                if not page.visible_text.strip():
                    neighbors = [
                        page_by_number[number].visible_text.strip()
                        for number in (page.number - 1, page.number + 1)
                        if number in page_by_number
                    ]
                    nearby = " / ".join(value[:60] for value in neighbors if value)
                    if nearby:
                        additions.append(f"检索线索（相邻页文字，并非本页原文）：{nearby}")  # noqa: RUF001
            supplemental[page.number] = additions
        status_object = cast(
            object, json.loads((working.parent / "status.json").read_text(encoding="utf-8"))
        )
        status: Mapping[str, object] = (
            cast(Mapping[str, object], status_object) if isinstance(status_object, dict) else {}
        )
        filename = status.get("source_filename")
        title = Path(filename).stem if isinstance(filename, str) else source.stem
        markdown = page_markdown(source, pages, title=title, additions=supplemental)
        if visible_characters(markdown) < 0.8 * visible_characters(baseline.markdown):
            warnings.append("page metadata omitted source text; retained MinerU full.md")
            extra = [
                f"### 第 {number} 页图片补充识别\n\n" + "\n\n".join(items)
                for number, items in sorted(supplemental.items())
            ]
            markdown = baseline.markdown.rstrip() + (
                "\n\n## 逐页图片补充识别\n\n" + "\n\n".join(extra) if extra else ""
            )
        return replace(baseline, markdown=markdown, assets=assets, warnings=tuple(warnings))

    def _convert_one(
        self, source: Path, working_directory: Path, *, is_ocr: bool,
        page_ranges: str | None = None, timeout_seconds: float = 900.0,
    ) -> ParserExport:
        working_directory.mkdir(parents=True, exist_ok=True)
        state_path = working_directory / "cloud-mineru.json"
        status_path = next(
            (parent / "status.json" for parent in working_directory.parents
             if (parent / "status.json").is_file()), None,
        )
        if status_path is None:
            raise ParserClientError("MinerU conversion state is unavailable")
        try:
            status = cast(Mapping[str, object], json.loads(status_path.read_text(encoding="utf-8")))
        except (OSError, ValueError) as exc:
            raise ParserClientError("MinerU conversion state is unavailable") from exc
        revision = str(status.get("generation_revision") or "initial")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        mode = f"ocr={int(is_ocr)}:pages={page_ranges or 'all'}"
        identity = f"{digest}:{self.model}:{mode}:{revision}"
        state = _read_state(state_path, identity)
        headers = self._headers()
        deadline = time.monotonic() + timeout_seconds
        try:
            if not state:
                options_digest = hashlib.sha256(mode.encode()).hexdigest()[:8]
                data_id = f"okf-{digest[:32]}-{options_digest}-{revision[:16]}"
                file_request: dict[str, object] = {
                    "name": source.name, "data_id": data_id, "is_ocr": is_ocr,
                }
                if page_ranges is not None:
                    file_request["page_ranges"] = page_ranges
                response = self.client.post(
                    f"{self.base_url}/file-urls/batch",
                    headers=headers,
                    json={
                        "files": [file_request],
                        "model_version": self.model,
                        "enable_formula": True,
                        "enable_table": True,
                    },
                )
                data = _payload(response, "submit")
                urls = data.get("file_urls")
                if not isinstance(urls, list):
                    raise ParserClientError("MinerU returned no upload URL")
                url_items = cast(list[object], urls)
                if len(url_items) != 1 or not isinstance(url_items[0], str):
                    raise ParserClientError("MinerU returned no upload URL")
                upload_url = _safe_vendor_url(url_items[0], _UPLOAD_HOSTS)
                state = {
                    "identity": identity,
                    "batch_id": _required(data, "batch_id"),
                    "data_id": data_id,
                    "upload_url": upload_url,
                    "created_at": time.time(),
                }
                _write_state(state_path, state)
            batch_id = _required(state, "batch_id")
            while True:
                item = self._get_result(batch_id, headers)
                item_data_id = item.get("data_id")
                if item_data_id is not None and item_data_id != state.get("data_id"):
                    raise ParserClientError("MinerU returned a result for another file")
                phase = _required(item, "state")
                if phase == "done":
                    result_url = _required(item, "full_zip_url")
                    archive = working_directory / "cloud-mineru-result.zip"
                    self._download(result_url, archive)
                    return normalize_zip(
                        archive, parser=ParserName.MINERU,
                        parser_version=f"cloud-v4/{self.model}",
                    )
                if phase == "failed":
                    detail = str(item.get("err_msg", ""))[:300]
                    raise ParserClientError(f"MinerU parsing failed: {detail}")
                if phase == "waiting-file":
                    if state.get("uploaded") is True:
                        if time.monotonic() >= deadline:
                            raise RetryableMinerUError("MinerU task timed out; it can be resumed")
                        time.sleep(self.poll_seconds)
                        continue
                    upload_url = state.get("upload_url")
                    created_at = state.get("created_at")
                    if not isinstance(upload_url, str) or not isinstance(created_at, (int, float)):
                        raise ParserClientError("MinerU upload state is incomplete")
                    if time.time() - created_at >= 23 * 3600:
                        state_path.unlink(missing_ok=True)
                        raise RetryableMinerUError(
                            "MinerU upload URL expired; retry to request a new one"
                        )
                    _safe_vendor_url(upload_url, _UPLOAD_HOSTS)
                    with source.open("rb") as handle:
                        upload = self.client.put(upload_url, content=handle)
                    if upload.status_code not in {200, 201, 204}:
                        if upload.status_code in {429, 500, 502, 503, 504}:
                            raise RetryableMinerUError(
                                "MinerU file upload is temporarily unavailable"
                            )
                        raise ParserClientError(
                            f"MinerU file upload returned HTTP {upload.status_code}"
                        )
                    state.pop("upload_url", None)
                    state["uploaded"] = True
                    _write_state(state_path, state)
                elif phase not in {"pending", "running", "converting"}:
                    raise ParserClientError(f"MinerU returned unknown state {phase}")
                if time.monotonic() >= deadline:
                    raise RetryableMinerUError("MinerU task timed out; it can be resumed")
                time.sleep(self.poll_seconds)
        except httpx.TimeoutException:
            raise RetryableMinerUError("MinerU request timed out") from None
        except httpx.TransportError:
            raise RetryableMinerUError("MinerU connection is unavailable") from None
