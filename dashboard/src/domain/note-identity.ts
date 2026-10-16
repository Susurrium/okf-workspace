import type { NoteSummary, SourceUse } from "../api/types.js";

export function normalizedVaultPath(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").toLocaleLowerCase();
}

export function sourceUseKey(path: string, use: SourceUse): string {
  return JSON.stringify([normalizedVaultPath(path), use.purpose,
    normalizedVaultPath(use.course), normalizedVaultPath(use.project)]);
}

export function dashboardNoteKey(note: Pick<NoteSummary, "path" | "note_type" | "purpose" | "course" | "project">): string {
  return note.note_type === "Source" && note.purpose
    ? sourceUseKey(note.path, { purpose: note.purpose, course: note.course, project: note.project })
    : normalizedVaultPath(note.path);
}

export function uniqueDashboardNotes<T extends Pick<NoteSummary, "path" | "note_type" | "purpose" | "course" | "project">>(notes: readonly T[]): T[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = dashboardNoteKey(note);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
