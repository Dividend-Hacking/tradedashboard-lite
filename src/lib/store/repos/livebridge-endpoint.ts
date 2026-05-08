/**
 * LiveBridgeEndpointRepo — singleton livebridge_endpoint row (id='default').
 *
 * Holds the candidate hosts and port the live trader's WebSocket should
 * try when discovering NT8's LiveBridge server. The Auto Settings modal
 * edits this; Live Trader's discovery hook reads it.
 */

import type { LiveBridgeEndpointRow } from "../types";

export interface LiveBridgeEndpointRepo {
  fetch(): Promise<LiveBridgeEndpointRow | null>;
  upsert(row: Omit<LiveBridgeEndpointRow, "updated_at">): Promise<void>;
}
