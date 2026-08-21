export const CHINESE_CALENDAR_PLUGIN_ID = "chinese-calendar";
export const CHINESE_CALENDAR_VIEW_TYPE = "chinese-calendar-view";
export const CHINESE_CALENDAR_COMMAND_ID = "chinese-calendar:show-chinese-calendar-view";

export interface ChineseCalendarHost<TLeaf> {
  leaves(): readonly TLeaf[];
  reveal(leaf: TLeaf): Promise<void>;
  executeCreateCommand(): boolean;
  pluginEnabled?: boolean;
  afterCreate?(): Promise<void>;
  creationAttempts?: number;
}

export type ChineseCalendarOpenResult = "revealed" | "created";

/** Reveal the existing calendar tab first; only ask the plugin to create one when absent. */
export async function showChineseCalendar<TLeaf>(
  host: ChineseCalendarHost<TLeaf>,
): Promise<ChineseCalendarOpenResult> {
  const existing = host.leaves()[0];
  if (existing !== undefined) {
    await host.reveal(existing);
    return "revealed";
  }
  if (host.pluginEnabled === false) {
    throw new Error("Chinese Calendar 未启用，请先在第三方插件中启用它");
  }
  if (!host.executeCreateCommand()) {
    throw new Error(
      host.pluginEnabled
        ? "Chinese Calendar 已启用，但创建日历视图的命令不可用；请重载该插件"
        : "Chinese Calendar 未安装、未启用或命令不可用",
    );
  }
  const attempts = Math.max(1, host.creationAttempts ?? 20);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await host.afterCreate?.();
    const created = host.leaves()[0];
    if (created === undefined) continue;
    await host.reveal(created);
    return "created";
  }
  throw new Error("Chinese Calendar 创建命令已执行，但日历视图没有出现；请重载该插件后重试");
}
