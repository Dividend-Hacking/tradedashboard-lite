/**
 * Table View Configurations
 *
 * Defines all available column definitions and view presets for the trade table.
 * Each view is a named subset of columns, allowing users to switch between
 * different analytical perspectives (default, risk/reward, market context, execution).
 *
 * Column definitions follow the same interface used by the TradeTable component,
 * providing sort values and render functions for each field.
 */

import { Trade } from "@/types/trade";
import {
  formatCurrency,
  formatDate,
  formatTime,
  formatNumber,
} from "@/lib/utils/format";

/** Column definition — matches the interface in trade-table.tsx */
export interface Column {
  key: string;
  label: string;
  /** Extract a sortable value from a trade row */
  getValue: (t: Trade) => string | number | null;
  /** Render the display content for a cell */
  render: (t: Trade) => React.ReactNode;
}

/** Represents a switchable table view preset */
export interface TableView {
  /** Unique identifier for the view */
  id: string;
  /** Display label shown in the view switcher tabs */
  label: string;
  /** Ordered list of column keys to display in this view */
  columnKeys: string[];
}

// ---------------------------------------------------------------------------
// ALL_COLUMNS — master record of every available column
// ---------------------------------------------------------------------------

/** Master record mapping column keys to their full Column definitions */
export const ALL_COLUMNS: Record<string, Column> = {
  /* ---- Original 10 columns ---- */
  date: {
    key: "date",
    label: "Date",
    getValue: (t) => t.entry_time,
    render: (t) => {
      // Show date on first line, time on second for compact display
      const d = formatDate(t.entry_time);
      const time = formatTime(t.entry_time);
      return (
        <>
          <div className="text-sm">{d}</div>
          <div className="text-xs text-muted">{time}</div>
        </>
      );
    },
  },
  direction: {
    key: "direction",
    label: "Direction",
    getValue: (t) => t.direction,
    render: (t) => (
      <span
        className={
          t.direction === "Long" ? "text-accent-green" : "text-accent-red"
        }
      >
        {t.direction}
      </span>
    ),
  },
  entry: {
    key: "entry",
    label: "Entry",
    getValue: (t) => t.entry_price,
    render: (t) => t.entry_price.toFixed(2),
  },
  exit: {
    key: "exit",
    label: "Exit",
    getValue: (t) => t.exit_price,
    render: (t) => (t.exit_price != null ? t.exit_price.toFixed(2) : "—"),
  },
  pnl_dollars: {
    key: "pnl_dollars",
    label: "P&L ($)",
    getValue: (t) => t.pnl_dollars,
    render: (t) => (
      <span
        className={
          (t.pnl_dollars ?? 0) >= 0 ? "text-accent-green" : "text-accent-red"
        }
      >
        {formatCurrency(t.pnl_dollars)}
      </span>
    ),
  },
  pnl_points: {
    key: "pnl_points",
    label: "P&L (pts)",
    getValue: (t) => t.pnl_points,
    render: (t) =>
      t.pnl_points != null ? (
        <span
          className={
            t.pnl_points >= 0 ? "text-accent-green" : "text-accent-red"
          }
        >
          {t.pnl_points.toFixed(2)}
        </span>
      ) : (
        "—"
      ),
  },
  actual_rr: {
    key: "actual_rr",
    label: "R:R",
    getValue: (t) => t.actual_rr,
    render: (t) => formatNumber(t.actual_rr),
  },
  strategy: {
    key: "strategy",
    label: "Strategy",
    getValue: (t) => t.strategy_signal_name,
    render: (t) => (
      <span className="text-sm">{t.strategy_signal_name ?? "—"}</span>
    ),
  },
  grade: {
    key: "grade",
    label: "Grade",
    getValue: (t) => t.trade_grade,
    render: (t) => t.trade_grade ?? "—",
  },
  status: {
    key: "status",
    label: "Status",
    getValue: (t) => t.trade_status,
    render: (t) => {
      // Derive win/loss/breakeven from pnl_dollars sign
      const pnl = t.pnl_dollars ?? 0;
      const label = pnl > 0 ? "Win" : pnl < 0 ? "Loss" : "Breakeven";
      const colorClass =
        pnl > 0
          ? "text-accent-green"
          : pnl < 0
            ? "text-accent-red"
            : "text-muted-foreground";
      return <span className={colorClass}>{label}</span>;
    },
  },

  /* ---- Risk / Reward columns ---- */
  stop_loss: {
    key: "stop_loss",
    label: "Stop Loss",
    getValue: (t) => t.stop_loss_price,
    render: (t) => formatNumber(t.stop_loss_price),
  },
  take_profit: {
    key: "take_profit",
    label: "Take Profit",
    getValue: (t) => t.take_profit_price,
    render: (t) => formatNumber(t.take_profit_price),
  },
  initial_stop_distance: {
    key: "initial_stop_distance",
    label: "Stop Dist",
    getValue: (t) => t.initial_stop_distance,
    render: (t) => formatNumber(t.initial_stop_distance),
  },
  setup_rr: {
    key: "setup_rr",
    label: "Setup R:R",
    getValue: (t) => t.setup_rr,
    render: (t) => formatNumber(t.setup_rr),
  },
  mfe_points: {
    key: "mfe_points",
    label: "MFE (pts)",
    getValue: (t) => t.mfe_points,
    render: (t) => formatNumber(t.mfe_points),
  },
  mae_points: {
    key: "mae_points",
    label: "MAE (pts)",
    getValue: (t) => t.mae_points,
    render: (t) => formatNumber(t.mae_points),
  },
  mfe_r_multiple: {
    key: "mfe_r_multiple",
    label: "MFE (R)",
    getValue: (t) => t.mfe_r_multiple,
    render: (t) => formatNumber(t.mfe_r_multiple),
  },
  mae_r_multiple: {
    key: "mae_r_multiple",
    label: "MAE (R)",
    getValue: (t) => t.mae_r_multiple,
    render: (t) => formatNumber(t.mae_r_multiple),
  },

  /* ---- Market Context columns ---- */
  ctx_atr14: {
    key: "ctx_atr14",
    label: "ATR(14)",
    getValue: (t) => t.ctx_atr14,
    render: (t) => formatNumber(t.ctx_atr14),
  },
  ctx_price_vs_ema20: {
    key: "ctx_price_vs_ema20",
    label: "Price vs EMA20",
    getValue: (t) => t.ctx_price_vs_ema20,
    render: (t) => t.ctx_price_vs_ema20 ?? "—",
  },
  ctx_dist_ema20_atr: {
    key: "ctx_dist_ema20_atr",
    label: "Dist EMA20 (ATR)",
    getValue: (t) => t.ctx_dist_ema20_atr,
    render: (t) => formatNumber(t.ctx_dist_ema20_atr),
  },
  ctx_price_vs_ema200: {
    key: "ctx_price_vs_ema200",
    label: "Price vs EMA200",
    getValue: (t) => t.ctx_price_vs_ema200,
    render: (t) => t.ctx_price_vs_ema200 ?? "—",
  },
  ctx_bollinger_pos: {
    key: "ctx_bollinger_pos",
    label: "Bollinger Pos",
    getValue: (t) => t.ctx_bollinger_pos,
    render: (t) => t.ctx_bollinger_pos ?? "—",
  },
  ctx_bollinger_bw: {
    key: "ctx_bollinger_bw",
    label: "Bollinger BW",
    getValue: (t) => t.ctx_bollinger_bw,
    render: (t) => formatNumber(t.ctx_bollinger_bw, 4),
  },
  ctx_market_regime: {
    key: "ctx_market_regime",
    label: "Regime",
    getValue: (t) => t.ctx_market_regime,
    render: (t) => t.ctx_market_regime ?? "—",
  },
  ctx_adx14: {
    key: "ctx_adx14",
    label: "ADX(14)",
    getValue: (t) => t.ctx_adx14,
    render: (t) => formatNumber(t.ctx_adx14),
  },

  /* ---- Real-time columns (wall-clock timestamps, meaningful in playback mode) ---- */
  real_date: {
    key: "real_date",
    label: "Date (Real)",
    // Falls back to entry_time when real_entry_time is null (existing trades)
    getValue: (t) => t.real_entry_time ?? t.entry_time,
    render: (t) => {
      const ts = t.real_entry_time ?? t.entry_time;
      return (
        <>
          <div className="text-sm">{formatDate(ts)}</div>
          <div className="text-xs text-muted">{formatTime(ts)}</div>
        </>
      );
    },
  },
  real_exit_time: {
    key: "real_exit_time",
    label: "Exit (Real)",
    // Falls back to exit_time when real_exit_time is null (existing trades)
    getValue: (t) => t.real_exit_time ?? t.exit_time,
    render: (t) => {
      const ts = t.real_exit_time ?? t.exit_time;
      if (!ts) return "—";
      return (
        <>
          <div className="text-sm">{formatDate(ts)}</div>
          <div className="text-xs text-muted">{formatTime(ts)}</div>
        </>
      );
    },
  },

  /* ---- Execution columns ---- */
  exit_time: {
    key: "exit_time",
    label: "Exit Time",
    getValue: (t) => t.exit_time,
    render: (t) => {
      if (!t.exit_time) return "—";
      return (
        <>
          <div className="text-sm">{formatDate(t.exit_time)}</div>
          <div className="text-xs text-muted">{formatTime(t.exit_time)}</div>
        </>
      );
    },
  },
  quantity: {
    key: "quantity",
    label: "Qty",
    getValue: (t) => t.quantity,
    render: (t) => (t.quantity != null ? String(t.quantity) : "—"),
  },
  post_exit_mfe_points: {
    key: "post_exit_mfe_points",
    label: "Post-MFE (pts)",
    getValue: (t) => t.post_exit_mfe_points,
    render: (t) => formatNumber(t.post_exit_mfe_points),
  },
  post_exit_mfe_r: {
    key: "post_exit_mfe_r",
    label: "Post-MFE (R)",
    getValue: (t) => t.post_exit_mfe_r,
    render: (t) => formatNumber(t.post_exit_mfe_r),
  },
  post_exit_mae_points: {
    key: "post_exit_mae_points",
    label: "Post-MAE (pts)",
    getValue: (t) => t.post_exit_mae_points,
    render: (t) => formatNumber(t.post_exit_mae_points),
  },

  /* ---- Metadata columns ---- */
  notes: {
    key: "notes",
    label: "Notes",
    getValue: (t) => t.notes,
    render: (t) => (
      <span className="text-sm max-w-[200px] truncate block">
        {t.notes ?? "—"}
      </span>
    ),
  },
  trade_mistake: {
    key: "trade_mistake",
    label: "Mistake",
    getValue: (t) => t.trade_mistake,
    render: (t) => t.trade_mistake ?? "—",
  },
  trade_regime: {
    key: "trade_regime",
    label: "Trade Regime",
    getValue: (t) => t.trade_regime,
    render: (t) => t.trade_regime ?? "—",
  },
  account_name: {
    key: "account_name",
    label: "Account",
    getValue: (t) => t.account_name,
    render: (t) => t.account_name ?? "—",
  },
};

// ---------------------------------------------------------------------------
// TABLE_VIEWS — named presets that control which columns are visible
// ---------------------------------------------------------------------------

/** All available table view presets, ordered as they appear in the switcher */
export const TABLE_VIEWS: TableView[] = [
  {
    id: "default",
    label: "Default",
    columnKeys: [
      "date",
      "direction",
      "entry",
      "exit",
      "pnl_dollars",
      "pnl_points",
      "actual_rr",
      "strategy",
      "grade",
      "status",
    ],
  },
  {
    id: "risk",
    label: "Risk / Reward",
    columnKeys: [
      "date",
      "direction",
      "stop_loss",
      "take_profit",
      "initial_stop_distance",
      "setup_rr",
      "actual_rr",
      "mfe_points",
      "mae_points",
      "mfe_r_multiple",
      "mae_r_multiple",
      "status",
    ],
  },
  {
    id: "context",
    label: "Market Context",
    columnKeys: [
      "date",
      "direction",
      "ctx_atr14",
      "ctx_price_vs_ema20",
      "ctx_dist_ema20_atr",
      "ctx_price_vs_ema200",
      "ctx_bollinger_pos",
      "ctx_bollinger_bw",
      "ctx_market_regime",
      "ctx_adx14",
      "status",
    ],
  },
  {
    id: "execution",
    label: "Execution",
    columnKeys: [
      "date",
      "direction",
      "entry",
      "exit",
      "exit_time",
      "quantity",
      "pnl_dollars",
      "post_exit_mfe_points",
      "post_exit_mfe_r",
      "post_exit_mae_points",
      "status",
    ],
  },
];
