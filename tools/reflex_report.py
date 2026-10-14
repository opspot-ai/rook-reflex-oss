#!/usr/bin/env python3
"""Derive per-run reflex latencies from telemetry.jsonl.

    python3 tools/reflex_report.py [--state-dir DIR] [--limit N] [--json]

Columns:
  route            plane chosen by the Reflex Router (A/B/C/D)
  t_route          ms from the first event of the run to the routing decision
  t_dispatch       ms to first model dispatch (llm_input, or model_call_started
                   on runtimes that use an alternate dispatch event)
  t_delivery       ms to the first successful message_sent for the session
  t_end            ms to agent_end
  delivered        whether the human saw anything
Reads metadata only; no prompt text is stored in telemetry.jsonl to begin with.
"""

import argparse
import json
import os
import sys
from datetime import datetime

DEFAULT_STATE = os.path.expanduser("~/.openclaw/state/rook-reflex")
DISPATCH_EVENTS = ("llm_input", "model_call_started")


def ms(a, b):
    if a is None or b is None:
        return None
    return int((b - a).total_seconds() * 1000)


def parse_ts(s):
    return datetime.strptime(s.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z")


def load(state_dir):
    path = os.path.join(state_dir, "telemetry.jsonl")
    runs = {}
    order = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            key = e.get("run_id") or e.get("session_key")
            if not key or e.get("event") == "gateway_start":
                continue
            r = runs.get(key)
            if r is None:
                r = {
                    "run_id": e.get("run_id"),
                    "session_key": e.get("session_key"),
                    "first": None,
                    "route": None,
                    "t_route": None,
                    "dispatch": None,
                    "delivery": None,
                    "end": None,
                    "delivered": False,
                    "end_reason": None,
                    "tool_calls": None,
                }
                runs[key] = r
                order.append(key)
            ts = parse_ts(e["ts"])
            if r["first"] is None:
                r["first"] = ts
            ev = e.get("event")
            if ev == "routed":
                r["route"] = e.get("plane")
                r["t_route"] = ts
            elif ev in DISPATCH_EVENTS and r["dispatch"] is None:
                r["dispatch"] = ts
            elif ev == "message_sent" and e.get("success") and r["delivery"] is None:
                r["delivery"] = ts
            elif ev == "agent_end":
                r["end"] = ts
                r["delivered"] = bool(e.get("delivery_seen"))
                r["end_reason"] = e.get("end_reason")
                r["tool_calls"] = e.get("tool_calls")
    return [runs[k] for k in order]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=DEFAULT_STATE)
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = load(args.state_dir)[-args.limit :]
    out = []
    for r in rows:
        out.append(
            {
                "run_id": (r["run_id"] or "")[:8],
                "session_key": r["session_key"],
                "route": r["route"],
                "t_route_ms": ms(r["first"], r["t_route"]),
                "t_dispatch_ms": ms(r["first"], r["dispatch"]),
                "t_delivery_ms": ms(r["first"], r["delivery"]),
                "t_end_ms": ms(r["first"], r["end"]),
                "delivered": r["delivered"],
                "tool_calls": r["tool_calls"],
                "end_reason": r["end_reason"],
            }
        )

    if args.json:
        json.dump(out, sys.stdout, indent=2)
        print()
        return 0

    fmt = "%-9s %-5s %9s %9s %9s %9s %6s %5s %s"
    print(fmt % ("run", "route", "t_route", "t_disp", "t_deliv", "t_end", "deliv", "tools", "end_reason"))
    for o in out:
        print(
            fmt
            % (
                o["run_id"],
                o["route"] or "-",
                o["t_route_ms"] if o["t_route_ms"] is not None else "-",
                o["t_dispatch_ms"] if o["t_dispatch_ms"] is not None else "-",
                o["t_delivery_ms"] if o["t_delivery_ms"] is not None else "-",
                o["t_end_ms"] if o["t_end_ms"] is not None else "-",
                "yes" if o["delivered"] else "no",
                o["tool_calls"] if o["tool_calls"] is not None else "-",
                o["end_reason"] or "-",
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
