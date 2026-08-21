"""Build deterministic PDF conversion fixtures."""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).parent
WIDTH, HEIGHT = letter


def _header(pdf: canvas.Canvas, title: str, page: int = 1) -> None:
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(54, HEIGHT - 58, title)
    pdf.setStrokeColor(HexColor("#B8BCC4"))
    pdf.line(54, HEIGHT - 68, WIDTH - 54, HEIGHT - 68)
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(HexColor("#555555"))
    pdf.drawRightString(WIDTH - 54, 34, f"Page {page}")
    pdf.setFillColor(HexColor("#000000"))


def text_pdf() -> None:
    output = ROOT / "text.pdf"
    pdf = canvas.Canvas(str(output), pagesize=letter)
    for page in (1, 2):
        _header(pdf, "Text PDF Fixture", page)
        pdf.setFont("Helvetica", 11)
        y = HEIGHT - 98
        lines = (
            "This page contains directly extractable text for the quick parser.",
            "The complete document must be written to document.md before AI reads it.",
            "Original files are immutable; Source Records preserve provenance.",
            f"Deterministic page marker: TEXT-PAGE-{page}.",
        )
        for line in lines:
            pdf.drawString(64, y, line)
            y -= 24
        pdf.showPage()
    pdf.save()


def scan_pdf() -> None:
    image_path = ROOT / "scan-page.png"
    image = Image.new("RGB", (1500, 2000), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=32)
    draw.rectangle((90, 90, 1410, 1910), outline="#B8BCC4", width=4)
    draw.text((150, 180), "SCANNED DOCUMENT FIXTURE", fill="black", font=font)
    draw.text((150, 300), "OCR must recover this image-only sentence.", fill="black", font=font)
    draw.text((150, 390), "Nonce: SCAN-OCR-20260817", fill="black", font=font)
    image.save(image_path)
    pdf = canvas.Canvas(str(ROOT / "scan.pdf"), pagesize=letter)
    pdf.drawImage(ImageReader(image), 54, 54, WIDTH - 108, HEIGHT - 108, preserveAspectRatio=True)
    pdf.save()


def two_column_pdf() -> None:
    pdf = canvas.Canvas(str(ROOT / "two-column.pdf"), pagesize=letter)
    _header(pdf, "Two-column and Footnote Fixture")
    columns = (
        (
            "Left column",
            [
                "Routing policy should have one authority.",
                "A parser should preserve reading order.",
                "Column marker: LEFT-COLUMN-END.",
            ],
        ),
        (
            "Right column",
            [
                "Synchronization propagates deletions.",
                "Independent backups remain necessary.[1]",
                "Column marker: RIGHT-COLUMN-END.",
            ],
        ),
    )
    for index, (title, lines) in enumerate(columns):
        x = 54 + index * 258
        pdf.setFont("Helvetica-Bold", 13)
        pdf.drawString(x, HEIGHT - 108, title)
        pdf.setFont("Helvetica", 10)
        y = HEIGHT - 136
        for _ in range(8):
            for line in lines:
                pdf.drawString(x, y, line)
                y -= 18
            y -= 8
    pdf.setStrokeColor(HexColor("#B8BCC4"))
    pdf.line(54, 70, WIDTH - 54, 70)
    pdf.setFont("Helvetica", 8)
    pdf.drawString(54, 56, "[1] A synchronization replica is not a historical recovery copy.")
    pdf.save()


def formula_pdf() -> None:
    pdf = canvas.Canvas(str(ROOT / "formula.pdf"), pagesize=letter)
    _header(pdf, "Formula and Chart Fixture")
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(64, HEIGHT - 110, "Formula")
    pdf.setFont("Times-Roman", 18)
    pdf.drawString(64, HEIGHT - 145, "score = alpha * interest + beta * long_term_value")
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(64, HEIGHT - 205, "Quarterly evidence chart")
    origin_x, origin_y = 94, 220
    pdf.setStrokeColor(HexColor("#333333"))
    pdf.line(origin_x, origin_y, origin_x, origin_y + 250)
    pdf.line(origin_x, origin_y, origin_x + 400, origin_y)
    for index, (label, value) in enumerate((("Q1", 42), ("Q2", 68), ("Q3", 81))):
        x = origin_x + 70 + index * 110
        height = value * 2.5
        pdf.setFillColor(HexColor("#3D8DFF"))
        pdf.rect(x, origin_y, 52, height, fill=1, stroke=0)
        pdf.setFillColor(HexColor("#000000"))
        pdf.setFont("Helvetica", 10)
        pdf.drawCentredString(x + 26, origin_y - 18, label)
        pdf.drawCentredString(x + 26, origin_y + height + 8, str(value))
    pdf.save()


def build() -> None:
    text_pdf()
    scan_pdf()
    two_column_pdf()
    formula_pdf()
    shutil.copyfile(ROOT / "text.pdf", ROOT / "duplicate.pdf")
    (ROOT / "broken.pdf").write_bytes(b"%PDF-1.7\nBROKEN-NO-XREF\n")


if __name__ == "__main__":
    build()
    print(ROOT)
