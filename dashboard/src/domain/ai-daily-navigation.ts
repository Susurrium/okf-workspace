/** V1 resume behavior retained without Proposal states. */
import type { AiDailyIssue, AiDailyStream } from "../feeds/types.js";

export interface AiDailyResumeTarget {
  stream: AiDailyStream;
  artifactId?: string | undefined;
}

const AI_DAILY_STREAMS: readonly AiDailyStream[] = ["hotspot", "news", "learning"];

export function resolveAiDailyResumeTarget(
  issue: AiDailyIssue,
  currentStream: AiDailyStream,
  preferredStream?: AiDailyStream,
): AiDailyResumeTarget {
  const availableStreams = new Set(issue.streams.map((stream) => stream.stream));
  const fallbackStream = availableStreams.has(currentStream)
    ? currentStream
    : issue.streams[0]?.stream ?? "hotspot";

  if (preferredStream && availableStreams.has(preferredStream)) {
    return {
      stream: preferredStream,
      artifactId:
        issue.reading_positions[preferredStream]?.artifact_id ??
        firstUndecidedArtifact(issue, preferredStream),
    };
  }

  let latest:
    | { stream: AiDailyStream; artifactId: string; updatedAt: number }
    | undefined;
  for (const stream of AI_DAILY_STREAMS) {
    if (!availableStreams.has(stream)) continue;
    const position = issue.reading_positions[stream];
    if (!position) continue;
    const updatedAt = Date.parse(position.updated_at);
    if (!latest || updatedAt > latest.updatedAt) {
      latest = { stream, artifactId: position.artifact_id, updatedAt };
    }
  }
  if (latest) return { stream: latest.stream, artifactId: latest.artifactId };
  return {
    stream: fallbackStream,
    artifactId: firstUndecidedArtifact(issue, fallbackStream),
  };
}

function firstUndecidedArtifact(
  issue: AiDailyIssue,
  stream: AiDailyStream,
): string | undefined {
  return issue.streams
    .find((candidate) => candidate.stream === stream)
    ?.items.find((item) => item.decision === undefined)?.item_id;
}
