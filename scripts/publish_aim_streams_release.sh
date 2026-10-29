#!/usr/bin/env bash
# Publish extracted AiM TCP streams to the aim-streams-v1 GitHub release so CI
# can run the capture replay tests. Requires the GitHub CLI (`gh auth login`).
#
# The repo is public: release assets are downloadable by anyone. Only the
# extracted AiM payload bytes are uploaded (no raw .pcapng, no MAC/IP headers),
# but they do include the logger serial/vehicle name and the pulled log files.
#
# Usage (from repo root):
#   python scripts/extract_aim_streams.py ~/Downloads
#   scripts/publish_aim_streams_release.sh
set -euo pipefail
cd "$(dirname "$0")/.."

dir="tests/fixtures/aim_streams"
shopt -s nullglob
files=("$dir"/*.bin.gz)
if [ ${#files[@]} -eq 0 ]; then
  echo "No $dir/*.bin.gz files. Run: python scripts/extract_aim_streams.py ~/Downloads" >&2
  exit 1
fi

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Publishing ${#files[@]} file(s) to aim-streams-v1 on $repo ..."
if gh release view aim-streams-v1 --repo "$repo" >/dev/null 2>&1; then
  gh release upload aim-streams-v1 "${files[@]}" --repo "$repo" --clobber
else
  gh release create aim-streams-v1 "${files[@]}" --repo "$repo" \
    --title "AiM capture streams v1" \
    --notes "Extracted AiM TCP streams for CI protocol replay tests (scripts/extract_aim_streams.py)."
fi
echo "Done. Verify: gh release view aim-streams-v1 --repo $repo"
