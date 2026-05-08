/**
 * PracticeRepo — practice_sessions and practice_trades.
 *
 * Practice sessions are the user's record of trading inside a replay
 * session. Two-phase save: insert the session, then bulk-insert its
 * trades with the FK back to the session id.
 */

import type { PracticeSession, PracticeTrade } from "@/types/replay";
import type { NewPracticeSession, PracticeTradeInput } from "../types";

export interface PracticeRepo {
  /** History page — list every practice session newest-first. */
  listSessions(): Promise<PracticeSession[]>;
  /** Single-session detail page. */
  getSession(id: number): Promise<PracticeSession | null>;
  /** Trades belonging to a specific practice session. */
  listTradesForSession(practiceSessionId: number): Promise<PracticeTrade[]>;

  /** Two-phase insert (session row, then bulk trade rows). Returns the
   *  new session id so the caller can link to the detail page. */
  saveSession(
    session: NewPracticeSession,
    trades: PracticeTradeInput[]
  ): Promise<{ practiceSessionId: number }>;

  deleteSession(practiceSessionId: number): Promise<void>;
}
