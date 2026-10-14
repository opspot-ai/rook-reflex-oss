#!/usr/bin/env python3
"""Emit the exact `openclaw config patch` payload that installs rook-reflex.

`openclaw config patch` merges objects but REPLACES arrays, so plugins.allow and
plugins.load.paths must be written as the full resulting list. This reads the live
config, unions in what rook-reflex needs, and prints JSON on stdout.

    python3 tools/build_plugin_patch.py            # print patch
    python3 tools/build_plugin_patch.py --apply    # mutate the local OpenClaw configuration

Never prints secret values: only plugins.allow / plugins.load.paths /
plugins.entries['rook-reflex'] are emitted.
"""

import argparse
import json
import os
import subprocess
import sys

PLUGIN_ID = "rook-reflex"
PLUGIN_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", PLUGIN_ID)
)
CONFIG_PATH = os.path.expanduser("~/.openclaw/openclaw.json")

ENTRY = {
    "enabled": True,
    "hooks": {
        "allowConversationAccess": True,
        "allowPromptInjection": True,
        "timeouts": {"before_prompt_build": 5000, "agent_end": 10000},
    },
    "config": {
        "enabled": True,
        "stateDir": "~/.openclaw/state/rook-reflex",
        "hintOnDirect": True,
        "maxHintChars": 350,
        "directChannels": ["telegram", "imessage", "webchat", "web"],
        "includeChannellessRuns": True,
    },
}


def build():
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    plugins = cfg.get("plugins") or {}

    allow = list(plugins.get("allow") or [])
    if PLUGIN_ID not in allow:
        allow.append(PLUGIN_ID)

    paths = list(((plugins.get("load") or {}).get("paths")) or [])
    if PLUGIN_DIR not in paths:
        paths.append(PLUGIN_DIR)

    return {
        "plugins": {
            "allow": sorted(allow),
            "load": {"paths": paths},
            "entries": {PLUGIN_ID: ENTRY},
        }
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes to the local OpenClaw configuration via openclaw config patch --stdin",
    )
    args = ap.parse_args()

    patch = build()
    payload = json.dumps(patch, indent=2)
    if not args.apply:
        print(payload)
        return 0

    proc = subprocess.run(
        ["openclaw", "config", "patch", "--stdin"],
        input=payload,
        capture_output=True,
        text=True,
        timeout=120,
    )
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
