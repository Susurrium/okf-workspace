import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "slides.pptx");
const renderDir = path.join(root, "rendered-slides");
const imagePath = path.join(root, "presentation-icon.png");

async function writeBlob(target, blob) {
  await fs.writeFile(target, new Uint8Array(await blob.arrayBuffer()));
}

function addText(slide, name, text, position, style) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = style;
  return shape;
}

async function build() {
  await fs.mkdir(renderDir, { recursive: true });
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });

  const cover = presentation.slides.add();
  cover.background.fill = "#FFFFFF";
  addText(
    cover,
    "cover-eyebrow",
    "OKF BRAIN TEST FIXTURE",
    { left: 41, top: 41, width: 600, height: 50 },
    { fontSize: 24, bold: true, typeface: "Arial", color: "#000000" },
  );
  addText(
    cover,
    "cover-title",
    "PowerPoint conversion\nkeeps useful structure",
    { left: 41, top: 180, width: 1000, height: 250 },
    { fontSize: 60, bold: true, typeface: "Arial", color: "#000000" },
  );
  addText(
    cover,
    "cover-subtitle",
    "Title, bullets, speaker notes, and one embedded raster image.",
    { left: 41, top: 500, width: 760, height: 90 },
    { fontSize: 24, typeface: "Arial", color: "#333333" },
  );
  cover.speakerNotes.textFrame.setText(
    "Fixture purpose: verify title extraction and speaker-note preservation.\n[Sources]\n- OKF Brain local deterministic test data.",
  );

  const content = presentation.slides.add();
  content.background.fill = "#FFFFFF";
  addText(
    content,
    "content-title",
    "A complete import preserves four signals",
    { left: 41, top: 36, width: 1197, height: 100 },
    { fontSize: 38, bold: true, typeface: "Arial", color: "#000000" },
  );
  addText(
    content,
    "content-bullets",
    "• Slide titles and reading order\n• Separate bullet items\n• Speaker notes for context\n• Embedded image assets",
    { left: 41, top: 212, width: 560, height: 330 },
    { fontSize: 28, typeface: "Arial", color: "#000000" },
  );
  content.shapes.add({
    geometry: "roundRect",
    name: "image-panel",
    position: { left: 700, top: 176, width: 500, height: 390 },
    fill: "#EAF5FB",
    line: { style: "solid", fill: "#B8BCC4", width: 1 },
    borderRadius: 12,
  });
  const imageBytes = await fs.readFile(imagePath);
  content.images.add({
    blob: imageBytes,
    contentType: "image/png",
    alt: "Local presentation file icon used as a deterministic raster fixture",
    fit: "contain",
    geometry: "rect",
    position: { left: 858, top: 280, width: 184, height: 184 },
  });
  addText(
    content,
    "page-number",
    "2",
    { left: 1184, top: 659, width: 55, height: 25 },
    { fontSize: 14, typeface: "Arial", color: "#000000", alignment: "right" },
  );
  content.speakerNotes.textFrame.setText(
    "Verify that MarkItDown includes this note in the converted output.\n[Sources]\n- Built-in presentation icon, local runtime bundle.",
  );

  for (const [index, slide] of presentation.slides.items.entries()) {
    await writeBlob(
      path.join(renderDir, `slide-${String(index + 1).padStart(2, "0")}.png`),
      await presentation.export({ slide, format: "png", scale: 1 }),
    );
    await fs.writeFile(
      path.join(renderDir, `slide-${String(index + 1).padStart(2, "0")}.layout.json`),
      await (await slide.export({ format: "layout" })).text(),
    );
  }
  await writeBlob(
    path.join(renderDir, "montage.webp"),
    await presentation.export({ format: "webp", montage: true, scale: 1 }),
  );
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(output);
  return output;
}

build()
  .then((result) => process.stdout.write(`${result}\n`))
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
