import { Modal, Notice, Setting, type App } from "obsidian";
import { readWorkbenchSectionConfig, sectionSupportsSort } from "../features/workbench/section-config.js";
import { VaultNoteService } from "./vault-note-service.js";
import type { DashboardSection } from "./dashboard-ui-state.js";
import { TASK_VIEW_LABELS } from "../tasks/task-presentation.js";

export class SectionConfigModal extends Modal {
  private isClosed = false;
  public constructor(app: App, private readonly raw: Record<string, unknown>,
    private readonly save: (config: Record<string, unknown>) => void | Promise<void>,
    private readonly section: DashboardSection = "projects") { super(app); }

  public async onOpen(): Promise<void> {
    this.titleEl.setText("分区范围与展示");
    let config;
    try { config = readWorkbenchSectionConfig(this.raw); }
    catch (error) { this.contentEl.createDiv({ text: String(error) }); return; }
    const draft = { ...this.raw };
    const select = (name: string, key: string, options: Record<string, string>, value: string): void => {
      new Setting(this.contentEl).setName(name).addDropdown((input) =>
        input.addOptions(options).setValue(value).onChange((next) => { draft[key] = next; }));
    };
    if (sectionSupportsSort(this.section)) select("默认排序", "sort", { modified: "最近更新", title: "标题" }, config.sort);
    if (this.section !== "reading") new Setting(this.contentEl).setName(this.section === "today" ? "今日任务预览数" : "每批条目数").addText((input) =>
      input.setValue(String(config.limit)).onChange((value) => { draft.pageSize = Number(value); }));
    if (this.section === "reading" && this.raw.scene !== "daily-updates") new Setting(this.contentEl).setName("每批订阅来源数（1–8）").addText(input =>
      input.setValue(String(config.sourcePageSize)).onChange(value => { draft.sourcePageSize = Number(value); }));
    if (["today", "reading"].includes(this.section)) new Setting(this.contentEl).setName("每日更新与论文的每期预览数").addText(input =>
      input.setValue(String(config.itemsPerEdition)).onChange(value => { draft.itemsPerEdition = Number(value); }));
    let contexts;
    try { contexts = ["reading", "life"].includes(this.section) ? undefined : await new VaultNoteService(this.app).captureContexts(); }
    catch (error) { this.contentEl.createDiv({ text: `无法读取范围：${String(error)}` }); return; }
    if (this.isClosed) return;
    for (const kind of ["course", "project"] as const) {
      if (!contexts) continue;
      const options: Record<string, string> = { "": "不限制" };
      for (const item of kind === "course" ? contexts.courses : contexts.projects) options[item.path.replace(/^\//u, "")] = item.title;
      const current = config[kind] ?? "";
      if (current && !options[current]) options[current] = `${current}（尚未读取到，保留绑定）`;
      select(kind === "course" ? "课程范围" : "项目范围", kind, options, current);
    }
    const status = config.statuses ?? [];
    if (this.section === "projects") select("项目状态", "statusChoice", {
      "": "全部状态", active: "进行中", paused: "已暂停", completed: "已完成", current: "保留当前组合" },
      status.length === 1 ? status[0]! : config.statuses ? "current" : "");
    if (this.section === "reading") {
      if (this.raw.scene !== "daily-updates") select("订阅内容", "readingView", { subscriptions: "来源与历史", "daily-updates": "每日更新" }, config.readingView);
      for (const [stream, label] of [["hotspot", "中国热点"], ["news", "AI 资讯"], ["treehole", "树洞热榜"]]) {
        new Setting(this.contentEl).setName(label!).addToggle(input => input.setValue(!config.feedStreams || config.feedStreams.includes(stream!))
          .onChange(enabled => {
            const streams = new Set((draft.feedStreams as string[] | undefined) ?? ["hotspot", "news", "treehole"]);
            if (enabled) streams.add(stream!); else streams.delete(stream!);
            draft.feedStreams = [...streams];
          }));
      }
    }
    if (this.section === "today") new Setting(this.contentEl).setName("今天包含每日更新").addToggle((input) =>
      input.setValue(config.showDailyUpdates).onChange((value) => { draft.showDailyUpdates = value; }));
    if (this.section === "tasks") {
      select("默认任务视图", "taskView", Object.fromEntries(Object.entries(TASK_VIEW_LABELS).filter(([key]) => !['custom', 'checklists'].includes(key))),
        config.taskView === "overview" ? "all" : config.taskView);
      select("分组", "taskGroupBy", { none: "不分组", date: "截止日期", priority: "优先级", path: "来源笔记", status: "状态" }, String(this.raw.taskGroupBy ?? "none"));
      select("排序", "taskSort", { due: "截止日期", scheduled: "计划日期", priority: "优先级", title: "内容", completion: "完成日期" }, String(this.raw.taskSort ?? "due"));
      for (const [key, label] of [["folders", "包含文件夹"], ["excludeFolders", "排除文件夹"]]) {
        new Setting(this.contentEl).setName(label!).setDesc("每行一个 Vault 文件夹路径；留空不增加限制。")
          .addTextArea(input => input.setValue(((draft[key!] as string[] | undefined) ?? []).join("\n"))
            .onChange(value => { draft[key!] = value.split("\n").map(path => path.trim()).filter(Boolean); }));
      }
    }
    new Setting(this.contentEl).addButton((button) => button.setButtonText("保存").setCta().onClick(async () => {
      const controls = [...this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")];
      try {
        if (draft.statusChoice !== undefined && draft.statusChoice !== "current") {
          draft.statuses = draft.statusChoice ? [draft.statusChoice] : undefined;
        }
        delete draft.statusChoice;
        readWorkbenchSectionConfig(draft);
        draft.pageSize = draft.pageSize ?? config.limit;
        if (["reading", "today"].includes(this.section)) draft.itemsPerEdition = draft.itemsPerEdition ?? config.itemsPerEdition;
        if (this.section === "reading" && this.raw.scene !== "daily-updates") draft.sourcePageSize = draft.sourcePageSize ?? config.sourcePageSize;
        delete draft.mode;
        delete draft.limit;
        controls.forEach(control => { control.disabled = true; });
        await this.save({ ...draft });
        if (!this.isClosed) this.close();
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    }));
  }

  public onClose(): void { this.isClosed = true; this.contentEl.empty(); }
}
