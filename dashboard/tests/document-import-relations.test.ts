import { TFile, type App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocumentImportOptions, DocumentImportResult } from "../src/imports/types.js";
import { DocumentImportModal, type ImportRelationKind } from "../src/plugin/document-import-modal.js";
import { VaultDashboardReader } from "../src/plugin/vault-dashboard.js";
import { VaultNoteService } from "../src/plugin/vault-note-service.js";
import { TestElement } from "./obsidian-runtime.js";

function fixture() {
  const data = new Map<string, string>();
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
    getMarkdownFiles: vi.fn(() => [...files.values()]),
    getFiles: () => [...files.values()],
    adapter: { stat: async (path: string) => files.has(path)
      ? { type: "file" } : folders.has(path) ? { type: "folder" } : null },
    createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, markdown: string) => {
      if (files.has(path)) throw new Error("文件已存在");
      const file = new (TFile as unknown as new (path: string) => TFile)(path);
      files.set(path, file);
      data.set(path, markdown);
      return file;
    },
    cachedRead: async (file: TFile) => data.get(file.path) ?? "",
  };
  const app = { vault } as unknown as App;
  const notes = new VaultNoteService(app);
  const createRelation = vi.fn(async (kind: ImportRelationKind, title: string, slug?: string) =>
    kind === "course" ? notes.createCourse(title, slug) : notes.createProject(title, slug));
  const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
    conversion_id: "fixture", status: "queued", parser: "markitdown",
  }));
  return { app, data, vault, notes, createRelation, importFile };
}

const files = () => [
  { file: new File(["pdf"], "one.pdf"), relativePath: "folder/one.pdf" },
  { file: new File(["word"], "two.docx"), relativePath: "folder/chapter/two.docx" },
];

function content(modal: DocumentImportModal): TestElement {
  return modal.contentEl as unknown as TestElement;
}

function button(modal: DocumentImportModal, label: string): TestElement {
  if (label === "开始导入") return content(modal).descendants().find((item) => item.tagName === "button"
    && ["保存原件", "保存并转换正文", "保存、转换并生成笔记"].includes(item.textContent))!;
  return content(modal).descendants().find((item) => item.tagName === "button" && item.textContent === label)!;
}

function select(modal: DocumentImportModal, label: string): TestElement {
  const field = content(modal).descendants().find((item) => item.tagName === "label"
    && item.children.some((child) => child.textContent === label))!;
  return field.children.find((item) => item.tagName === "select")!;
}

function choose(modal: DocumentImportModal, label: string, value: string): void {
  const input = select(modal, label);
  input.value = value;
  input.dispatch("change");
}

function beginCreation(modal: DocumentImportModal, kind: ImportRelationKind, title: string, slug = "") {
  button(modal, kind === "course" ? "新建课程…" : "新建项目…").click();
  const form = content(modal).descendants().find((item) => item.tagName === "form")!;
  const inputs = form.descendants().filter((item) => item.tagName === "input");
  inputs[0]!.value = title;
  inputs[1]!.value = slug;
  return { form, title: inputs[0]!, slug: inputs[1]!, submit: () => form.dispatch("submit", { preventDefault: vi.fn() }) };
}

afterEach(() => vi.restoreAllMocks());

describe("document import relation creation", () => {
  it("offers course and project creation in an empty Vault", async () => {
    const f = fixture();
    const modal = new DocumentImportModal(f.app, files(), {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    await vi.waitFor(() => expect(content(modal).descendants().some((item) =>
      item.textContent === "还没有课程或项目，可以新建，也可以保持独立资料。")).toBe(true));
    expect(select(modal, "归属").value).toBe("");
    expect(button(modal, "新建课程…").disabled).toBe(false);
    expect(button(modal, "新建项目…").disabled).toBe(false);
    expect(f.importFile).not.toHaveBeenCalled();
  });

  it.each(["course", "project"] as const)("creates and selects a %s while preserving the entire import draft", async (kind) => {
    const f = fixture();
    const draftFiles = files();
    const modal = new DocumentImportModal(f.app, draftFiles, {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    choose(modal, "处理方式", "convert");
    choose(modal, "转换方式", "markitdown-service");
    choose(modal, "转换结果检查", "high");
    const generation = content(modal).descendants().find((item) => item.tagName === "input"
      && item.attributes.get("type") === "checkbox")!;
    (generation as unknown as HTMLInputElement).checked = true;
    generation.dispatch("change");
    const creation = beginCreation(modal, kind, "  医学统计学  ", "  statistics  ");
    expect(button(modal, "开始导入").disabled).toBe(true);
    creation.submit();
    await vi.waitFor(() => expect(select(modal, "归属").value).toBe(`${kind}:statistics`));
    await vi.waitFor(() => expect(button(modal, "开始导入").disabled).toBe(false));
    expect(f.createRelation).toHaveBeenCalledWith(kind, "医学统计学", "statistics");
    expect(f.importFile).not.toHaveBeenCalled();
    expect(select(modal, "处理方式").value).toBe("convert");
    expect(select(modal, "转换方式").value).toBe("markitdown-service");
    expect(select(modal, "转换结果检查").value).toBe("high");
    expect(content(modal).descendants().some((item) => item.textContent.includes("folder/chapter/two.docx"))).toBe(true);
    expect(content(modal).descendants().filter((item) => item.tagName === "form")).toHaveLength(0);
    const path = kind === "course" ? "learning/courses/statistics/course.md" : "projects/statistics/project.md";
    const learning = await new VaultDashboardReader(f.app).learning();
    const created = [...learning.courses, ...learning.projects].find((item) => item.path === path);
    expect(created?.[kind === "course" ? "course_status" : "project_status"]).toBe("active");
    if (kind === "project") expect(f.data.has("projects/statistics/log.md")).toBe(true);
    button(modal, "开始导入").click();
    await vi.waitFor(() => expect(f.importFile).toHaveBeenCalledTimes(2));
    expect(f.importFile.mock.calls.map(([file]) => file)).toEqual(draftFiles.map((item) => item.file));
    for (const [, options] of f.importFile.mock.calls) {
      expect(options).toMatchObject({ [kind]: "statistics", intent: "learn", generate: true,
        method: "markitdown-service", quality: "high" });
      expect(options[kind === "course" ? "project" : "course"]).toBeUndefined();
    }
  });

  it.each(["course", "project"] as const)("cancels %s creation without changing the prior relation or draft", async (kind) => {
    const f = fixture();
    await f.notes.createCourse("原课程", "original");
    const modal = new DocumentImportModal(f.app, files(), { course: "original" }, "learning",
      f.importFile, undefined, f.createRelation);
    modal.open();
    choose(modal, "处理方式", "convert");
    choose(modal, "转换方式", "markitdown-service");
    choose(modal, "转换结果检查", "high");
    beginCreation(modal, kind, "不要创建", "cancelled");
    button(modal, "取消新建").click();
    expect(select(modal, "归属").value).toBe("course:original");
    expect(f.createRelation).not.toHaveBeenCalled();
    expect(f.data.size).toBe(1);
    button(modal, "开始导入").click();
    await vi.waitFor(() => expect(f.importFile).toHaveBeenCalledTimes(2));
    expect(f.importFile.mock.calls.every(([, options]) => options.course === "original"
      && options.method === "markitdown-service" && options.quality === "high")).toBe(true);
  });

  it.each(["course", "project"] as const)("keeps %s creation inputs and the original relation after failure, then retries", async (kind) => {
    const f = fixture();
    f.createRelation.mockRejectedValueOnce(new Error("暂时无法保存"));
    const modal = new DocumentImportModal(f.app, files(), { project: "original" }, "context",
      f.importFile, undefined, f.createRelation);
    modal.open();
    const creation = beginCreation(modal, kind, "医学统计学", "statistics");
    creation.submit();
    await vi.waitFor(() => expect(content(modal).descendants().some((item) => item.textContent === "暂时无法保存")).toBe(true));
    expect(creation.title.value).toBe("医学统计学");
    expect(creation.slug.value).toBe("statistics");
    expect(select(modal, "归属").value).toBe("project:original");
    expect(button(modal, "开始导入").disabled).toBe(true);
    await vi.waitFor(() => expect(button(modal, "创建并选中").disabled).toBe(false));
    creation.submit();
    await vi.waitFor(() => expect(select(modal, "归属").value).toBe(`${kind}:statistics`));
    expect(f.createRelation).toHaveBeenCalledTimes(2);
    expect(f.importFile).not.toHaveBeenCalled();
  });

  it("reports a real course collision and allows a different directory without overwriting the existing note", async () => {
    const f = fixture();
    await f.notes.createCourse("已有课程", "taken");
    const original = f.data.get("learning/courses/taken/course.md");
    const modal = new DocumentImportModal(f.app, files(), {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    const creation = beginCreation(modal, "course", "新课程", "taken");
    creation.submit();
    await vi.waitFor(() => expect(content(modal).descendants().some((item) => item.textContent.includes("课程目录已存在"))).toBe(true));
    await vi.waitFor(() => expect(button(modal, "创建并选中").disabled).toBe(false));
    creation.slug.value = "available";
    creation.submit();
    await vi.waitFor(() => expect(select(modal, "归属").value).toBe("course:available"));
    expect(f.data.get("learning/courses/taken/course.md")).toBe(original);
  });

  it.each(["project:workspace", ""])("preserves a default course and allows explicitly changing to '%s'", async (value) => {
    const f = fixture();
    await f.notes.createCourse("统计学", "statistics");
    await f.notes.createProject("知识库", "workspace");
    const modal = new DocumentImportModal(f.app, files(), { course: "statistics" }, "learning",
      f.importFile, undefined, f.createRelation);
    modal.open();
    await vi.waitFor(() => expect(select(modal, "归属").children.some((item) => item.value === "project:workspace")).toBe(true));
    expect(select(modal, "归属").value).toBe("course:statistics");
    expect(select(modal, "归属").children.map((item) => item.textContent)).toContain("Course：统计学");
    choose(modal, "归属", value);
    button(modal, "开始导入").click();
    await vi.waitFor(() => expect(f.importFile).toHaveBeenCalledTimes(2));
    for (const [, options] of f.importFile.mock.calls) {
      expect(options.course).toBeUndefined();
      expect(options.project).toBe(value ? "workspace" : undefined);
    }
  });

  it("keeps a newly selected relation when an older list request finishes late", async () => {
    const f = fixture();
    const empty = await new VaultDashboardReader(f.app).learning();
    let finish!: (value: typeof empty) => void;
    vi.spyOn(VaultDashboardReader.prototype, "learning").mockImplementationOnce(() =>
      new Promise((resolve) => { finish = resolve; }));
    const modal = new DocumentImportModal(f.app, files(), {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    beginCreation(modal, "course", "统计学", "statistics").submit();
    await vi.waitFor(() => expect(select(modal, "归属").value).toBe("course:statistics"));
    finish(empty);
    await Promise.resolve();
    expect(select(modal, "归属").value).toBe("course:statistics");
    expect(select(modal, "归属").children.some((item) => item.value === "course:statistics")).toBe(true);
  });

  it("prevents duplicate creation and importing while creation is pending, and ignores results after close", async () => {
    const f = fixture();
    let finish!: (value: { path: string }) => void;
    f.createRelation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const modal = new DocumentImportModal(f.app, files(), { course: "original" }, "learning",
      f.importFile, undefined, f.createRelation);
    modal.open();
    const creation = beginCreation(modal, "project", "知识库", "workspace");
    creation.submit();
    creation.submit();
    expect(f.createRelation).toHaveBeenCalledOnce();
    expect(button(modal, "开始导入").disabled).toBe(true);
    expect(button(modal, "取消新建").disabled).toBe(true);
    expect(select(modal, "归属").disabled).toBe(true);
    button(modal, "开始导入").click();
    expect(f.importFile).not.toHaveBeenCalled();
    modal.close();
    finish({ path: "projects/workspace/project.md" });
    await Promise.resolve();
    expect(content(modal).children).toHaveLength(0);
    expect(f.importFile).not.toHaveBeenCalled();
  });

  it("preserves submitted and failed file states through relation creation", async () => {
    const f = fixture();
    f.importFile.mockRejectedValueOnce(new Error("上传暂时不可用"));
    const modal = new DocumentImportModal(f.app, files(), {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    button(modal, "开始导入").click();
    await vi.waitFor(() => expect(button(modal, "重试失败项")).toBeDefined());
    beginCreation(modal, "project", "知识库", "workspace").submit();
    await vi.waitFor(() => expect(select(modal, "归属").value).toBe("project:workspace"));
    await vi.waitFor(() => expect(button(modal, "重试失败项").disabled).toBe(false));
    button(modal, "重试失败项").click();
    await vi.waitFor(() => expect(f.importFile).toHaveBeenCalledTimes(3));
    expect(f.importFile.mock.calls.map(([file]) => file.name)).toEqual(["one.pdf", "two.docx", "one.pdf"]);
    expect(f.importFile.mock.calls[2]![1].project).toBe("workspace");
  });

  it("keeps creation available when reading existing relations fails, and supports reloading", async () => {
    const f = fixture();
    f.vault.getMarkdownFiles.mockImplementationOnce(() => { throw new Error("读取暂时不可用"); });
    const modal = new DocumentImportModal(f.app, files(), {}, "command", f.importFile, undefined, f.createRelation);
    modal.open();
    await vi.waitFor(() => expect(button(modal, "重新读取归属")).toBeDefined());
    expect(button(modal, "新建课程…").disabled).toBe(false);
    button(modal, "重新读取归属").click();
    await vi.waitFor(() => expect(content(modal).descendants().some((item) =>
      item.textContent === "还没有课程或项目，可以新建，也可以保持独立资料。")).toBe(true));
    expect(button(modal, "重新读取归属")).toBeUndefined();
  });
});
