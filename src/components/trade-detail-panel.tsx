/**
 * TradeDetailPanel Component
 *
 * Displays all 45 fields of a single trade in an expandable inline panel.
 * Rendered below the trade row when the user clicks to expand.
 * Fields are organized into logical sections (Trade Info, Prices, P&L, etc.)
 * with a grid layout for easy scanning.
 */

"use client";

import { Trade } from "@/types/trade";
import {
  formatCurrency,
  formatDate,
  formatTime,
  formatNumber,
} from "@/lib/utils/format";

interface TradeDetailPanelProps {
  trade: Trade;
}

/** A single label/value field within a detail section */
function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="text-sm">{value ?? "—"}</span>
    </div>
  );
}

/** A titled section card containing a grid of Field components */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background/50 border border-card-border rounded-md p-4">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        {title}
      </h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-3">
        {children}
      </div>
    </div>
  );
}

export function TradeDetailPanel({ trade }: TradeDetailPanelProps) {
  // Derive win/loss label for display, matching the table status column logic
  const pnl = trade.pnl_dollars ?? 0;
  const statusLabel = pnl > 0 ? "Win" : pnl < 0 ? "Loss" : "Breakeven";

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* ---- Trade Info ---- */}
      <Section title="Trade Info">
        <Field label="ID" value={trade.id} />
        <Field label="Instrument" value={trade.instrument} />
        <Field label="Direction" value={trade.direction} />
        <Field
          label="Entry Time"
          value={`${formatDate(trade.entry_time)} ${formatTime(trade.entry_time)}`}
        />
        <Field
          label="Exit Time"
          value={
            trade.exit_time
              ? `${formatDate(trade.exit_time)} ${formatTime(trade.exit_time)}`
              : "—"
          }
        />
        <Field
          label="Quantity"
          value={trade.quantity != null ? String(trade.quantity) : "—"}
        />
        <Field label="Account" value={trade.account_name ?? "—"} />
        <Field label="Status" value={statusLabel} />
      </Section>

      {/* ---- Prices ---- */}
      <Section title="Prices">
        <Field label="Entry" value={trade.entry_price.toFixed(2)} />
        <Field label="Exit" value={formatNumber(trade.exit_price)} />
        <Field label="Stop Loss" value={formatNumber(trade.stop_loss_price)} />
        <Field
          label="Take Profit"
          value={formatNumber(trade.take_profit_price)}
        />
      </Section>

      {/* ---- P&L ---- */}
      <Section title="P&L">
        <Field label="P&L ($)" value={formatCurrency(trade.pnl_dollars)} />
        <Field label="P&L (pts)" value={formatNumber(trade.pnl_points)} />
        <Field label="Actual R:R" value={formatNumber(trade.actual_rr)} />
        <Field label="Setup R:R" value={formatNumber(trade.setup_rr)} />
      </Section>

      {/* ---- Risk Parameters ---- */}
      <Section title="Risk Parameters">
        <Field
          label="Initial Stop Dist"
          value={formatNumber(trade.initial_stop_distance)}
        />
        <Field label="Risk Units" value={formatNumber(trade.risk_units)} />
        <Field
          label="ATR Multiplier"
          value={formatNumber(trade.atr_multiplier)}
        />
        <Field
          label="R:R Multiplier"
          value={formatNumber(trade.rr_multiplier)}
        />
        <Field label="SL Mode" value={trade.sl_mode ?? "—"} />
      </Section>

      {/* ---- MFE / MAE ---- */}
      <Section title="MFE / MAE">
        <Field label="MFE (pts)" value={formatNumber(trade.mfe_points)} />
        <Field label="MAE (pts)" value={formatNumber(trade.mae_points)} />
        <Field label="MFE (R)" value={formatNumber(trade.mfe_r_multiple)} />
        <Field label="MAE (R)" value={formatNumber(trade.mae_r_multiple)} />
        <Field
          label="Post-Exit MFE (pts)"
          value={formatNumber(trade.post_exit_mfe_points)}
        />
        <Field
          label="Post-Exit MFE (R)"
          value={formatNumber(trade.post_exit_mfe_r)}
        />
        <Field
          label="Post-Exit MAE (pts)"
          value={formatNumber(trade.post_exit_mae_points)}
        />
      </Section>

      {/* ---- Market Context ---- */}
      <Section title="Market Context">
        <Field label="ATR(14)" value={formatNumber(trade.ctx_atr14)} />
        <Field
          label="ATR(14) 15s"
          value={formatNumber(trade.ctx_atr14_15s)}
        />
        <Field
          label="Price vs EMA20"
          value={trade.ctx_price_vs_ema20 ?? "—"}
        />
        <Field
          label="Dist EMA20 (ATR)"
          value={formatNumber(trade.ctx_dist_ema20_atr)}
        />
        <Field
          label="Price vs EMA200"
          value={trade.ctx_price_vs_ema200 ?? "—"}
        />
        <Field
          label="Dist EMA200 (ATR)"
          value={formatNumber(trade.ctx_dist_ema200_atr)}
        />
        <Field
          label="Bollinger Pos"
          value={trade.ctx_bollinger_pos ?? "—"}
        />
        <Field
          label="Bollinger BW"
          value={formatNumber(trade.ctx_bollinger_bw, 4)}
        />
        <Field
          label="Market Regime"
          value={trade.ctx_market_regime ?? "—"}
        />
        <Field label="ADX(14)" value={formatNumber(trade.ctx_adx14)} />
      </Section>

      {/* ---- Notes & Grading ---- */}
      <Section title="Notes & Grading">
        <Field label="Strategy" value={trade.strategy_signal_name ?? "—"} />
        <Field label="Grade" value={trade.trade_grade ?? "—"} />
        <Field label="Mistake" value={trade.trade_mistake ?? "—"} />
        <Field label="Trade Regime" value={trade.trade_regime ?? "—"} />
        <Field
          label="Custom Tags"
          value={
            trade.custom_tags
              ? JSON.stringify(trade.custom_tags)
              : "—"
          }
        />
        {/* Notes gets full width since it can be long */}
        <div className="col-span-full">
          <Field label="Notes" value={trade.notes ?? "—"} />
        </div>
      </Section>
    </div>
  );
}
