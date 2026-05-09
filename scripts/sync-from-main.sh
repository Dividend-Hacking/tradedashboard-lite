#!/usr/bin/env bash
#
# sync-from-main.sh — Cherry-pick new commits from the upstream main repo
# into this lite repo.
#
# Why this exists:
#   tradedashboard-lite is a curated subset of tradedashboard. There's no
#   shared package or submodule — historically, updates were hand-picked
#   commit by commit. This script automates that flow so a sync becomes
#   "run one command, eyeball the result, push".
#
# What it does:
#   1. Ensures a `main-repo` git remote exists pointing at MAIN_REPO_PATH
#      (default: /Users/jordanscott/Desktop/tradedashboard). The remote is
#      a local file path because both repos live on the same machine —
#      no network round-trip and no auth.
#   2. Fetches main-repo/main.
#   3. Lists every commit on main-repo/main that's not in HEAD, oldest
#      first. The starting point is whichever is more recent of:
#        - the SHA recorded in scripts/.sync-state (last successful sync)
#        - the merge-base between HEAD and main-repo/main
#      Using the merge-base as a fallback means a fresh clone "just works"
#      even if .sync-state is missing.
#   4. For each commit, checks if every file it touches matches a glob in
#      scripts/.sync-exclude. If so, the commit is auto-skipped (logged
#      but not applied). This is the lite-vs-main divergence escape hatch
#      — e.g. exclude src/app/assistant/* to silently drop assistant-only
#      commits.
#   5. Otherwise, runs `git cherry-pick <sha>`. On conflict, the script
#      stops, prints a summary, and exits non-zero. The user resolves the
#      conflict by hand, runs `git cherry-pick --continue`, then re-runs
#      this script to pick up where it left off.
#   6. After all commits are applied, writes the latest applied SHA to
#      scripts/.sync-state.
#
# Usage:
#   ./scripts/sync-from-main.sh
#   ./scripts/sync-from-main.sh --dry-run            # preview, no mutation
#   ./scripts/sync-from-main.sh --from <sha>         # override baseline
#   ./scripts/sync-from-main.sh --main-repo <path>   # override default repo path
#
# Environment overrides:
#   MAIN_REPO_PATH    Path to the upstream main repo
#                     (default: /Users/jordanscott/Desktop/tradedashboard)
#
# Exit codes:
#   0  success (or nothing to do)
#   1  conflict during cherry-pick — manual resolution required
#   2  bad usage / config error
#
set -euo pipefail

# ─── Locate ourselves ──────────────────────────────────────────────
# Assume the script lives in <lite-repo>/scripts/. Resolve LITE_ROOT
# relative to this file so the script works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Defaults & flag parsing ──────────────────────────────────────
MAIN_REPO_PATH="${MAIN_REPO_PATH:-/Users/jordanscott/Desktop/tradedashboard}"
DRY_RUN=0
FROM_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --from)
      FROM_OVERRIDE="$2"
      shift 2
      ;;
    --main-repo)
      MAIN_REPO_PATH="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      echo "see --help for usage" >&2
      exit 2
      ;;
  esac
done

cd "$LITE_ROOT"

# ─── Sanity checks ─────────────────────────────────────────────────
if [[ ! -d "$MAIN_REPO_PATH/.git" ]]; then
  echo "ERROR: $MAIN_REPO_PATH is not a git repo" >&2
  echo "Set MAIN_REPO_PATH or use --main-repo to point at the upstream tradedashboard." >&2
  exit 2
fi

# Refuse to run with a dirty working tree — cherry-picking on top of
# uncommitted changes is asking for trouble.
if ! git diff-index --quiet HEAD --; then
  echo "ERROR: working tree has uncommitted changes — commit or stash first" >&2
  git status --short >&2
  exit 2
fi

# Refuse to run mid-cherry-pick (leftover from a prior conflict).
if [[ -d .git/CHERRY_PICK_HEAD || -f .git/CHERRY_PICK_HEAD ]]; then
  echo "ERROR: a cherry-pick is already in progress" >&2
  echo "Resolve conflicts and run 'git cherry-pick --continue', or '--abort', then re-run." >&2
  exit 2
fi

# ─── Ensure remote ─────────────────────────────────────────────────
# Idempotent: add main-repo if missing, otherwise update its URL in case
# MAIN_REPO_PATH changed since the last run.
if git remote get-url main-repo >/dev/null 2>&1; then
  current_url="$(git remote get-url main-repo)"
  if [[ "$current_url" != "$MAIN_REPO_PATH" ]]; then
    echo "[setup] updating main-repo remote: $current_url → $MAIN_REPO_PATH"
    git remote set-url main-repo "$MAIN_REPO_PATH"
  fi
else
  echo "[setup] adding main-repo remote → $MAIN_REPO_PATH"
  git remote add main-repo "$MAIN_REPO_PATH"
fi

echo "[fetch] git fetch main-repo"
git fetch --quiet main-repo

# ─── Determine baseline ────────────────────────────────────────────
# Priority: explicit --from > scripts/.sync-state > merge-base.
#
# Note: lite and main have INDEPENDENT commit histories — they share
# files, not commits. So `git merge-base` will usually fail, and we
# require .sync-state to be present (or --from to be passed) for the
# script to know where to start. The only time merge-base helps is if
# someone reorganizes the repos to share a parent, which we still
# accept gracefully.
STATE_FILE="$LITE_ROOT/scripts/.sync-state"
BASELINE=""

if [[ -n "$FROM_OVERRIDE" ]]; then
  BASELINE="$FROM_OVERRIDE"
  echo "[baseline] using --from override: $BASELINE"
elif [[ -f "$STATE_FILE" ]]; then
  BASELINE="$(tr -d '[:space:]' < "$STATE_FILE")"
  echo "[baseline] from .sync-state: $BASELINE"
fi

# Validate that BASELINE actually exists as a commit (in either repo's
# object database — fetch already pulled main-repo/main into ours).
if [[ -n "$BASELINE" ]] && ! git cat-file -e "$BASELINE^{commit}" 2>/dev/null; then
  echo "ERROR: baseline $BASELINE is not a known commit in this repo." >&2
  echo "Stale .sync-state? Force-pushed main? Pass --from <sha> with a known good commit." >&2
  exit 2
fi

# No explicit baseline — try merge-base as a last resort.
if [[ -z "$BASELINE" ]]; then
  if MB="$(git merge-base HEAD main-repo/main 2>/dev/null)" && [[ -n "$MB" ]]; then
    BASELINE="$MB"
    echo "[baseline] merge-base HEAD..main-repo/main: $BASELINE"
  else
    echo "ERROR: no baseline available." >&2
    echo "  - scripts/.sync-state is missing, and" >&2
    echo "  - this repo has no merge-base with main-repo/main (independent histories)." >&2
    echo
    echo "First-time setup: pick the upstream SHA you've already synced to and run:" >&2
    echo "  echo <main-repo-sha> > scripts/.sync-state" >&2
    echo "Then re-run this script. (Or pass --from <sha>.)" >&2
    exit 2
  fi
fi

# ─── List candidate commits ────────────────────────────────────────
# `git log --reverse $BASELINE..main-repo/main` gives every commit reachable
# from main-repo/main but not from BASELINE, oldest first. We then filter
# out anything already in HEAD via `git cherry` — which is necessary
# because BASELINE may be behind HEAD if the user manually cherry-picked
# something already.
# macOS still ships bash 3.2, so we avoid `mapfile` and associative
# arrays — both bash 4+ features. `read` loops + space-delimited string
# membership tests work everywhere.
CANDIDATES=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  CANDIDATES+=("$line")
done < <(git log --reverse --format='%H' "$BASELINE..main-repo/main")

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
  echo "[sync] 0 new commits to sync — already up to date."
  exit 0
fi

# Build a space-delimited list of upstream commit SHAs that `git cherry`
# says are already represented in HEAD's history (matched by patch-id —
# i.e. the user manually cherry-picked them). Membership test below uses
# substring match against this string.
IN_HEAD_PATCHES=" "
while read -r mark sha; do
  if [[ "$mark" == "-" ]]; then
    IN_HEAD_PATCHES+="$sha "
  fi
done < <(git cherry HEAD main-repo/main "$BASELINE" 2>/dev/null || true)

# ─── Load exclude globs ────────────────────────────────────────────
EXCLUDE_FILE="$LITE_ROOT/scripts/.sync-exclude"
EXCLUDES=()
if [[ -f "$EXCLUDE_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    # strip comments and whitespace
    line="${line%%#*}"
    line="${line## }"
    line="${line%% }"
    [[ -z "$line" ]] && continue
    EXCLUDES+=("$line")
  done < "$EXCLUDE_FILE"
fi

# Returns 0 (true) if every file in the commit matches at least one
# exclude glob — i.e. the commit is purely upstream-only and should be
# auto-skipped. Returns 1 otherwise.
all_files_excluded() {
  local sha="$1"
  local file
  local matched_any=0
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    matched_any=1
    local matched=0
    for pat in "${EXCLUDES[@]}"; do
      # shellcheck disable=SC2053  # we want glob matching, not literal
      if [[ "$file" == $pat ]]; then
        matched=1
        break
      fi
    done
    if [[ $matched -eq 0 ]]; then
      return 1
    fi
  done < <(git show --name-only --format='' "$sha")
  # If the commit had no files (rare — empty commit), don't skip it.
  [[ $matched_any -eq 1 ]]
}

# ─── Plan output ───────────────────────────────────────────────────
echo
echo "[plan] ${#CANDIDATES[@]} candidate commit(s) since $BASELINE:"
PLAN_APPLY=()
PLAN_SKIP_EXCLUDED=()
PLAN_SKIP_PRESENT=()
for sha in "${CANDIDATES[@]}"; do
  short="$(git rev-parse --short "$sha")"
  subject="$(git log -1 --format='%s' "$sha")"
  if [[ "$IN_HEAD_PATCHES" == *" $sha "* ]]; then
    PLAN_SKIP_PRESENT+=("$sha")
    echo "  [skip:already-in-HEAD]  $short  $subject"
  elif [[ ${#EXCLUDES[@]} -gt 0 ]] && all_files_excluded "$sha"; then
    PLAN_SKIP_EXCLUDED+=("$sha")
    echo "  [skip:excluded-paths]   $short  $subject"
  else
    PLAN_APPLY+=("$sha")
    echo "  [apply]                 $short  $subject"
  fi
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "[dry-run] would apply ${#PLAN_APPLY[@]}, skip ${#PLAN_SKIP_EXCLUDED[@]} excluded, skip ${#PLAN_SKIP_PRESENT[@]} already-present"
  exit 0
fi

if [[ ${#PLAN_APPLY[@]} -eq 0 ]]; then
  echo
  echo "[sync] nothing to apply (all commits already present or excluded)."
  # Even when nothing is applied, advance the cursor so future runs
  # don't re-enumerate the same commits.
  echo "${CANDIDATES[$((${#CANDIDATES[@]}-1))]}" > "$STATE_FILE"
  echo "[state] cursor advanced to ${CANDIDATES[$((${#CANDIDATES[@]}-1))]}"
  exit 0
fi

# ─── Apply ─────────────────────────────────────────────────────────
echo
LAST_APPLIED=""
for sha in "${PLAN_APPLY[@]}"; do
  short="$(git rev-parse --short "$sha")"
  subject="$(git log -1 --format='%s' "$sha")"
  echo "[apply] $short  $subject"
  if ! git cherry-pick "$sha"; then
    echo
    echo "ERROR: cherry-pick of $short conflicted." >&2
    echo "Resolve the conflicts, run 'git cherry-pick --continue', then re-run this script." >&2
    echo "Or run 'git cherry-pick --abort' to roll back." >&2
    # Don't update .sync-state — next run will retry from the same baseline.
    exit 1
  fi
  LAST_APPLIED="$sha"
done

# Cursor advances to the LATEST candidate (not just last applied) so
# excluded commits don't get re-enumerated forever.
echo "${CANDIDATES[$((${#CANDIDATES[@]}-1))]}" > "$STATE_FILE"
echo
_last_idx=$((${#CANDIDATES[@]}-1))
echo "[done] applied ${#PLAN_APPLY[@]} commit(s); cursor at ${CANDIDATES[$_last_idx]:0:7}"
echo "[reminder] review with 'git log --oneline' and push when ready."
