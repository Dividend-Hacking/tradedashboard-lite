#!/bin/bash
# deploy-nt8.sh — Copy NQ strategy .cs files into NinjaTrader 8's custom folders
# Parallels Desktop mirrors the Windows Documents folder to the Mac, so the NT8
# custom folder is directly accessible at ~/Documents/NinjaTrader 8/bin/Custom/.
# No VM credentials, SMB mounts, or prlctl needed — just a local file copy.
#
# Usage: cd ninjatrader && ./deploy-nt8.sh

set -euo pipefail

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# NinjaTrader 8 custom folder — mirrored from Windows VM by Parallels shared folders
NT8_CUSTOM="$HOME/Documents/NinjaTrader 8/bin/Custom"

# Mac-side source directories containing .cs files
STRATEGIES_DIR="$SCRIPT_DIR/Strategies"
ADDONS_DIR="$SCRIPT_DIR/AddOns"
INDICATORS_DIR="$SCRIPT_DIR/Indicators"
DRAWINGTOOLS_DIR="$SCRIPT_DIR/DrawingTools"

# Preset JSONs consumed by PresetStrategy. Mirrored to bin/Custom/presets/
# on the VM so each NQTest03 / CLTest01 / etc. wrapper can find its config
# at runtime via NinjaTrader.Core.Globals.UserDataDir + "bin/Custom/presets".
PRESETS_DIR="$SCRIPT_DIR/Strategies/presets"

# ── Verify NinjaTrader custom folder exists ─────────────────────────────────
# This folder is created when NinjaTrader 8 runs and compiles for the first time
if [[ ! -d "$NT8_CUSTOM/Strategies" ]]; then
  echo "ERROR: NinjaTrader custom folders not found at:"
  echo "  $NT8_CUSTOM/Strategies"
  echo "Make sure Parallels Documents mirroring is enabled and NT8 has been compiled once."
  exit 1
fi

# ── Deploy helper — copies all .cs files from a source dir to NT8 custom ───
deploy_folder() {
  local src_dir="$1"    # Mac source directory (e.g. .../Strategies)
  local dest_dir="$2"   # NT8 custom subdirectory (e.g. .../Custom/Strategies)
  local label="$3"      # Display label for output

  for cs_file in "$src_dir"/*.cs; do
    [[ -e "$cs_file" ]] || continue
    filename="$(basename "$cs_file")"

    if cp "$cs_file" "$dest_dir/$filename"; then
      echo "  OK  ${label}/$filename"
      SUCCESS=$((SUCCESS + 1))
    else
      echo "  FAIL  ${label}/$filename"
      FAIL=$((FAIL + 1))
    fi
  done
}

# ── Deploy each .cs file ────────────────────────────────────────────────────
echo "Deploying NQ strategies + AddOns + Indicators to NinjaTrader 8..."
echo "──────────────────────────────────────────"

SUCCESS=0
FAIL=0

# ── Strategies ──
deploy_folder "$STRATEGIES_DIR" "$NT8_CUSTOM/Strategies" "Strategies"

# ── AddOns ──
if [[ -d "$ADDONS_DIR" ]]; then
  deploy_folder "$ADDONS_DIR" "$NT8_CUSTOM/AddOns" "AddOns"
fi

# ── Indicators ──
if [[ -d "$INDICATORS_DIR" ]]; then
  deploy_folder "$INDICATORS_DIR" "$NT8_CUSTOM/Indicators" "Indicators"
fi

# ── DrawingTools ──
if [[ -d "$DRAWINGTOOLS_DIR" ]]; then
  deploy_folder "$DRAWINGTOOLS_DIR" "$NT8_CUSTOM/DrawingTools" "DrawingTools"
fi

# ── Preset JSONs ──
# Mirrors any *.json files from strategies/presets/ to bin/Custom/presets/
# on the VM. PresetStrategy and its subclasses (NQTest03, CLTest01, etc.)
# read these at State.DataLoaded — each wrapper hardcodes a default path
# that resolves to this directory. Creates the destination dir if missing
# (a fresh NT8 install won't have it until the first preset deploy).
if [[ -d "$PRESETS_DIR" ]]; then
  PRESETS_DEST="$NT8_CUSTOM/presets"
  mkdir -p "$PRESETS_DEST"
  for json_file in "$PRESETS_DIR"/*.json; do
    [[ -e "$json_file" ]] || continue
    filename="$(basename "$json_file")"
    if cp "$json_file" "$PRESETS_DEST/$filename"; then
      echo "  OK  presets/$filename"
      SUCCESS=$((SUCCESS + 1))
    else
      echo "  FAIL  presets/$filename"
      FAIL=$((FAIL + 1))
    fi
  done
fi

# ── mode.json seed (Local Mode toggle) ──
# ModeConfig.cs reads bin/Custom/AddOns/mode.json on a 15s TTL. The web
# app overwrites this file when the user flips the toggle in /settings.
# We seed the file from mode.example.json on first deploy ONLY if the
# destination is missing — never overwrite an existing config so user
# edits and toggle writes from the web app stick.
MODE_EXAMPLE="$ADDONS_DIR/mode.example.json"
MODE_DEST="$NT8_CUSTOM/AddOns/mode.json"
if [[ -e "$MODE_EXAMPLE" && ! -e "$MODE_DEST" ]]; then
  if cp "$MODE_EXAMPLE" "$MODE_DEST"; then
    echo "  OK  AddOns/mode.json (seeded)"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  FAIL  AddOns/mode.json"
    FAIL=$((FAIL + 1))
  fi
fi

echo "──────────────────────────────────────────"
echo "Done: $SUCCESS succeeded, $FAIL failed."

if [[ $FAIL -gt 0 ]]; then
  echo "Tip: Check that Parallels Documents mirroring is enabled."
  exit 1
fi

echo ""
echo "Next step: Press F5 in NinjaScript Editor to compile."
