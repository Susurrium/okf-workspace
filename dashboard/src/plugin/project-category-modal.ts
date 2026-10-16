import { Modal, Setting, type App } from "obsidian";
import type { ProjectSummary } from "../api/types.js";
import { projectCategory } from "../domain/project-organization.js";
import { VaultNoteService } from "./vault-note-service.js";

export class ProjectCategoryModal extends Modal {
  public constructor(app: App, private readonly projects: readonly ProjectSummary[],
    private readonly changed: () => void, private readonly projectPath?: string) { super(app); }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal");
    this.titleEl.setText(this.projectPath ? "项目类别" : "管理项目类别");
    const note = this.projectPath ? this.projects.find(project => project.path === this.projectPath) : undefined;
    if (this.projectPath && !note) throw new Error("项目已经变化，请重新打开");
    const categories = [...new Set(this.projects.map(project => projectCategory(project.project_category)).filter((value): value is string => value !== null))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    let from = categories[0] ?? "";
    let value = note ? projectCategory(note.project_category) ?? "" : from;
    if (note) this.contentEl.createEl("p", { text: note.title });
    else this.contentEl.createEl("p", { text: "选择类别后，下方列出所有受影响的项目，包括已暂停和已完成项目。项目文件及关联保持原位置。" });
    if (!note && !categories.length) {
      this.contentEl.createEl("p", { text: "尚无已分类项目。可以在项目的“类别”操作中输入新类别。" });
      return;
    }
    const preview = this.contentEl.createDiv({ cls: "okf-project-category-preview" });
    const results = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    let editInput: HTMLInputElement | undefined;
    const targets = (): ProjectSummary[] => note ? [note] : this.projects.filter(project => projectCategory(project.project_category) === from);
    const repaint = (): void => {
      preview.empty();
      const next = projectCategory(value);
      results.empty();
      const merge = next && next !== from && categories.includes(next);
      preview.createEl("p", { text: `${targets().length} 个项目 → ${next ?? "未分类"}${merge ? "（合并到已有类别）" : ""}` });
      const list = preview.createEl("ul");
      for (const project of targets()) list.createEl("li", { text: `${project.title} · ${project.path}` });
    };
    if (!note) new Setting(this.contentEl).setName("原类别").addDropdown(dropdown => {
      for (const name of categories) dropdown.addOption(name, name);
      dropdown.setValue(from).onChange(next => {
        from = next; value = next;
        if (editInput) editInput.value = next;
        repaint();
      });
    });
    const listId = `okf-project-categories-${crypto.randomUUID()}`;
    const suggestions = this.contentEl.createEl("datalist", { attr: { id: listId } });
    for (const category of categories) suggestions.createEl("option", { attr: { value: category } });
    new Setting(this.contentEl).setName(note ? "类别" : "新的类别名称").setDesc("可选择已有名称或输入新名称；留空清除分类，最多 80 个字符。")
      .addText(input => {
        editInput = input.inputEl;
        input.inputEl.setAttribute("list", listId);
        input.inputEl.setAttribute("maxlength", "160");
        input.setValue(value).onChange(next => {
          value = next;
          try { repaint(); } catch (error) { results.setText(String(error)); }
        });
      });
    this.contentEl.appendChild(preview);
    this.contentEl.appendChild(results);
    repaint();
    new Setting(this.contentEl).addButton(button => button.setButtonText(note ? "保存类别" : "修改列出的项目").setCta().onClick(async () => {
      const controls = [...this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")];
      controls.forEach(control => { control.disabled = true; });
      results.empty();
      try {
        const next = projectCategory(value);
        const service = new VaultNoteService(this.app);
        if (note) {
          await service.setProjectCategory(note.path, next, projectCategory(note.project_category));
          this.changed(); this.close();
        } else {
          const outcome = await service.renameProjectCategory(targets().map(project => project.path), from, next);
          const failed = outcome.filter(item => item.error);
          results.createEl("p", { text: `已完成 ${outcome.length - failed.length} 项，失败 ${failed.length} 项。` });
          for (const item of failed) results.createDiv({ text: `${item.path}：${item.error}` });
          this.changed();
          if (!failed.length) this.close();
        }
      } catch (error) { results.setText(error instanceof Error ? error.message : String(error)); }
      finally { controls.forEach(control => { control.disabled = false; }); }
    }));
  }
}
