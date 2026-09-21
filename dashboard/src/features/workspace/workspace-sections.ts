import { Notice } from "obsidian";

import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import type { CourseSummary, NoteSummary } from "../../api/types.js";
import { VaultDashboardReader } from "../../plugin/vault-dashboard.js";

export const OKF_LEARNING_SECTION_TYPE = "workspace-learning";
export const OKF_KNOWLEDGE_SECTION_TYPE = "workspace-knowledge";
export const OKF_INBOX_SECTION_TYPE = "workspace-inbox";

export interface WorkspaceSectionHost {
  openVaultPath(path: string): Promise<void>;
  promptCourse(): void;
  promptLesson(): void;
  promptLessonForCourse(coursePath: string): void;
  setStudyCompleted(path: string, completed: boolean): Promise<{ path: string }>;
  promptWikiFromSources(): void;
  promptCapture(): void;
  promptDocumentImport(): void;
  promptCaptureProject(capturePath: string): void;
  promptCaptureLesson(capturePath: string): void;
  promptRoutePendingSource(path: string, intent: "learn" | "wiki" | "source"): void;
}

export function workspaceSectionCounts(data: {
  pending?: readonly unknown[];
  ready?: readonly unknown[];
  completed?: readonly unknown[];
}): { pending: number; ready: number; completed: number } {
  return {
    pending: data.pending?.length ?? 0,
    ready: data.ready?.length ?? 0,
    completed: data.completed?.length ?? 0,
  };
}

function toolbar(container: HTMLElement, actions: Array<{ label: string; primary?: boolean; run(): void }>): void {
  const element = container.createDiv({ cls: "okf-native-section__toolbar" });
  for (const action of actions) {
    const button = element.createEl("button", {
      cls: action.primary ? "mod-cta" : undefined,
      text: action.label,
      attr: { type: "button" },
    });
    button.addEventListener("click", action.run);
  }
}

function runAction(action: Promise<unknown>): void {
  void action.catch((error: unknown) => {
    new Notice(error instanceof Error ? error.message : "操作失败", 8_000);
  });
}

function group(container: HTMLElement, title: string, count: number): HTMLElement {
  const section = container.createDiv({ cls: "okf-native-section__group" });
  const heading = section.createDiv({ cls: "okf-native-section__group-heading" });
  heading.createSpan({ text: title });
  heading.createSpan({ cls: "okf-native-section__count", text: String(count) });
  return section.createDiv({ cls: "okf-native-section__list" });
}

function noteRow(
  container: HTMLElement,
  note: NoteSummary,
  host: WorkspaceSectionHost,
  actions: Array<{ label: string; run(): void }> = [],
): void {
  const row = container.createDiv({ cls: "okf-native-note" });
  const body = row.createDiv({ cls: "okf-native-note__body" });
  const title = body.createEl("button", {
    cls: "okf-native-note__title",
    text: note.title,
    attr: { type: "button", title: note.path },
  });
  title.addEventListener("click", () => void host.openVaultPath(note.path));
  body.createDiv({ cls: "okf-native-note__meta", text: [note.note_type, note.status, note.stale ? "需要复核" : ""].filter(Boolean).join(" · ") });
  if (note.excerpt) body.createDiv({ cls: "okf-native-note__excerpt", text: note.excerpt });
  if (actions.length > 0) {
    const controls = row.createDiv({ cls: "okf-native-note__actions" });
    for (const action of actions) {
      const button = controls.createEl("button", { text: action.label, attr: { type: "button" } });
      button.addEventListener("click", action.run);
    }
  }
}

function courseRow(container: HTMLElement, course: CourseSummary, host: WorkspaceSectionHost): void {
  noteRow(container, course, host, [
    { label: "新建 Lesson", run: () => host.promptLessonForCourse(course.path) },
  ]);
  const row = container.lastElementChild;
  if (row instanceof HTMLElement) {
    row.querySelector(".okf-native-note__meta")?.append(
      ` · Lesson ${course.lesson_count} · Study Guide ${course.guide_count}`,
    );
  }
}

export function createLearningSectionDefinition(host: WorkspaceSectionHost): CustomSectionDefinition {
  return {
    type: OKF_LEARNING_SECTION_TYPE,
    icon: "graduation-cap",
    label: "学习（OKF）",
    defaultName: "学习",
    async render({ container, app }): Promise<void> {
      toolbar(container, [
        { label: "新建课程", primary: true, run: () => host.promptCourse() },
        { label: "新建 Lesson", run: () => host.promptLesson() },
        { label: "导入资料", run: () => host.promptDocumentImport() },
      ]);
      const data = await new VaultDashboardReader(app).learning();
      const courses = group(container, "课程", data.courses.length);
      for (const course of data.courses) courseRow(courses, course, host);
      const pending = group(container, "待生成", data.pending_guides.length);
      for (const note of data.pending_guides) {
        noteRow(pending, note, host, note.note_type === "Source"
          ? [{ label: "生成学习材料", run: () => host.promptRoutePendingSource(note.path, "learn") }]
          : []);
      }
      const ready = group(container, "待学习", data.ready_guides.length);
      for (const note of data.ready_guides) {
        noteRow(ready, note, host, [{
          label: "标记已学习",
          run: () => runAction(host.setStudyCompleted(note.path, true)),
        }]);
      }
      const completed = group(container, "已学习", data.completed_guides.length);
      for (const note of data.completed_guides.slice(0, 8)) {
        noteRow(completed, note, host, [{
          label: "撤销完成",
          run: () => runAction(host.setStudyCompleted(note.path, false)),
        }]);
      }
    },
  };
}

export function createKnowledgeSectionDefinition(host: WorkspaceSectionHost): CustomSectionDefinition {
  return {
    type: OKF_KNOWLEDGE_SECTION_TYPE,
    icon: "network",
    label: "知识（OKF）",
    defaultName: "知识",
    async render({ container, app }): Promise<void> {
      toolbar(container, [{ label: "从资料创建 Wiki", primary: true, run: () => host.promptWikiFromSources() }]);
      const data = await new VaultDashboardReader(app).knowledge();
      const pending = group(container, "待整理为 Wiki", data.pending_wiki.length);
      for (const note of data.pending_wiki) {
        noteRow(pending, note, host, [{ label: "创建 Wiki", run: () => host.promptRoutePendingSource(note.path, "wiki") }]);
      }
      const notes = group(container, "Wiki / Map", data.notes.length);
      for (const note of data.notes) noteRow(notes, note, host);
    },
  };
}

export function createInboxSectionDefinition(host: WorkspaceSectionHost): CustomSectionDefinition {
  return {
    type: OKF_INBOX_SECTION_TYPE,
    icon: "inbox",
    label: "待处理（OKF）",
    defaultName: "待处理",
    async render({ container, app }): Promise<void> {
      toolbar(container, [
        { label: "快速记录", primary: true, run: () => host.promptCapture() },
        { label: "导入文件", run: () => host.promptDocumentImport() },
      ]);
      const data = await new VaultDashboardReader(app).inbox();
      const captures = group(container, "Capture", data.captures.length);
      for (const note of data.captures) {
        noteRow(captures, note, host, [
          { label: "进入项目", run: () => host.promptCaptureProject(note.path) },
          { label: "转为 Lesson", run: () => host.promptCaptureLesson(note.path) },
        ]);
      }
      const imports = group(container, "待归类资料", data.pending_imports.length);
      for (const note of data.pending_imports) {
        noteRow(imports, note, host, [
          { label: "学习", run: () => host.promptRoutePendingSource(note.path, "learn") },
          { label: "Wiki", run: () => host.promptRoutePendingSource(note.path, "wiki") },
          { label: "仅归档", run: () => host.promptRoutePendingSource(note.path, "source") },
        ]);
      }
    },
  };
}
