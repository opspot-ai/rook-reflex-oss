#!/bin/sh
# Install the Rook Reflex skills into the agent workspace.
# Some runtime skill scanners do not follow symlinks. Copying the files avoids that issue.
# Re-run after editing any SKILL.md in the repository.
set -e
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=${REPO:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}
WS="${WS:-$HOME/.openclaw/workspace/skills}"
for n in detached-reflex environment-awareness inspect-unknown-media transcribe-anything synthesize-voice-response; do
  mkdir -p "$WS/$n"
  cp "$REPO/$n/SKILL.md" "$WS/$n/SKILL.md"
  echo "installed $n"
done
