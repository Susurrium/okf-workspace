/** Presentation names only. Persisted artifact types and status values stay unchanged. */
const NOTE_TYPES: Readonly<Record<string, string>> = {
  Capture: "随手记录", Course: "课程", Lesson: "课堂笔记", Project: "项目",
  "Study Guide": "学习笔记", Source: "资料", "Source Text": "资料正文",
  Wiki: "知识笔记", "Wiki Map": "知识导航", Daily: "日记", Reflection: "反思",
  Review: "复盘", Decision: "项目决策", Digest: "订阅汇总", Profile: "个人资料",
  "System View": "系统视图",
};

export function noteTypeLabel(type: string): string {
  return NOTE_TYPES[type] ?? type;
}

export function noteStatusLabel(status?: string | null): string {
  if (!status || status === "stable") return "";
  return ({ draft: "草稿", deprecated: "已弃用", active: "进行中", paused: "已暂停", completed: "已完成" } as Record<string, string>)[status] ?? status;
}

export function captureDestinationLabel(destination: string): string {
  return ({ lesson: "课堂笔记", "project-log": "项目日志", reflection: "反思", "study-guide": "学习笔记", wiki: "知识笔记" } as Record<string, string>)[destination] ?? "待整理记录";
}
