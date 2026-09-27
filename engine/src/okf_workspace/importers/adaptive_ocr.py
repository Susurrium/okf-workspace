"""Page-aware MinerU output and cheap visual signals for selective OCR."""

from __future__ import annotations

import json
import posixpath
import re
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import cast
from xml.etree import ElementTree

from .models import ParserExport

_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_LINK = re.compile(r"\[[^\]]*\]\([^)]+\)")
_PPT = "http://schemas.openxmlformats.org/presentationml/2006/main"
_DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main"
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
_UPLOADABLE_IMAGE_SUFFIXES = _IMAGE_SUFFIXES - {".tif", ".tiff"}


@dataclass(frozen=True, slots=True)
class Page:
    number: int
    markdown: str
    visible_text: str
    images: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SlideImage:
    number: int
    name: str
    data: bytes
    area_fraction: float


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        item.strip() for item in cast(list[object], value)
        if isinstance(item, str) and item.strip()
    ]


def visible_characters(markdown: str) -> int:
    plain = _LINK.sub("", _IMAGE.sub("", markdown))
    plain = re.sub(r"<[^>]*>", "", plain)
    return sum(character.isalnum() for character in plain)


def _render_block(block: dict[str, object], assets: dict[str, bytes]) -> tuple[str, str | None]:
    kind = block.get("type")
    if kind == "image":
        raw = block.get("img_path")
        image = raw if isinstance(raw, str) and raw in assets else None
        parts = [f"![]({image})"] if image else []
        parts.extend(_strings(block.get("image_caption")))
        content = _text(block.get("content"))
        if content:
            parts.append(content)
        parts.extend(_strings(block.get("image_footnote")))
        return "\n\n".join(parts), image
    if kind == "table":
        parts = _strings(block.get("table_caption"))
        body = _text(block.get("table_body"))
        if body:
            parts.append(body)
        parts.extend(_strings(block.get("table_footnote")))
        return "\n\n".join(parts), None
    return _text(block.get("text")) or _text(block.get("content")), None


def read_mineru_pages(archive: Path, export: ParserExport) -> tuple[Page, ...]:
    """Use MinerU's page indices; ignore malformed optional metadata."""
    with zipfile.ZipFile(archive) as bundle:
        candidates = [
            info for info in bundle.infolist()
            if info.filename.endswith("_content_list.json") and info.file_size <= 20_000_000
        ]
        if len(candidates) != 1:
            return ()
        try:
            loaded = cast(object, json.loads(bundle.read(candidates[0])))
        except (ValueError, UnicodeDecodeError):
            return ()
    if not isinstance(loaded, list):
        return ()
    items = cast(list[object], loaded)
    if len(items) > 100_000:
        return ()
    blocks: dict[int, list[dict[str, object]]] = defaultdict(list)
    for raw in items:
        if not isinstance(raw, dict):
            return ()
        block = cast(dict[str, object], raw)
        index = block.get("page_idx")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < 1000:
            return ()
        blocks[index + 1].append(block)
    pages: list[Page] = []
    for number in range(1, max(blocks, default=0) + 1):
        parts: list[str] = []
        images: list[str] = []
        for block in blocks[number]:
            body, image = _render_block(block, export.assets)
            if body:
                parts.append(body)
            if image:
                images.append(image)
        body = "\n\n".join(parts)
        pages.append(Page(number, body, _IMAGE.sub("", body), tuple(images)))
    return tuple(pages)


def page_markdown(
    source: Path, pages: tuple[Page, ...], *, title: str | None = None,
    additions: dict[int, list[str]] | None = None,
) -> str:
    label = "幻灯片" if source.suffix.casefold() in {".ppt", ".pptx"} else "第"
    lines = [f"# {title or source.stem}"]
    for page in pages:
        heading = f"## {label} {page.number}" if label == "幻灯片" else f"## 第 {page.number} 页"
        lines.extend(("", heading, "", page.markdown or "本页未提取到文字；可查看原件。"))
        if additions and page.number in additions:
            lines.extend(("", "\n\n".join(additions[page.number])))
    return "\n".join(lines).rstrip() + "\n"


def pptx_slide_images(source: Path) -> dict[int, tuple[SlideImage, ...]]:
    """Read raster pictures and their displayed area without rendering the deck."""
    if source.suffix.casefold() != ".pptx":
        return {}
    try:
        with zipfile.ZipFile(source) as bundle:
            slide_size = ElementTree.fromstring(bundle.read("ppt/presentation.xml"))
            size = slide_size.find(f"{{{_PPT}}}sldSz")
            if size is None:
                return {}
            width, height = int(size.attrib["cx"]), int(size.attrib["cy"])
            if width <= 0 or height <= 0:
                return {}
            result: dict[int, tuple[SlideImage, ...]] = {}
            numbered_slides = [
                (int(match.group(1)), name)
                for name in bundle.namelist()
                if (match := re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name))
            ]
            slide_names = [name for _, name in sorted(numbered_slides)]
            try:
                presentation_rels = ElementTree.fromstring(
                    bundle.read("ppt/_rels/presentation.xml.rels")
                )
                targets = {
                    entry.attrib["Id"]: posixpath.normpath(
                        posixpath.join("ppt", entry.attrib["Target"])
                    )
                    for entry in presentation_rels.findall(f"{{{_PKG}}}Relationship")
                    if "Id" in entry.attrib and "Target" in entry.attrib
                }
                ordered = [
                    targets[item.attrib[f"{{{_REL}}}id"]]
                    for item in slide_size.findall(f".//{{{_PPT}}}sldId")
                    if item.attrib.get(f"{{{_REL}}}id") in targets
                ]
                if ordered and set(ordered) == set(slide_names):
                    slide_names = ordered
            except (KeyError, zipfile.BadZipFile, ElementTree.ParseError):
                pass
            remaining_bytes = 128_000_000
            for number, slide_name in enumerate(slide_names, start=1):
                slide = ElementTree.fromstring(bundle.read(slide_name))
                try:
                    relationships = ElementTree.fromstring(bundle.read(
                        f"ppt/slides/_rels/{PurePosixPath(slide_name).name}.rels"
                    ))
                except KeyError:
                    result[number] = ()
                    continue
                targets = {
                    entry.attrib["Id"]: entry.attrib["Target"]
                    for entry in relationships.findall(f"{{{_PKG}}}Relationship")
                    if entry.attrib.get("TargetMode") != "External"
                    and "Id" in entry.attrib and "Target" in entry.attrib
                }
                image_metadata: list[tuple[str, float]] = []
                shapes = [
                    *slide.findall(f".//{{{_PPT}}}pic"),
                    *slide.findall(f".//{{{_PPT}}}sp"),
                ]
                for picture in shapes:
                    blip = picture.find(f".//{{{_DRAW}}}blip")
                    extent = picture.find(f".//{{{_DRAW}}}xfrm/{{{_DRAW}}}ext")
                    if blip is None or extent is None:
                        continue
                    target = targets.get(blip.attrib.get(f"{{{_REL}}}embed", ""))
                    if not target:
                        continue
                    path = posixpath.normpath(posixpath.join("ppt/slides", target))
                    if (
                        not path.startswith("ppt/media/")
                        or Path(path).suffix.casefold() not in _IMAGE_SUFFIXES
                    ):
                        continue
                    fraction = min(
                        1.0,
                        int(extent.attrib["cx"]) * int(extent.attrib["cy"]) / (width * height),
                    )
                    image_metadata.append((path, fraction))
                images: list[SlideImage] = []
                for path, fraction in sorted(
                    image_metadata, key=lambda item: item[1], reverse=True,
                )[:4]:
                    try:
                        size = bundle.getinfo(path).file_size
                    except KeyError:
                        continue
                    uploadable = Path(path).suffix.casefold() in _UPLOADABLE_IMAGE_SUFFIXES
                    data = (
                        bundle.read(path)
                        if uploadable and size <= 30_000_000 and size <= remaining_bytes
                        else b""
                    )
                    remaining_bytes -= len(data)
                    images.append(SlideImage(number, PurePosixPath(path).name, data, fraction))
                result[number] = tuple(images)
            return result
    except (OSError, KeyError, ValueError, zipfile.BadZipFile, ElementTree.ParseError):
        return {}
