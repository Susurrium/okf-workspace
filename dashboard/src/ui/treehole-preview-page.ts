import type {
  FeedComment,
  TreeholeBatchPreview,
  TreeholePreviewItem,
} from "../feeds/types.js";
import type { OpenedFeedDigest } from "../feeds/service.js";

export interface TreeholePreviewCard {
  pid: number;
  title: string;
  body: string;
  metrics: Readonly<Record<string, number | string>>;
  media: readonly string[];
  comments: readonly FeedComment[];
  commentsFolded: true;
}

export interface TreeholePreviewPageOptions {
  batches: readonly TreeholeBatchPreview[];
  openInObsidian(snapshotId: string, pid?: number): Promise<OpenedFeedDigest>;
}

/** V1 snapshot/body/metrics/media view, now including folded comments. */
export class TreeholePreviewPage {
  private snapshotId: string;

  public constructor(private readonly options: TreeholePreviewPageOptions) {
    const initial = options.batches[0];
    if (!initial) throw new Error("TreeHole preview page requires at least one snapshot");
    this.snapshotId = initial.digest_id;
  }

  public select(snapshotId: string): void {
    if (!this.options.batches.some((batch) => batch.digest_id === snapshotId)) {
      throw new Error("TreeHole snapshot does not exist");
    }
    this.snapshotId = snapshotId;
  }

  public currentSnapshot(): string {
    return this.snapshotId;
  }

  public cards(): TreeholePreviewCard[] {
    return this.currentBatch().items.map((item) => this.card(item));
  }

  public openInObsidian(pid?: number): Promise<OpenedFeedDigest> {
    return this.options.openInObsidian(this.snapshotId, pid);
  }

  private currentBatch(): TreeholeBatchPreview {
    const batch = this.options.batches.find(
      (candidate) => candidate.digest_id === this.snapshotId,
    );
    if (!batch) throw new Error("TreeHole snapshot disappeared");
    return batch;
  }

  private card(item: TreeholePreviewItem): TreeholePreviewCard {
    return {
      pid: item.pid,
      title: item.title,
      body: item.body,
      metrics: item.metrics,
      media: item.media,
      comments: item.comments,
      commentsFolded: true,
    };
  }
}
