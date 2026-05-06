/**
 * Futures contract month utilities.
 *
 * Determines the correct front-month contract string (e.g. "06-26")
 * for a given futures instrument based on its expiration cycle and
 * the current date.
 *
 * Three expiration styles:
 *   - quarterly: ES, NQ, MES, MNQ — expire 3rd Friday of Mar/Jun/Sep/Dec.
 *     Roll ~14th of the expiration month.
 *   - monthly_end: BTC, MBT — expire last Friday of the contract month itself.
 *     The front month IS the current month until ~25th, then rolls to next.
 *   - monthly_prior: CL, GC — expire ~20th of the month BEFORE the contract
 *     month. So the front month is always 1–2 months ahead of today.
 */

export type ContractCycle = "quarterly" | "monthly_end" | "monthly_prior";

export interface InstrumentConfig {
  symbol: string;
  cycle: ContractCycle;
}

/**
 * Master list of tradeable instruments and their expiration cycles.
 */
export const INSTRUMENT_CONFIGS: InstrumentConfig[] = [
  { symbol: "NQ",  cycle: "quarterly" },
  { symbol: "MNQ", cycle: "quarterly" },
  { symbol: "MES", cycle: "quarterly" },
  { symbol: "ES",  cycle: "quarterly" },
  { symbol: "CL",  cycle: "monthly_prior" },
  { symbol: "GC",  cycle: "monthly_prior" },
  { symbol: "BTC", cycle: "monthly_end" },
  { symbol: "MBT", cycle: "monthly_end" },
];

// ─── Tick / point lookup table ──────────────────────────────────────────────
//
// Per-instrument default tick size + ticks-per-point + tick value + point
// value, used by:
//   - the script expression engine (`ticks(n)`, `pointValue`,
//     `tickValue`, `ticksPerPoint` bare identifiers + `point(n)`)
//   - the simulator's per-trade dollar conversion (read via
//     `resolveTickConfig` rather than the raw `rules.*` fields)
//
// The user can OVERRIDE these from the dashboard's "Fills & Costs" panel
// or from `rules.ticksPerPoint` / `rules.tickValue` / `rules.pointValue`
// in script — but only kicks in when a value is explicitly different
// from the auto-resolved default (signaled via `rules.tickConfigMode =
// "manual"`). When tickConfigMode is "auto" (the default), values come
// from this table.
//
// Source for these values: CME contract specs sheet —
// https://www.cmegroup.com/markets.html (sept 2024 versions). For
// fractional-tick instruments (ZB/ZN/ZF) we store the decimal
// equivalent of the fractional tick size.

export interface InstrumentTickSpec {
  /** Minimum price increment in price points (e.g. 0.25 for ES). */
  tickSize: number;
  /** How many minimum-increments equal 1.0 of price. = 1 / tickSize. */
  ticksPerPoint: number;
  /** Dollar value per single tick at 1 contract. */
  tickValue: number;
  /** Dollar value per 1.0 of price at 1 contract. = ticksPerPoint × tickValue. */
  pointValue: number;
}

export const INSTRUMENT_TICK_SPECS: Record<string, InstrumentTickSpec> = {
  // Equity index futures — quarterly cycle.
  ES:  { tickSize: 0.25,  ticksPerPoint: 4,    tickValue: 12.50, pointValue: 50 },
  MES: { tickSize: 0.25,  ticksPerPoint: 4,    tickValue: 1.25,  pointValue: 5 },
  NQ:  { tickSize: 0.25,  ticksPerPoint: 4,    tickValue: 5.00,  pointValue: 20 },
  MNQ: { tickSize: 0.25,  ticksPerPoint: 4,    tickValue: 0.50,  pointValue: 2 },
  YM:  { tickSize: 1.0,   ticksPerPoint: 1,    tickValue: 5.00,  pointValue: 5 },
  MYM: { tickSize: 1.0,   ticksPerPoint: 1,    tickValue: 0.50,  pointValue: 0.50 },
  RTY: { tickSize: 0.10,  ticksPerPoint: 10,   tickValue: 5.00,  pointValue: 50 },
  M2K: { tickSize: 0.10,  ticksPerPoint: 10,   tickValue: 0.50,  pointValue: 5 },

  // Metals.
  GC:  { tickSize: 0.10,    ticksPerPoint: 10,    tickValue: 10.00, pointValue: 100 },
  MGC: { tickSize: 0.10,    ticksPerPoint: 10,    tickValue: 1.00,  pointValue: 10 },
  SI:  { tickSize: 0.005,   ticksPerPoint: 200,   tickValue: 25.00, pointValue: 5000 },
  SIL: { tickSize: 0.005,   ticksPerPoint: 200,   tickValue: 5.00,  pointValue: 1000 },
  HG:  { tickSize: 0.0005,  ticksPerPoint: 2000,  tickValue: 12.50, pointValue: 25000 },

  // Energy.
  CL:  { tickSize: 0.01,   ticksPerPoint: 100,   tickValue: 10.00, pointValue: 1000 },
  MCL: { tickSize: 0.01,   ticksPerPoint: 100,   tickValue: 1.00,  pointValue: 100 },
  NG:  { tickSize: 0.001,  ticksPerPoint: 1000,  tickValue: 10.00, pointValue: 10000 },

  // Crypto. Ticks are LARGER than 1 point for BTC/MBT (5.00 tick on a
  // numeric-points basis), so ticksPerPoint comes out fractional (0.2).
  // The math still works — `ticks(n) = n / ticksPerPoint` gives n × 5
  // price points, which is the correct conversion.
  BTC: { tickSize: 5.00,   ticksPerPoint: 0.2,   tickValue: 25.00, pointValue: 5 },
  MBT: { tickSize: 5.00,   ticksPerPoint: 0.2,   tickValue: 0.50,  pointValue: 0.10 },
  ETH: { tickSize: 0.50,   ticksPerPoint: 2,     tickValue: 25.00, pointValue: 50 },
  MET: { tickSize: 0.50,   ticksPerPoint: 2,     tickValue: 0.05,  pointValue: 0.10 },

  // Interest rate futures — fractional tick sizes (1/32, 1/64, 1/128).
  ZB:  { tickSize: 0.03125,    ticksPerPoint: 32,  tickValue: 31.25,  pointValue: 1000 },
  ZN:  { tickSize: 0.015625,   ticksPerPoint: 64,  tickValue: 15.625, pointValue: 1000 },
  ZF:  { tickSize: 0.0078125,  ticksPerPoint: 128, tickValue: 7.8125, pointValue: 1000 },
};

/**
 * Strip the contract-month suffix off an instrument string. NinjaTrader
 * formats instruments as "<root> <contract>" (e.g. "NQ 12-26", "GC 04-27").
 * Returns the uppercased root; falls back to the raw input when it
 * doesn't match the expected shape.
 */
export function instrumentRoot(instrument: string): string {
  if (!instrument) return "";
  const trimmed = instrument.trim();
  const space = trimmed.indexOf(" ");
  const root = space > 0 ? trimmed.slice(0, space) : trimmed;
  return root.toUpperCase();
}

/**
 * Look up the auto-detected tick spec for an instrument. Returns null
 * when the symbol isn't in INSTRUMENT_TICK_SPECS — caller should fall
 * back to manual `rules.*` values (or DEFAULT_SIM_RULES) in that case.
 */
export function lookupTickSpec(instrument: string): InstrumentTickSpec | null {
  const root = instrumentRoot(instrument);
  return INSTRUMENT_TICK_SPECS[root] ?? null;
}

/**
 * Returns the front-month contract date string (e.g. "06-26") for a given
 * contract cycle based on the current date.
 *
 * Quarterly: picks the nearest quarterly month (Mar/Jun/Sep/Dec) that
 *   hasn't rolled yet. After the 14th of an expiration month, advances
 *   to the next quarter.
 *
 * monthly_end (BTC, MBT): contract expires last Friday of the contract
 *   month. Front month = current month until ~25th, then next month.
 *
 * monthly_prior (CL, GC): contract expires ~20th of the month BEFORE
 *   the contract month. Front month = next month until ~20th, then
 *   advances to month + 2.
 */
export function getFrontMonth(cycle: ContractCycle, now = new Date()): string {
  const month = now.getMonth(); // 0-11
  const day = now.getDate();
  const year = now.getFullYear();

  let contractMonth: number; // 0-11
  let contractYear = year;

  if (cycle === "quarterly") {
    const ROLL_DAY = 14;
    const quarters = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)

    // Find the current or next quarterly expiration month
    let qi = quarters.findIndex((q) => q >= month);

    if (qi === -1) {
      // Past December cycle — wrap to next year's March
      contractMonth = 2;
      contractYear = year + 1;
    } else if (quarters[qi] === month && day > ROLL_DAY) {
      // In an expiration month but past roll day — use next quarter
      qi = (qi + 1) % 4;
      contractMonth = quarters[qi];
      if (qi === 0) contractYear = year + 1;
    } else {
      contractMonth = quarters[qi];
    }
  } else if (cycle === "monthly_end") {
    // BTC / MBT: expire last Friday of the contract month itself.
    // Before ~25th the current month's contract is still active.
    // After ~25th it has (or is about to) expire, so roll to next month.
    contractMonth = day > 25 ? month + 1 : month;

    if (contractMonth > 11) {
      contractMonth -= 12;
      contractYear = year + 1;
    }
  } else {
    // monthly_prior (CL, GC): expire ~20th of the month BEFORE the
    // contract month. E.g. CL May expires ~April 20.
    // Before the 20th: the nearby contract (for next month) is still alive.
    // After the 20th: that contract expired, front month jumps ahead one more.
    contractMonth = day > 20 ? month + 2 : month + 1;

    if (contractMonth > 11) {
      contractMonth -= 12;
      contractYear = year + 1;
    }
  }

  // Format as "MM-YY"
  const mm = String(contractMonth + 1).padStart(2, "0");
  const yy = String(contractYear).slice(-2);
  return `${mm}-${yy}`;
}

/**
 * Builds the full NinjaTrader instrument name (e.g. "MNQ 06-26") for each
 * instrument in INSTRUMENT_CONFIGS using the current front-month contract.
 */
export function getInstrumentNames(now = new Date()): string[] {
  return INSTRUMENT_CONFIGS.map(
    ({ symbol, cycle }) => `${symbol} ${getFrontMonth(cycle, now)}`
  );
}

/**
 * Returns the default instrument name (first in the list) with its
 * current front-month contract date.
 */
export function getDefaultInstrument(now = new Date()): string {
  const { symbol, cycle } = INSTRUMENT_CONFIGS[0];
  return `${symbol} ${getFrontMonth(cycle, now)}`;
}
