/**
 * FilterBar Component
 *
 * Provides account selection dropdown and date range inputs.
 * All filter state is owned by the parent Dashboard component —
 * this component just renders the controls and fires callbacks.
 */

"use client";

interface FilterBarProps {
  accounts: string[];
  account: string;
  onAccountChange: (account: string) => void;
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
}

export function FilterBar({
  accounts,
  account,
  onAccountChange,
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: FilterBarProps) {
  /**
   * Compute preset date ranges relative to today.
   * Each preset has a label, a start date (YYYY-MM-DD), and an end date (today).
   * These are recalculated on every render so they stay current.
   */
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10); // format as YYYY-MM-DD
  const todayStr = fmt(today);

  // Yesterday's date for the "Yesterday" preset
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayStr = fmt(yesterday);

  // Monday of the current week (ISO weeks start on Monday)
  const monday = new Date(today);
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(today.getDate() - diffToMonday);

  // First day of the current month
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // First day of the current year
  const yearStart = new Date(today.getFullYear(), 0, 1);

  /** Preset button definitions — label, computed start, and end */
  const presets = [
    { label: "Today", start: todayStr, end: todayStr },
    { label: "Yesterday", start: yesterdayStr, end: yesterdayStr },
    { label: "This Week", start: fmt(monday), end: todayStr },
    { label: "This Month", start: fmt(monthStart), end: todayStr },
    { label: "This Year", start: fmt(yearStart), end: todayStr },
  ];

  return (
    <div className="flex flex-wrap gap-4 mb-6 items-end">
      {/* Account selector */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground uppercase tracking-wider">
          Account
        </label>
        <select
          value={account}
          onChange={(e) => onAccountChange(e.target.value)}
          className="bg-card border border-card-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        >
          {accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {/* Start date picker */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground uppercase tracking-wider">
          From
        </label>
        <input
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          className="bg-card border border-card-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        />
      </div>

      {/* End date picker */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground uppercase tracking-wider">
          To
        </label>
        <input
          type="date"
          value={endDate}
          onChange={(e) => onEndDateChange(e.target.value)}
          className="bg-card border border-card-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-green"
        />
      </div>

      {/* Date range preset buttons — quick-set common ranges */}
      <div className="flex gap-2 items-end">
        {presets.map((p) => {
          /** Highlight the button if current dates match this preset exactly */
          const isActive = startDate === p.start && endDate === p.end;
          return (
            <button
              key={p.label}
              onClick={() => {
                onStartDateChange(p.start);
                onEndDateChange(p.end);
              }}
              className={`px-3 py-2 text-sm rounded-md border transition-colors ${
                isActive
                  ? "bg-accent-green text-background border-accent-green"
                  : "bg-card border-card-border text-muted-foreground hover:text-foreground hover:border-foreground"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Clear filters button — only shows when filters are active */}
      {(account !== "All" || startDate || endDate) && (
        <button
          onClick={() => {
            onAccountChange("All");
            onStartDateChange("");
            onEndDateChange("");
          }}
          className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
