export interface ImportFile {
  file: File;
  relativePath: string;
}

export const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "ppt", "pptx", "png", "jpg", "jpeg", "webp", "bmp", "gif",
]);
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export function isSupportedDocument(file: Pick<File, "name">): boolean {
  return DOCUMENT_EXTENSIONS.has(file.name.split(".").at(-1)?.toLowerCase() ?? "");
}

export function importFilesFromPicker(files: FileList | readonly File[]): ImportFile[] {
  return Array.from(files, (file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function collectEntry(entry: FileSystemEntry, path: string, output: ImportFile[]): Promise<void> {
  const relativePath = path ? `${path}/${entry.name}` : entry.name;
  if (entry.isFile) {
    output.push({ file: await entryFile(entry as FileSystemFileEntry), relativePath });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // Chromium may return only part of a directory in each batch.
  for (;;) {
    const children = await readEntries(reader);
    if (!children.length) break;
    for (const child of children) await collectEntry(child, relativePath, output);
  }
}

export function isExternalFileDrag(transfer: DataTransfer | null): boolean {
  return Boolean(transfer?.types.includes("Files")
    && !transfer.types.includes("application/x-apex-libcard")
    && !transfer.types.includes("application/x-apex-item"));
}

/** Capture entries during the drop event, before the browser protects its data store. */
export function importFilesFromDrop(transfer: DataTransfer): Promise<ImportFile[]> {
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => {
      const compatible = item as DataTransferItem & { getAsEntry?: () => FileSystemEntry | null };
      return compatible.getAsEntry?.() ?? item.webkitGetAsEntry?.() ?? null;
    })
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (!entries.length) return Promise.resolve(importFilesFromPicker(transfer.files));
  return (async () => {
    const result: ImportFile[] = [];
    for (const entry of entries) await collectEntry(entry, "", result);
    return result;
  })();
}

export function bindDocumentDropTarget(
  element: HTMLElement,
  onFiles: (files: ImportFile[]) => void,
  onError: (error: unknown) => void,
): () => void {
  const over = (event: DragEvent): void => {
    if (!isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    element.addClass("okf-document-drop--active");
  };
  const leave = (event: DragEvent): void => {
    const rect = element.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
      element.removeClass("okf-document-drop--active");
    }
  };
  const drop = (event: DragEvent): void => {
    element.removeClass("okf-document-drop--active");
    if (!isExternalFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = importFilesFromDrop(event.dataTransfer!);
    void files.then(onFiles).catch(onError);
  };
  element.addEventListener("dragover", over);
  element.addEventListener("dragleave", leave);
  element.addEventListener("drop", drop);
  return () => {
    element.removeEventListener("dragover", over);
    element.removeEventListener("dragleave", leave);
    element.removeEventListener("drop", drop);
  };
}
