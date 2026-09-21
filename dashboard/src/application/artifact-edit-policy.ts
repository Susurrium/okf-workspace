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
    if (mutation.artifactType === "Project") return this.project(mutation);
    if (["Source", "Source Text"].includes(mutation.artifactType)) {
      return {
        outcome: "deny",
        message: "Source 与 Source Text 的身份、配对、uses 和路径由资料工作流管理；请打开条目后使用资料操作。",
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
      return { outcome: "handled", message: "项目状态已通过 Project 动作更新。" };
    }
    return {
      outcome: "deny",
      message: "Project 的身份、受管区域和路径不能在通用数据库中改写；请使用项目详情中的合法动作。",
    };
  }
}
