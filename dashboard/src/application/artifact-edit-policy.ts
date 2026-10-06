import type {
  ArtifactMutation,
  ArtifactMutationResult,
} from "../../apex/src/host.js";

export interface ManagedArtifactActions {
  setProjectStatus(
    path: string,
    status: "active" | "paused" | "completed",
  ): Promise<unknown>;
}

const PROJECT_STATUSES = new Set(["active", "paused", "completed"]);

/** Contract-aware boundary for generic Apex database and kanban writes. */
export class ArtifactEditPolicy {
  public constructor(private readonly actions: ManagedArtifactActions) {}

  public async mutate(mutation: ArtifactMutation): Promise<ArtifactMutationResult> {
    if (["Document Import Request", "Document Import Receipt"].includes(mutation.artifactType)) {
      return { outcome: "deny", message: "资料申请和回执不能在表格中修改；更改处理选择请重新提交资料。" };
    }
    if (mutation.artifactType === "Project") return this.project(mutation);
    if (["Source", "Source Text"].includes(mutation.artifactType)) {
      return {
        outcome: "deny",
        message: "这些资料属性不能在表格中修改，请打开资料详情后操作。",
      };
    }
    return { outcome: "allow" };
  }

  private async project(mutation: ArtifactMutation): Promise<ArtifactMutationResult> {
    if (
      mutation.kind === "frontmatter" &&
      mutation.property === "project_status" &&
      typeof mutation.value === "string" &&
      PROJECT_STATUSES.has(mutation.value)
    ) {
      await this.actions.setProjectStatus(
        mutation.path,
        mutation.value as "active" | "paused" | "completed",
      );
      return { outcome: "handled", message: "项目状态已更新。" };
    }
    return {
      outcome: "deny",
      message: "这些项目属性不能在表格中修改，请在项目详情中操作。",
    };
  }
}
