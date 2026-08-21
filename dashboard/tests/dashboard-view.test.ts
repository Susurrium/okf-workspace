import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  OkfDashboardView,
  OKF_DASHBOARD_VIEW,
  resolveDashboardLearningSources,
  treeholeMetadata,
} from "../src/plugin/dashboard-view.js";
import { normalizeDashboardUiState } from "../src/plugin/dashboard-ui-state.js";

describe("real Dashboard View source handoff", () => {
  it("constructs the registered runtime View rather than a legacy page model", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);

    expect(view.getViewType()).toBe(OKF_DASHBOARD_VIEW);
    expect(view.getDisplayText()).toBe("Dashboard");
  });

  it("resolves current Source.text files while keeping legacy extracts readable", async () => {
    const paths = [
      "learning/guides/topic.md",
      "sources/records/web/topic.md",
      "sources/text/web/topic.md",
      "sources/extracts/web/legacy-topic.md",
      "sources/text/web/unrelated.md",
    ];
    const files = paths.map((path) =>
      new (TFile as unknown as new (path: string) => TFile)(path));
    const byPath = new Map(files.map((file) => [file.path, file]));
    const frontmatter = new Map<string, Record<string, unknown>>([
      ["learning/guides/topic.md", {
        sources: [{ resource: "/sources/records/web/topic.md" }],
      }],
      ["sources/records/web/topic.md", {
        text: "/sources/text/web/topic.md",
        extract: "/sources/extracts/web/legacy-topic.md",
      }],
    ]);
    const markdown = new Map<string, string>([
      [
        "sources/records/web/topic.md",
        "[正文](/sources/text/web/topic.md)\n[旧摘录](/sources/extracts/web/legacy-topic.md)",
      ],
    ]);
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
        cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
      },
      metadataCache: {
        getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }),
      },
    } as unknown as App;

    expect(await resolveDashboardLearningSources(app, "learning/guides/topic.md")).toEqual([
      "sources/records/web/topic.md",
      "sources/text/web/topic.md",
      "sources/extracts/web/legacy-topic.md",
    ]);
  });

  it("shows TreeHole favorites before likes regardless of payload key order", () => {
    const metadata = treeholeMetadata({
      item_id: "treehole:8466293",
      block_id: "treehole-8466293",
      title: "TreeHole #8466293",
      summary: "",
      source: "TreeHole",
      metrics: {
        like_count: 3,
        reply_count: 15,
        favorite_count: 43,
      },
      comment_count: 0,
      media_count: 0,
    });

    expect(metadata).toBe("回复 15 · 收藏 43 · 点赞 3");
  });
});
