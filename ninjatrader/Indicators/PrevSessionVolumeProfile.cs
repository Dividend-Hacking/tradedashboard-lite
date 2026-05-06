#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Windows.Media;
using System.Xml.Serialization;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Chart;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

namespace NinjaTrader.NinjaScript.Indicators
{
	/// <summary>
	/// PrevSessionVolumeProfile — Plots the previous session's key volume profile levels
	/// (POC, VAH, VAL, and HVNs) as horizontal lines on the chart.
	///
	/// How it works:
	/// 1. Adds a 1-minute secondary data series for granular volume sampling.
	/// 2. On each 1-min bar, distributes volume evenly across tick-level price buckets
	///    within the bar's High-Low range (same algorithm as NQVPPOCBounce).
	/// 3. When the session date changes, finalizes the accumulated profile as the
	///    "previous session" profile, calculates POC/VAH/VAL/HVN levels, and draws lines.
	/// 4. Lines persist until the next session change, when they are replaced.
	///
	/// User-configurable: value area %, HVN threshold, max HVN lines, bucket size,
	/// and all visual appearance settings (colors, dash styles, widths).
	/// </summary>
	public class PrevSessionVolumeProfile : Indicator
	{
		// ─── Volume Profile State ────────────────────────────────────────────
		// Accumulates volume at each price level for the current building session.
		// Key = price rounded to tick bucket, Value = cumulative volume.
		private Dictionary<double, double> currentSessionVolume;

		// Tracks the session date of the currently accumulating profile.
		// When this changes, we finalize the current profile as "previous session."
		private DateTime currentSessionDate;

		// Whether we have a valid previous session profile to draw.
		private bool hasPreviousSession;

		// Computed tick bucket size (TickSize * TickBucketMultiplier).
		private double bucketSize;

		// Tag prefix for Draw objects — used for cleanup.
		private const string TAG_PREFIX = "PrevVP_";

		#region OnStateChange
		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				// ─── Indicator metadata ──────────────────────────────────────
				Description = "Plots previous session POC, VAH, VAL, and HVN levels";
				Name = "PrevSessionVolumeProfile";
				IsOverlay = true;                // Draw on price panel, not a sub-panel
				IsSuspendedWhileInactive = true;  // Pause when chart is not visible
				Calculate = Calculate.OnBarClose;  // Process on bar close for performance

				// ─── User Parameters — Value Area ────────────────────────────
				ValueAreaPct = 70;
				HvnThresholdPct = 150;
				MaxHvnLines = 5;
				TickBucketMultiplier = 1;

				// ─── User Parameters — POC Appearance ────────────────────────
				PocColor = Brushes.Red;
				PocDashStyle = DashStyleHelper.Solid;
				PocWidth = 3;

				// ─── User Parameters — VAH/VAL Appearance ────────────────────
				ValueAreaColor = Brushes.DodgerBlue;
				ValueAreaDashStyle = DashStyleHelper.Dash;
				ValueAreaWidth = 2;

				// ─── User Parameters — HVN Appearance ────────────────────────
				HvnColor = Brushes.Orange;
				HvnDashStyle = DashStyleHelper.DashDot;
				HvnWidth = 1;
			}
			else if (State == State.Configure)
			{
				// Add 1-minute secondary series for fine-grained volume distribution.
				// BarsInProgress 0 = primary chart series, 1 = this 1-min series.
				AddDataSeries(BarsPeriodType.Minute, 1);
			}
			else if (State == State.DataLoaded)
			{
				// Initialize the volume accumulator dictionary and session tracking.
				currentSessionVolume = new Dictionary<double, double>();
				currentSessionDate = DateTime.MinValue;
				hasPreviousSession = false;

				// Calculate the bucket size from instrument tick size and user multiplier.
				// E.g., NQ tick size = 0.25, multiplier = 1 → bucket = 0.25
				bucketSize = TickSize * TickBucketMultiplier;
				if (bucketSize <= 0)
					bucketSize = TickSize > 0 ? TickSize : 0.25;
			}
			else if (State == State.Terminated)
			{
				// Clean up all draw objects when the indicator is removed from the chart.
				CleanupDrawObjects();
			}
		}
		#endregion

		#region OnBarUpdate
		protected override void OnBarUpdate()
		{
			// Only process the 1-minute secondary series (BarsInProgress == 1).
			// The secondary series provides granular volume data for profile building.
			if (BarsInProgress != 1)
				return;

			// Need at least one bar to work with
			if (CurrentBars[1] < 1)
				return;

			// Skip zero-volume bars — nothing to accumulate
			if (Volumes[1][0] <= 0)
				return;

			// ─── Session Change Detection ────────────────────────────────────
			// Use the bar's date to detect session boundaries.
			// Same approach as NQVPPOCBounce.cs — simple and reliable.
			DateTime sessionDate = Times[1][0].Date;

			// Detect session change: if the bar belongs to a new session date,
			// finalize the current session profile and start fresh.
			if (currentSessionDate != DateTime.MinValue && sessionDate != currentSessionDate)
			{
				// Finalize the accumulated volume as the previous session's profile
				FinalizeAndDrawProfile(currentSessionVolume);
				hasPreviousSession = true;

				// Reset accumulator for the new session
				currentSessionVolume = new Dictionary<double, double>();
			}

			// Update the tracked session date
			currentSessionDate = sessionDate;

			// ─── Volume Distribution ─────────────────────────────────────────
			// Distribute the bar's volume evenly across all price levels (tick buckets)
			// within its High-Low range. This approximates a volume profile from OHLCV data.
			double high = Highs[1][0];
			double low = Lows[1][0];
			double vol = Volumes[1][0];

			// Round High/Low to bucket boundaries to avoid floating-point drift
			double roundedLow = Math.Round(low / bucketSize) * bucketSize;
			double roundedHigh = Math.Round(high / bucketSize) * bucketSize;

			// Count the number of price levels in this bar's range
			int levels = Math.Max(1, (int)Math.Round((roundedHigh - roundedLow) / bucketSize) + 1);
			double volPerLevel = vol / levels;

			// Accumulate volume at each price level within the bar's range
			for (double p = roundedLow; p <= roundedHigh + bucketSize * 0.5; p += bucketSize)
			{
				// Re-round each level to prevent floating-point accumulation errors
				double priceKey = Math.Round(p / bucketSize) * bucketSize;

				if (currentSessionVolume.ContainsKey(priceKey))
					currentSessionVolume[priceKey] += volPerLevel;
				else
					currentSessionVolume[priceKey] = volPerLevel;
			}
		}
		#endregion

		#region Profile Calculations and Drawing

		/// <summary>
		/// Finalizes a completed session's volume profile: calculates POC, VAH, VAL,
		/// and HVN levels, then draws horizontal lines on the chart.
		/// Called when a session change is detected.
		/// </summary>
		/// <param name="volumeProfile">The accumulated volume-at-price dictionary for the session</param>
		private void FinalizeAndDrawProfile(Dictionary<double, double> volumeProfile)
		{
			// Need at least one price level to compute a profile
			if (volumeProfile == null || volumeProfile.Count == 0)
				return;

			// ─── Clean up previous draw objects ──────────────────────────────
			CleanupDrawObjects();

			// ─── Calculate POC ───────────────────────────────────────────────
			// POC = Point of Control = price level with the highest cumulative volume
			double pocPrice = 0;
			double pocVolume = 0;
			foreach (var kvp in volumeProfile)
			{
				if (kvp.Value > pocVolume)
				{
					pocVolume = kvp.Value;
					pocPrice = kvp.Key;
				}
			}

			// ─── Calculate Value Area (VAH / VAL) ────────────────────────────
			// CME method: start at POC, expand outward comparing 2 levels above vs 2 below.
			// Whichever pair has more volume gets added to the value area.
			// Continue until ValueAreaPct (default 70%) of total volume is captured.
			double totalVolume = volumeProfile.Values.Sum();
			double targetVolume = totalVolume * (ValueAreaPct / 100.0);

			// Sort all price levels ascending for expansion
			List<double> sortedPrices = volumeProfile.Keys.OrderBy(p => p).ToList();
			int pocIndex = sortedPrices.IndexOf(pocPrice);

			// If POC wasn't found in sorted list (shouldn't happen), find closest
			if (pocIndex < 0)
			{
				pocIndex = 0;
				double minDist = double.MaxValue;
				for (int i = 0; i < sortedPrices.Count; i++)
				{
					double dist = Math.Abs(sortedPrices[i] - pocPrice);
					if (dist < minDist)
					{
						minDist = dist;
						pocIndex = i;
					}
				}
			}

			// Start the value area at POC
			double vaVolume = volumeProfile[sortedPrices[pocIndex]];
			int upperIdx = pocIndex;  // Current upper boundary of the value area
			int lowerIdx = pocIndex;  // Current lower boundary of the value area

			// Expand outward until we capture the target volume percentage
			while (vaVolume < targetVolume && (upperIdx < sortedPrices.Count - 1 || lowerIdx > 0))
			{
				// Sum the next 2 levels above the current upper boundary
				double aboveVol = 0;
				int aboveSteps = 0;
				for (int i = 1; i <= 2 && upperIdx + i < sortedPrices.Count; i++)
				{
					aboveVol += volumeProfile[sortedPrices[upperIdx + i]];
					aboveSteps = i;
				}

				// Sum the next 2 levels below the current lower boundary
				double belowVol = 0;
				int belowSteps = 0;
				for (int i = 1; i <= 2 && lowerIdx - i >= 0; i++)
				{
					belowVol += volumeProfile[sortedPrices[lowerIdx - i]];
					belowSteps = i;
				}

				// If both directions are exhausted, break
				if (aboveSteps == 0 && belowSteps == 0)
					break;

				// Compare above vs below volume — expand toward the higher-volume side.
				// If equal, expand both. If one side is exhausted, expand the other.
				if (aboveSteps == 0)
				{
					// Only below available
					lowerIdx -= belowSteps;
					vaVolume += belowVol;
				}
				else if (belowSteps == 0)
				{
					// Only above available
					upperIdx += aboveSteps;
					vaVolume += aboveVol;
				}
				else if (aboveVol >= belowVol)
				{
					// Above has more volume (or equal) — expand upward
					upperIdx += aboveSteps;
					vaVolume += aboveVol;
				}
				else
				{
					// Below has more volume — expand downward
					lowerIdx -= belowSteps;
					vaVolume += belowVol;
				}
			}

			double vahPrice = sortedPrices[upperIdx];
			double valPrice = sortedPrices[lowerIdx];

			// ─── Calculate HVNs ──────────────────────────────────────────────
			// HVN = High Volume Node = price levels outside the value area with
			// volume significantly above average (> HvnThresholdPct% of average).
			double avgVolume = totalVolume / volumeProfile.Count;
			double hvnThreshold = avgVolume * (HvnThresholdPct / 100.0);

			List<double> hvnPrices = new List<double>();
			foreach (var kvp in volumeProfile)
			{
				// Only consider prices outside the value area
				if (kvp.Key > vahPrice || kvp.Key < valPrice)
				{
					if (kvp.Value >= hvnThreshold)
						hvnPrices.Add(kvp.Key);
				}
			}

			// Sort HVNs by volume descending so we keep the most significant ones
			hvnPrices = hvnPrices.OrderByDescending(p => volumeProfile[p]).ToList();

			// Cluster adjacent HVNs — if two HVN prices are within 2 buckets of each other,
			// keep only the one with higher volume to avoid cluttered lines
			List<double> clusteredHvns = new List<double>();
			double clusterDistance = bucketSize * 2;
			foreach (double hvn in hvnPrices)
			{
				bool tooClose = false;
				foreach (double existing in clusteredHvns)
				{
					if (Math.Abs(hvn - existing) <= clusterDistance)
					{
						tooClose = true;
						break;
					}
				}
				if (!tooClose)
					clusteredHvns.Add(hvn);

				// Cap at user-specified maximum
				if (clusteredHvns.Count >= MaxHvnLines)
					break;
			}

			// ─── Draw Lines ──────────────────────────────────────────────────
			// POC line — most prominent, solid red
			Draw.HorizontalLine(this, TAG_PREFIX + "POC", pocPrice, PocColor, PocDashStyle, PocWidth);

			// VAH line — upper value area boundary
			Draw.HorizontalLine(this, TAG_PREFIX + "VAH", vahPrice, ValueAreaColor, ValueAreaDashStyle, ValueAreaWidth);

			// VAL line — lower value area boundary
			Draw.HorizontalLine(this, TAG_PREFIX + "VAL", valPrice, ValueAreaColor, ValueAreaDashStyle, ValueAreaWidth);

			// HVN lines — significant volume nodes outside the value area
			for (int i = 0; i < clusteredHvns.Count; i++)
			{
				Draw.HorizontalLine(this, TAG_PREFIX + "HVN" + i, clusteredHvns[i], HvnColor, HvnDashStyle, HvnWidth);
			}
		}

		/// <summary>
		/// Removes all draw objects created by this indicator.
		/// Called on session change (before drawing new lines) and on State.Terminated.
		/// </summary>
		private void CleanupDrawObjects()
		{
			// Remove known fixed tags (POC, VAH, VAL)
			RemoveDrawObject(TAG_PREFIX + "POC");
			RemoveDrawObject(TAG_PREFIX + "VAH");
			RemoveDrawObject(TAG_PREFIX + "VAL");

			// Remove HVN tags — we don't know exactly how many exist from
			// the previous session, so remove up to MaxHvnLines + a buffer
			for (int i = 0; i < MaxHvnLines + 5; i++)
			{
				RemoveDrawObject(TAG_PREFIX + "HVN" + i);
			}
		}

		#endregion

		#region Properties

		// ─── Value Area Parameters ───────────────────────────────────────────

		[NinjaScriptProperty]
		[Range(1, 100)]
		[Display(Name = "Value Area %", Description = "Percentage of total volume for value area calculation",
			Order = 1, GroupName = "Parameters")]
		public int ValueAreaPct { get; set; }

		[NinjaScriptProperty]
		[Range(100, 500)]
		[Display(Name = "HVN Threshold %", Description = "HVN threshold as percentage of average volume per level",
			Order = 2, GroupName = "Parameters")]
		public int HvnThresholdPct { get; set; }

		[NinjaScriptProperty]
		[Range(0, 20)]
		[Display(Name = "Max HVN Lines", Description = "Maximum number of HVN lines to display",
			Order = 3, GroupName = "Parameters")]
		public int MaxHvnLines { get; set; }

		[NinjaScriptProperty]
		[Range(1, 10)]
		[Display(Name = "Tick Bucket Multiplier", Description = "Bucket size as a multiple of tick size (1 = finest granularity)",
			Order = 4, GroupName = "Parameters")]
		public int TickBucketMultiplier { get; set; }

		// ─── POC Appearance ──────────────────────────────────────────────────

		[XmlIgnore]
		[Display(Name = "POC Color", Description = "Color of the POC line",
			Order = 1, GroupName = "POC Appearance")]
		public Brush PocColor { get; set; }

		[Browsable(false)]
		public string PocColorSerializable
		{
			get { return Serialize.BrushToString(PocColor); }
			set { PocColor = Serialize.StringToBrush(value); }
		}

		[Display(Name = "POC Dash Style", Description = "Dash style of the POC line",
			Order = 2, GroupName = "POC Appearance")]
		public DashStyleHelper PocDashStyle { get; set; }

		[Range(1, 10)]
		[Display(Name = "POC Width", Description = "Width of the POC line",
			Order = 3, GroupName = "POC Appearance")]
		public int PocWidth { get; set; }

		// ─── Value Area Appearance ───────────────────────────────────────────

		[XmlIgnore]
		[Display(Name = "Value Area Color", Description = "Color of the VAH/VAL lines",
			Order = 1, GroupName = "Value Area Appearance")]
		public Brush ValueAreaColor { get; set; }

		[Browsable(false)]
		public string ValueAreaColorSerializable
		{
			get { return Serialize.BrushToString(ValueAreaColor); }
			set { ValueAreaColor = Serialize.StringToBrush(value); }
		}

		[Display(Name = "Value Area Dash Style", Description = "Dash style of the VAH/VAL lines",
			Order = 2, GroupName = "Value Area Appearance")]
		public DashStyleHelper ValueAreaDashStyle { get; set; }

		[Range(1, 10)]
		[Display(Name = "Value Area Width", Description = "Width of the VAH/VAL lines",
			Order = 3, GroupName = "Value Area Appearance")]
		public int ValueAreaWidth { get; set; }

		// ─── HVN Appearance ──────────────────────────────────────────────────

		[XmlIgnore]
		[Display(Name = "HVN Color", Description = "Color of the HVN lines",
			Order = 1, GroupName = "HVN Appearance")]
		public Brush HvnColor { get; set; }

		[Browsable(false)]
		public string HvnColorSerializable
		{
			get { return Serialize.BrushToString(HvnColor); }
			set { HvnColor = Serialize.StringToBrush(value); }
		}

		[Display(Name = "HVN Dash Style", Description = "Dash style of the HVN lines",
			Order = 2, GroupName = "HVN Appearance")]
		public DashStyleHelper HvnDashStyle { get; set; }

		[Range(1, 10)]
		[Display(Name = "HVN Width", Description = "Width of the HVN lines",
			Order = 3, GroupName = "HVN Appearance")]
		public int HvnWidth { get; set; }

		#endregion
	}
}
