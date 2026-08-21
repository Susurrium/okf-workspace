/**
 * V1 controller name retained; the Proposal round-trip is replaced by one
 * Feed Decision API call. A click is the complete decision.
 */
import type { FeedApi } from "../feeds/service.js";
import type {
  FeedDecisionAction,
  FeedDecisionResult,
  FeedItem,
} from "../feeds/types.js";

export interface FeedDecisionViewState {
  pending: boolean;
  result?: FeedDecisionResult;
  error?: string;
}

export class AiDailyDecisionController {
  private readonly states = new Map<string, FeedDecisionViewState>();

  public constructor(private readonly api: FeedApi) {}

  public state(itemId: string): Readonly<FeedDecisionViewState> {
    return this.states.get(itemId) ?? { pending: false };
  }

  public async decide(
    item: Pick<FeedItem, "item_id">,
    action: FeedDecisionAction,
  ): Promise<FeedDecisionResult> {
    this.states.set(item.item_id, { pending: true });
    try {
      const result = await this.api.decide("ai-daily", item.item_id, action);
      this.states.set(item.item_id, {
        pending: false,
        result,
      });
      return result;
    } catch (error) {
      this.states.set(item.item_id, {
        pending: false,
        error: error instanceof Error ? error.message : "Feed decision failed",
      });
      throw error;
    }
  }
}
