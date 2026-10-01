"""Small conversion-method catalogue; no probes or remote starts on reads."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from .config import ImportSettings
from .models import ConversionMethod
from .routing import METHOD_EXTENSIONS

METHOD_LABELS = {
    ConversionMethod.MINERU_CLOUD: "MinerU 云解析",
    ConversionMethod.MARKITDOWN_SERVICE: "MarkItDown",
    ConversionMethod.MINERU_SELF_HOSTED: "MinerU 自建服务",
}


def _token_present(path: Path | None) -> bool:
    try:
        return bool(path and path.is_file() and path.stat().st_size > 0)
    except OSError:
        return False


def method_catalogue(settings: ImportSettings) -> dict[str, object]:
    methods: list[dict[str, object]] = []
    for method in ConversionMethod:
        cloud = method is ConversionMethod.MINERU_CLOUD
        markitdown = method is ConversionMethod.MARKITDOWN_SERVICE
        endpoint = "https://mineru.net" if cloud else (
            settings.markitdown_url if markitdown else settings.mineru_url
        )
        enabled = method is not ConversionMethod.MINERU_SELF_HOSTED or (
            settings.mineru_self_hosted_enabled
        )
        configured = enabled and (
            _token_present(settings.mineru_token_file) if cloud else
            _token_present(settings.markitdown_token_file) if markitdown else True
        )
        location = (
            "MinerU 官方云端" if cloud else
            f"SSH：{settings.mineru_ssh_host}" if not markitdown and settings.mineru_ssh_managed
            else "本机" if urlsplit(endpoint).hostname in {"localhost", "127.0.0.1", "::1"}
            else urlsplit(endpoint).netloc
        )
        limitations = (
            "公式、表格和 OCR 为机器解析，仍需复核。" if cloud else
            "PDF 只提取文本，不提取图片；DOCX/PPTX 提取内嵌图片，不提供 OCR。"
            if markitdown else
            "当前开放 PDF/PPT/PPTX；PPTX 不执行云端的图片补充 OCR。"
        )
        reason = (
            "请启用并配置自建 MinerU 服务" if not enabled else
            "请配置 MinerU token 文件" if cloud and not configured else
            "请配置 MarkItDown token 文件和服务地址" if markitdown and not configured else ""
        )
        methods.append({
            "id": method.value, "label": METHOD_LABELS[method],
            "parser": method.parser.value, "enabled": enabled, "configured": configured,
            "status": "configured" if configured else "not-configured",
            "location": location, "reason": reason, "limitations": limitations,
            "extensions": sorted(METHOD_EXTENSIONS[method]),
            "max_upload_bytes": 64 * 1024 * 1024,
            "capabilities": {
                "ocr": cloud or not markitdown,
                "page_map": cloud,
                "pdf_images": not markitdown,
                "office_images": True,
            },
        })
    return {"default_method": settings.default_conversion_method.value, "methods": methods}
