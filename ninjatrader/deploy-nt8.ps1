# deploy-nt8.ps1 — Windows analogue of deploy-nt8.sh.
#
# Copies AddOns / Indicators / DrawingTools / Strategies / preset JSONs into
# NinjaTrader 8's bin\Custom folder, then seeds mode.json from the example.
# Run from the repo's `ninjatrader\` directory in PowerShell:
#
#   cd ninjatrader
#   .\deploy-nt8.ps1
#
# If PowerShell blocks the script with an execution-policy error, either:
#   1. Run once with: powershell -ExecutionPolicy Bypass -File .\deploy-nt8.ps1
#   2. Or set per-user policy: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#
# After this finishes, open NinjaTrader → NinjaScript Editor → press F5 to
# compile the deployed C# files.

$ErrorActionPreference = "Stop"

# ── Paths ────────────────────────────────────────────────────────────────
# Use the script's own directory as the source root so this works whether
# you run it from `ninjatrader\` or from the repo root.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# NT8's user folder. NT8 creates this on first compile, so it must already
# exist before this script runs. We verify the Strategies subfolder below.
$Nt8Custom = Join-Path $env:USERPROFILE "Documents\NinjaTrader 8\bin\Custom"

# Source directories on the repo side.
$StrategiesDir   = Join-Path $ScriptDir "strategies"
$AddOnsDir       = Join-Path $ScriptDir "AddOns"
$IndicatorsDir   = Join-Path $ScriptDir "Indicators"
$DrawingToolsDir = Join-Path $ScriptDir "DrawingTools"

# Preset JSONs consumed by PresetStrategy at runtime. They live in
# `bin\Custom\presets\` on the NT8 side — the dir doesn't exist on a fresh
# NT8 install, so we create it on demand below.
$PresetsDir = Join-Path $StrategiesDir "presets"

# ── Verify NT8 has been compiled at least once ──────────────────────────
# bin\Custom\Strategies is created the first time NT8 compiles. If it's
# missing, the user almost certainly hasn't launched NT8 yet.
$Nt8Strategies = Join-Path $Nt8Custom "Strategies"
if (-not (Test-Path $Nt8Strategies)) {
  Write-Host "ERROR: NinjaTrader custom folders not found at:" -ForegroundColor Red
  Write-Host "  $Nt8Strategies"
  Write-Host "Launch NinjaTrader, open NinjaScript Editor, press F5 to compile,"
  Write-Host "then re-run this script."
  exit 1
}

# ── Deploy helper ───────────────────────────────────────────────────────
# Copies every file from $SrcDir to $DestDir (created if missing) using a
# glob pattern. Returns counts via $script: scope so the caller can sum
# them up across multiple invocations.
$script:Success = 0
$script:Fail    = 0

function Copy-Folder {
  param(
    [string] $SrcDir,    # repo source dir, e.g. .\AddOns
    [string] $DestDir,   # NT8 dest dir, e.g. ...\bin\Custom\AddOns
    [string] $Pattern,   # glob, e.g. *.cs or *.json
    [string] $Label      # display label for output, e.g. "AddOns"
  )

  if (-not (Test-Path $SrcDir)) { return }

  # Make the destination dir if it doesn't exist (only matters for
  # presets\, which NT8 doesn't create itself).
  if (-not (Test-Path $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  }

  Get-ChildItem -Path $SrcDir -Filter $Pattern -File | ForEach-Object {
    $destPath = Join-Path $DestDir $_.Name
    try {
      Copy-Item -Path $_.FullName -Destination $destPath -Force
      Write-Host ("  OK    {0}/{1}" -f $Label, $_.Name)
      $script:Success++
    } catch {
      Write-Host ("  FAIL  {0}/{1}: {2}" -f $Label, $_.Name, $_.Exception.Message) -ForegroundColor Red
      $script:Fail++
    }
  }
}

# ── Deploy each folder ──────────────────────────────────────────────────
Write-Host "Deploying NQ strategies + AddOns + Indicators to NinjaTrader 8..."
Write-Host "──────────────────────────────────────────"

Copy-Folder $StrategiesDir   (Join-Path $Nt8Custom "Strategies")    "*.cs"   "Strategies"
Copy-Folder $AddOnsDir       (Join-Path $Nt8Custom "AddOns")        "*.cs"   "AddOns"
Copy-Folder $IndicatorsDir   (Join-Path $Nt8Custom "Indicators")    "*.cs"   "Indicators"
Copy-Folder $DrawingToolsDir (Join-Path $Nt8Custom "DrawingTools")  "*.cs"   "DrawingTools"

# Preset JSONs go into bin\Custom\presets\, which Copy-Folder will create
# on first run. PresetStrategy and its named subclasses look here at
# State.DataLoaded via NinjaTrader.Core.Globals.UserDataDir.
Copy-Folder $PresetsDir      (Join-Path $Nt8Custom "presets")       "*.json" "presets"

# ── Seed mode.json (Local Mode toggle) ──────────────────────────────────
# ModeConfig.cs reads bin\Custom\AddOns\mode.json on a 15s TTL. The web
# app overwrites this file when the user flips the toggle in /settings.
# We seed from mode.example.json on first deploy ONLY if the destination
# is missing — never overwrite an existing config so user edits and toggle
# writes from the web app stick.
$ModeExample = Join-Path $AddOnsDir "mode.example.json"
$ModeDest    = Join-Path $Nt8Custom "AddOns\mode.json"
if ((Test-Path $ModeExample) -and (-not (Test-Path $ModeDest))) {
  try {
    Copy-Item -Path $ModeExample -Destination $ModeDest -Force
    Write-Host "  OK    AddOns/mode.json (seeded)"
    $script:Success++
  } catch {
    Write-Host ("  FAIL  AddOns/mode.json: {0}" -f $_.Exception.Message) -ForegroundColor Red
    $script:Fail++
  }
}

# ── Summary ─────────────────────────────────────────────────────────────
Write-Host "──────────────────────────────────────────"
Write-Host ("Done: {0} succeeded, {1} failed." -f $script:Success, $script:Fail)

if ($script:Fail -gt 0) {
  Write-Host "Tip: Make sure no NT8 instance is locking the destination files."
  exit 1
}

Write-Host ""
Write-Host "Next step: Open NinjaTrader → NinjaScript Editor → press F5 to compile."
