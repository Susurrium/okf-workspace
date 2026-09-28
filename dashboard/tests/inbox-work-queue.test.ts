import { describe, expect, it } from "vitest";

import type {
  ConversionRecord,
  NoteSummary,
} from "../src/api/types.js";
import {
  buildInboxWorkQueue,
  filterInboxItems,
  materialContextFromNote,
  WEB_CAPTURE_ACTIONS,
  type InboxProjectionData,
} from "../src/domain/inbox-work-queue.js";

describe("Inbox work queue", () => {
  it("keeps failed generation handoffs visible after conversion succeeded", () => {
    const pending = { ...conversion("imported", "pending"), stages: { semantic: "failed" }, error: "queue busy" };
    const attached = { ...pending, conversion_id: "attached", outputs: { semantic_operation_id: "op-1" } };
    const queue = buildInboxWorkQueue({ captures: [], processed_captures: [], pending_imports: [] }, [pending, attached]);
    expect(queue.conversion.map((item) => item.conversion.conversion_id)).toEqual(["conv-pending"]);
  });
  it("exposes only the four explicit Web Capture publication actions", () => {
    expect(WEB_CAPTURE_ACTIONS.map((item) => item.action)).toEqual([
      "learn-now",
      "learn-later",
      "wiki-now",
      "source-only",
    ]);
  });

  it("groups Markdown and runtime work by stage and ingestion channel", () => {
    const projection: InboxProjectionData = {
      captures: [
        note("inbox/captures/web.md", "网页", { ingested_via: "web-clip" }),
        note("inbox/captures/direct.md", "想法", { ingested_via: "direct-entry" }),
      ],
      processed_captures: [],
      pending_imports: [
        note("sources/records/feed/later.md", "稍后判断", {
          note_type: "Source",
          purpose: "undecided",
          ingested_via: "feed",
        }),
      ],
    };
    const queue = buildInboxWorkQueue(
      projection,
      [
        conversion("queued", "one"),
        conversion("ready", "two"),
        conversion("failed", "three"),
        conversion("imported", "done"),
      ],
    );

    expect(queue.decision).toHaveLength(3);
    expect(queue.conversion).toHaveLength(3);
    expect(queue.channel_counts).toEqual({
      "web-clip": 1,
      "file-import": 3,
      feed: 1,
      "direct-entry": 1,
      unlabeled: 0,
    });
    expect(filterInboxItems(queue.decision, "web-clip").map((item) => item.note.title))
      .toEqual(["网页"]);
  });

  it("keeps missing or invalid channels as a computed unlabeled bucket", () => {
    const projection: InboxProjectionData = {
      captures: [note("inbox/captures/legacy.md", "旧 Capture")],
      processed_captures: [],
      pending_imports: [],
    };

    const queue = buildInboxWorkQueue(projection, []);

    expect(queue.channel_counts.unlabeled).toBe(1);
    expect(queue.decision[0]?.ingested_via).toBe("unlabeled");
  });

  it("preserves an existing Course or Project when pending generation is resumed", () => {
    expect(materialContextFromNote({
      course: "/learning/courses/cs61a/course.md",
      project: null,
    })).toEqual({ course: "cs61a" });
    expect(materialContextFromNote({
      course: null,
      project: "/projects/okf-brain/project.md",
    })).toEqual({ project: "okf-brain" });
    expect(materialContextFromNote({ course: null, project: null })).toEqual({});
  });
});

function note(
  path: string,
  title: string,
  fields: Partial<NoteSummary> = {},
): NoteSummary {
  return {
    path,
    title,
    note_type: "Capture",
    status: "stable",
    stale: false,
    excerpt: "",
    ...fields,
  };
}

function conversion(status: ConversionRecord["status"], id: string): ConversionRecord {
  return {
    conversion_id: `conv-${id}`,
    status,
    source_filename: `${id}.pdf`,
    intent: "learn",
    quality: "high",
    parser: "mineru",
    outputs: {},
  };
}
