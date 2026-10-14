#!/usr/bin/env /usr/bin/python3
"""Python driver for the rook-reflex Reflex Router truth table.

The classifier is JavaScript (it runs inside the OpenClaw plugin runtime), so this
driver shells out to node once, feeds it every case from router_cases.json, and
asserts the planes here. It is a Python wrapper for the same synthetic truth table.

    python3 tests/test_router.py

Exit 0 = all cases pass. Exit 1 = at least one mismatch (printed).
The authoritative unit tests are tests/test_router.mjs (node --test).
"""

import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ROUTER = os.path.join(REPO, "plugin", "rook-reflex", "src", "router.js")
CASES = os.path.join(HERE, "router_cases.json")

DRIVER = """
import { classify } from %(router)s;
import fs from "node:fs";
const table = JSON.parse(fs.readFileSync(%(cases)s, "utf8"));
const out = [];
for (const c of table.cases) {
  const text = c.generate ? c.generate.repeat.repeat(c.generate.times) : c.text;
  const d = classify({ text, ...(c.input || {}) });
  out.push({
    id: c.id,
    expect: c.expect,
    plane: d.plane,
    selected_plane: d.selected_plane,
    selected_mode: d.selected_mode,
    risk_class: d.risk_class,
    estimated_blocking_risk: d.estimated_blocking_risk,
    durability_required: d.durability_required,
    linear_required: d.linear_required,
    review_required: d.review_required,
    reason: d.reason,
  });
}
process.stdout.write(JSON.stringify(out));
"""


def run_router():
    script = DRIVER % {"router": json.dumps(ROUTER), "cases": json.dumps(CASES)}
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError("node driver failed:\n" + proc.stderr.strip())
    return json.loads(proc.stdout)


MODE_BY_PLANE = {
    "A": ("reflex", "direct"),
    "B": ("reflex", "detached"),
    "C": ("factory", "durable"),
    "D": ("board", "board"),
}


class RouterTruthTable(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.results = run_router()

    def test_table_size(self):
        self.assertGreaterEqual(len(self.results), 25)

    def test_every_plane_present(self):
        planes = {r["expect"] for r in self.results}
        self.assertEqual(planes, {"A", "B", "C", "D"})

    def test_planes_match(self):
        bad = [
            "%s: expected %s got %s (%s)" % (r["id"], r["expect"], r["plane"], r["reason"])
            for r in self.results
            if r["plane"] != r["expect"]
        ]
        self.assertEqual(bad, [], "\n" + "\n".join(bad))

    def test_mode_mapping(self):
        for r in self.results:
            plane, mode = MODE_BY_PLANE[r["expect"]]
            self.assertEqual(r["selected_plane"], plane, r["id"])
            self.assertEqual(r["selected_mode"], mode, r["id"])

    def test_gate_flags(self):
        for r in self.results:
            self.assertEqual(r["durability_required"], r["expect"] == "C", r["id"])
            self.assertEqual(r["linear_required"], r["expect"] in ("C", "D"), r["id"])
            self.assertEqual(r["review_required"], r["expect"] in ("C", "D"), r["id"])

    def test_risk_class_domain(self):
        for r in self.results:
            self.assertIn(r["risk_class"], ("low", "moderate", "high"), r["id"])
            self.assertIn(r["estimated_blocking_risk"], ("low", "medium", "high"), r["id"])
            if r["expect"] == "D":
                self.assertEqual(r["risk_class"], "high", r["id"])


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
