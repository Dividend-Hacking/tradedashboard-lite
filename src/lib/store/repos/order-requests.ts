/**
 * OrderRequestsRepo — web → NT8 order queue.
 *
 * Each insert here is picked up by LiveBridge's polling loop in NT8 and
 * translated into an actual NinjaTrader order. The web app rarely reads
 * back from this table (NT8 updates status), so this repo is mostly a
 * one-way insert surface.
 */

import type { NewOrderRequest } from "../types";

export interface OrderRequestsRepo {
  insert(row: NewOrderRequest): Promise<{ id: number }>;
}
