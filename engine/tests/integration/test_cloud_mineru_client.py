from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import httpx
import pytest

from okf_workspace.importers.clients import ParserClientError
from okf_workspace.importers.cloud_mineru import CloudMinerUClient, RetryableMinerUError
from okf_workspace.importers.models import ImportIntent, ImportRequest, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault


def _zip_result() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        bundle.writestr(
            "report/full.md",
            "# Cloud result\n\nA complete parsed document with an image.\n\n"
            "![a](images/a.png)\n",
        )
        bundle.writestr("report/images/a.png", b"image bytes")
        bundle.writestr("report/readme.md", "# Auxiliary notes\n" + "not the document\n" * 100)
    return output.getvalue()


def _working(tmp_path: Path) -> tuple[Path, Path, Path]:
    source = tmp_path / "original.pdf"
    source.write_bytes(b"%PDF-1.7 fixture")
    working = tmp_path / "conversion" / "working"
    working.mkdir(parents=True)
    (working.parent / "status.json").write_text("{}", encoding="utf-8")
    token = tmp_path / "mineru.token"
    token.write_text("fixture-secret", encoding="utf-8")
    return source, working, token


def test_cloud_upload_poll_download_and_resume_without_resubmission(tmp_path: Path) -> None:
    source, working, token = _working(tmp_path)
    calls: list[str] = []
    poll_count = 0
    upload_url = "https://mineru.oss-cn-shanghai.aliyuncs.com/upload?Signature=secret"
    result_url = "https://cdn-mineru.openxlab.org.cn/result.zip"

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal poll_count
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/api/v4/file-urls/batch":
            assert request.headers["authorization"] == "Bearer fixture-secret"
            assert json.loads(request.content)["model_version"] == "vlm"
            return httpx.Response(200, json={"code": 0, "data": {
                "batch_id": "batch-1", "file_urls": [upload_url],
            }})
        if request.url.path == "/api/v4/extract-results/batch/batch-1":
            poll_count += 1
            if poll_count == 2:
                return httpx.Response(503)
            phase = "waiting-file" if poll_count == 1 else "done"
            item = {"state": phase, "full_zip_url": result_url}
            return httpx.Response(200, json={"code": 0, "data": {"extract_result": [item]}})
        if request.method == "PUT":
            assert request.content == source.read_bytes()
            assert "authorization" not in request.headers
            return httpx.Response(200)
        if request.url.path == "/result.zip":
            return httpx.Response(200, content=_zip_result())
        raise AssertionError(request.url)

    client = CloudMinerUClient(
        token, client=httpx.Client(transport=httpx.MockTransport(respond)), poll_seconds=0,
    )
    with pytest.raises(RetryableMinerUError):
        client.convert(source, working)
    state = json.loads((working / "cloud-mineru.json").read_text(encoding="utf-8"))
    assert state["batch_id"] == "batch-1"
    assert "upload_url" not in state
    assert "fixture-secret" not in json.dumps(state)

    result = client.convert(source, working)
    assert result.parser is ParserName.MINERU
    assert result.parser_version == "cloud-v4/vlm"
    assert result.markdown.startswith("# Cloud result")
    assert result.assets["images/a.png"] == b"image bytes"
    assert calls.count("POST /api/v4/file-urls/batch") == 1
    assert calls.count("PUT /upload") == 1


def test_cloud_rejects_untrusted_upload_url(tmp_path: Path) -> None:
    source, working, token = _working(tmp_path)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v4/file-urls/batch"
        return httpx.Response(200, json={"code": 0, "data": {
            "batch_id": "batch-1", "file_urls": ["https://example.com/upload"],
        }})

    client = CloudMinerUClient(token, client=httpx.Client(transport=httpx.MockTransport(respond)))
    with pytest.raises(ParserClientError, match="untrusted"):
        client.convert(source, working)
    assert not (working / "cloud-mineru.json").exists()


def test_cloud_auth_failure_is_terminal_and_does_not_echo_token(tmp_path: Path) -> None:
    source, working, token = _working(tmp_path)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v4/file-urls/batch"
        return httpx.Response(200, json={"code": "A0202", "msg": "invalid token"})

    client = CloudMinerUClient(token, client=httpx.Client(transport=httpx.MockTransport(respond)))
    with pytest.raises(ParserClientError) as captured:
        client.convert(source, working)
    assert "A0202" in str(captured.value)
    assert "fixture-secret" not in str(captured.value)


def _page_zip(*, ocr: bool) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        if ocr:
            bundle.writestr("full.md", "DNA → RNA → Protein\n\n图中说明转录和翻译的关系。")
        else:
            bundle.writestr(
                "full.md", "# 课程\n\n第一张有大量原生文字。\n\n![](images/diagram.png)",
            )
            bundle.writestr("images/diagram.png", b"PNG fixture")
            bundle.writestr("result_content_list.json", json.dumps([
                {"type": "text", "text": "第一张有大量原生文字。" * 8, "page_idx": 0},
                {"type": "text", "text": "生命信息流", "page_idx": 1},
                {"type": "image", "img_path": "images/diagram.png", "page_idx": 1},
            ], ensure_ascii=False))
    return output.getvalue()


@pytest.mark.parametrize("extension", [".pdf", ".pptx"])
def test_cloud_selectively_ocr_sparse_visual_page(
    tmp_path: Path, extension: str,
) -> None:
    source, working, token = _working(tmp_path)
    source = source.rename(source.with_suffix(extension))
    if extension == ".pptx":
        with zipfile.ZipFile(source, "w") as bundle:
            bundle.writestr(
                "ppt/presentation.xml",
                '<p:presentation xmlns:p="http://schemas.openxmlformats.org/'
                'presentationml/2006/main"><p:sldSz cx="1000" cy="1000"/>'
                "</p:presentation>",
            )
            bundle.writestr(
                "ppt/slides/slide1.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
            )
            bundle.writestr(
                "ppt/slides/_rels/slide1.xml.rels",
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                'relationships"/>',
            )
            bundle.writestr(
                "ppt/slides/slide2.xml",
                '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<p:pic><a:blip r:embed="rId1"/><a:xfrm><a:ext cx="900" cy="900"/>'
                "</a:xfrm></p:pic></p:sld>",
            )
            bundle.writestr(
                "ppt/slides/_rels/slide2.xml.rels",
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                'relationships"><Relationship Id="rId1" Target="../media/diagram.png"/>'
                "</Relationships>",
            )
            bundle.writestr("ppt/media/diagram.png", b"original PNG bytes")
    token.write_text("fixture-secret", encoding="utf-8")
    requests: list[dict[str, object]] = []
    uploads: list[str] = []
    pending: dict[str, bool] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v4/file-urls/batch":
            payload = json.loads(request.content)
            file = payload["files"][0]
            requests.append(file)
            batch = f"batch-{len(requests)}"
            pending[batch] = bool(file["is_ocr"])
            return httpx.Response(200, json={"code": 0, "data": {
                "batch_id": batch,
                "file_urls": [f"https://mineru.oss-cn-shanghai.aliyuncs.com/{batch}"],
            }})
        if path.startswith("/api/v4/extract-results/batch/"):
            batch = path.rsplit("/", 1)[1]
            state = "done" if batch in uploads else "waiting-file"
            return httpx.Response(200, json={"code": 0, "data": {"extract_result": [{
                "state": state,
                "full_zip_url": f"https://cdn-mineru.openxlab.org.cn/{batch}.zip",
            }]}})
        if request.method == "PUT":
            uploads.append(path.lstrip("/"))
            return httpx.Response(200)
        if path.endswith(".zip"):
            batch = path.lstrip("/").removesuffix(".zip")
            return httpx.Response(200, content=_page_zip(ocr=pending[batch]))
        raise AssertionError(request.url)

    client = CloudMinerUClient(
        token, client=httpx.Client(transport=httpx.MockTransport(respond)), poll_seconds=0,
    )
    result = client.convert(source, working)
    assert len(requests) == 2
    assert requests[0]["is_ocr"] is False
    assert requests[1]["is_ocr"] is True
    if extension == ".pdf":
        assert requests[1]["page_ranges"] == "2"
    else:
        assert str(requests[1]["name"]).endswith(".png")
        assert result.assets["images/source-slide-2-1.png"] == b"original PNG bytes"
    expected_heading = "## 幻灯片 2" if extension == ".pptx" else "## 第 2 页"
    assert expected_heading in result.markdown
    assert "第一张有大量原生文字" in result.markdown
    assert "图片 OCR 文字" in result.markdown
    assert "图中说明转录和翻译的关系" in result.markdown
    if extension == ".pdf":
        vault = initialize_vault(tmp_path / "vault")
        importer = DocumentImporter(
            vault=vault,
            originals=tmp_path / "originals",
            state=tmp_path / "state",
            clients={ParserName.MINERU: client},
        )
        imported = importer.import_document(
            ImportRequest(source=source, intent=ImportIntent.SOURCE)
        )
        assert imported.source_text is not None
        published = read_document(imported.source_text)
        assert "## 第 2 页" in published.body
        assert "图中说明转录和翻译的关系" in published.body
        assert "sources/assets/" in published.body


def test_cloud_opens_ocr_for_standalone_image(tmp_path: Path) -> None:
    source, working, token = _working(tmp_path)
    image = source.with_suffix(".png")
    image.write_bytes(b"image input")
    requests: list[dict[str, object]] = []
    uploaded = False

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal uploaded
        if request.url.path == "/api/v4/file-urls/batch":
            requests.append(json.loads(request.content)["files"][0])
            return httpx.Response(200, json={"code": 0, "data": {
                "batch_id": "image-batch",
                "file_urls": ["https://mineru.oss-cn-shanghai.aliyuncs.com/upload"],
            }})
        if request.url.path.endswith("/image-batch"):
            return httpx.Response(200, json={"code": 0, "data": {"extract_result": [{
                "state": "done" if uploaded else "waiting-file",
                "full_zip_url": "https://cdn-mineru.openxlab.org.cn/image.zip",
            }]}})
        if request.method == "PUT":
            uploaded = True
            return httpx.Response(200)
        if request.url.path == "/image.zip":
            return httpx.Response(200, content=_page_zip(ocr=True))
        raise AssertionError(request.url)

    client = CloudMinerUClient(
        token, client=httpx.Client(transport=httpx.MockTransport(respond)), poll_seconds=0,
    )
    result = client.convert(image, working)

    assert len(requests) == 1
    assert requests[0]["is_ocr"] is True
    assert result.assets["images/original.png"] == b"image input"
    assert "![原始图片](images/original.png)" in result.markdown
