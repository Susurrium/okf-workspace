import { describe, expect, it } from "vitest";

import {
  importFilesFromDrop,
  importFilesFromPicker,
  isExternalFileDrag,
  isSupportedDocument,
  MAX_DOCUMENT_BYTES,
} from "../src/imports/drop.js";

function fileEntry(name: string): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success: (file: File) => void) => success(new File([name], name)),
  } as FileSystemFileEntry;
}

function directoryEntry(name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (success: (entries: FileSystemEntry[]) => void) => success(batches.shift() ?? []),
    }),
  } as FileSystemDirectoryEntry;
}

describe("document folder drop", () => {
  it("reads every directory batch and preserves nested paths", async () => {
    const nested = directoryEntry("chapter", [[fileEntry("slides.pptx")], []]);
    const root = directoryEntry("course", [
      [fileEntry("intro.pdf")],
      [nested, fileEntry("notes.txt")],
      [],
    ]);
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => root }],
      files: [],
    } as unknown as DataTransfer;

    const files = await importFilesFromDrop(transfer);

    expect(files.map((item) => item.relativePath)).toEqual([
      "course/intro.pdf", "course/chapter/slides.pptx", "course/notes.txt",
    ]);
    expect(files.map((item) => isSupportedDocument(item.file))).toEqual([true, true, false]);
  });

  it("uses flat files when directory entries are unavailable", async () => {
    const file = new File(["pdf"], "paper.pdf");
    const transfer = { items: [], files: [file] } as unknown as DataTransfer;
    expect(await importFilesFromDrop(transfer)).toEqual([{ file, relativePath: "paper.pdf" }]);
    expect(importFilesFromPicker([file])).toEqual([{ file, relativePath: "paper.pdf" }]);
    expect(MAX_DOCUMENT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("accepts courseware images for OCR", () => {
    expect(isSupportedDocument(new File(["image"], "figure.PNG"))).toBe(true);
    expect(isSupportedDocument(new File(["image"], "figure.tiff"))).toBe(false);
  });

  it("does not capture internal Apex drags", () => {
    expect(isExternalFileDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(isExternalFileDrag({ types: ["Files", "application/x-apex-item"] } as unknown as DataTransfer)).toBe(false);
    expect(isExternalFileDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
  });
});
