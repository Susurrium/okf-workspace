import {
  availableAiDailyPreviewStreams,
  resolveAiDailyPreviewStream,
} from "../domain/ai-daily-preview.js";
import type { AiDailyIssue, AiDailyStream } from "../feeds/types.js";
import type { OpenedFeedDigest } from "../feeds/service.js";
import { AiDailyEmbeddedPreview } from "./ai-daily-embedded-preview.js";

export interface AiDailyPreviewPageOptions {
  issues: readonly AiDailyIssue[];
  initialDate?: string;
  initialStream?: AiDailyStream;
  loadMarkdown(issueDate: string, stream: AiDailyStream): Promise<string>;
  openInObsidian(issueDate: string, stream: AiDailyStream): Promise<OpenedFeedDigest>;
}

export interface AiDailyPreviewSelection {
  issueDate: string;
  stream: AiDailyStream;
  streams: AiDailyStream[];
}

/** V1 date/stream/keyboard behavior, with no seal gate. */
export class AiDailyPreviewPage {
  public readonly preview = new AiDailyEmbeddedPreview();
  private issueDate: string;
  private stream: AiDailyStream;

  public constructor(private readonly options: AiDailyPreviewPageOptions) {
    const issue =
      options.issues.find((candidate) => candidate.issue_date === options.initialDate) ??
      options.issues[0];
    if (!issue) throw new Error("AI Daily preview page requires at least one issue");
    const stream = resolveAiDailyPreviewStream(issue, options.initialStream);
    if (!stream) throw new Error("AI Daily issue has no non-empty stream");
    this.issueDate = issue.issue_date;
    this.stream = stream;
  }

  public selection(): AiDailyPreviewSelection {
    const issue = this.currentIssue();
    return {
      issueDate: this.issueDate,
      stream: this.stream,
      streams: availableAiDailyPreviewStreams(issue),
    };
  }

  public async select(issueDate: string, preferred?: AiDailyStream): Promise<void> {
    const issue =
      this.options.issues.find((candidate) => candidate.issue_date === issueDate) ??
      this.options.issues[0];
    if (!issue) return;
    const stream = resolveAiDailyPreviewStream(issue, preferred ?? this.stream);
    if (!stream) return;
    this.issueDate = issue.issue_date;
    this.stream = stream;
    await this.refresh();
  }

  public async moveStream(key: "ArrowLeft" | "ArrowRight" | "Home" | "End"): Promise<void> {
    const streams = this.selection().streams;
    const index = streams.indexOf(this.stream);
    let target = index;
    if (key === "Home") target = 0;
    else if (key === "End") target = streams.length - 1;
    else target = (index + (key === "ArrowRight" ? 1 : -1) + streams.length) % streams.length;
    const stream = streams[target];
    if (stream) await this.select(this.issueDate, stream);
  }

  public async refresh(): Promise<void> {
    const date = this.issueDate;
    const stream = this.stream;
    await this.preview.render(() => this.options.loadMarkdown(date, stream));
  }

  public openInObsidian(): Promise<OpenedFeedDigest> {
    return this.options.openInObsidian(this.issueDate, this.stream);
  }

  private currentIssue(): AiDailyIssue {
    const issue = this.options.issues.find(
      (candidate) => candidate.issue_date === this.issueDate,
    );
    if (!issue) throw new Error("AI Daily issue disappeared");
    return issue;
  }
}
