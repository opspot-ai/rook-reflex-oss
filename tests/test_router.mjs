/**
 * Unit tests for the rook-reflex deterministic Reflex Router.
 *
 *   node --test tests/test_router.mjs
 *
 * The case table lives in router_cases.json so tests/test_router.py asserts the
 * exact same truth table.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, isCommandOnly, countDistinctAsks, normalizeText } from "../plugin/rook-reflex/src/router.js";
import { buildHint } from "../plugin/rook-reflex/src/hint.js";
import { sanitize, requestId } from "../plugin/rook-reflex/src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const table = JSON.parse(fs.readFileSync(path.join(here, "router_cases.json"), "utf8"));

export function materialize(c) {
  if (c.generate) return c.generate.repeat.repeat(c.generate.times);
  return c.text;
}

test("case table covers at least 25 prompts", () => {
  assert.ok(table.cases.length >= 25, `only ${table.cases.length} cases`);
});

test("every plane is represented", () => {
  const planes = new Set(table.cases.map((c) => c.expect));
  for (const p of ["A", "B", "C", "D"]) assert.ok(planes.has(p), `plane ${p} missing`);
});

for (const c of table.cases) {
  test(`route ${c.expect}: ${c.id}`, () => {
    const text = materialize(c);
    const got = classify({ text, ...(c.input || {}) });
    assert.equal(
      got.plane,
      c.expect,
      `${c.id}: expected ${c.expect}, got ${got.plane} (${got.reason}) [${got.signals.join(",")}]`,
    );
  });
}

test("plane -> mode mapping is stable", () => {
  const map = {
    A: ["reflex", "direct"],
    B: ["reflex", "detached"],
    C: ["factory", "durable"],
    D: ["board", "board"],
  };
  for (const c of table.cases) {
    const got = classify({ text: materialize(c), ...(c.input || {}) });
    const [plane, mode] = map[c.expect];
    assert.equal(got.selected_plane, plane, c.id);
    assert.equal(got.selected_mode, mode, c.id);
  }
});

test("durability/linear/review flags follow the plane", () => {
  const a = classify({ text: "what time is it" });
  assert.equal(a.durability_required, false);
  assert.equal(a.linear_required, false);
  assert.equal(a.review_required, false);

  const c = classify({ text: "deploy the sample service to production" });
  assert.equal(c.durability_required, true);
  assert.equal(c.linear_required, true);
  assert.equal(c.review_required, true);

  const d = classify({ text: "pay the Example Vendor invoice" });
  assert.equal(d.durability_required, false);
  assert.equal(d.linear_required, true);
  assert.equal(d.review_required, true);
  assert.equal(d.risk_class, "high");
});

test("blocking-risk estimate is high for B and C, low for A and D", () => {
  assert.equal(classify({ text: "what's 17*23" }).estimated_blocking_risk, "low");
  assert.equal(
    classify({ text: "research X across several sources and give me a full report" })
      .estimated_blocking_risk,
    "high",
  );
  assert.equal(
    classify({ text: "implement a change in ~/Products/foo and open a PR" }).estimated_blocking_risk,
    "high",
  );
  assert.equal(classify({ text: "pay the Example Vendor invoice" }).estimated_blocking_risk, "low");
});

test("classifier is deterministic and pure", () => {
  const input = { text: "audit the routing configuration and tell me what is mistuned" };
  const a = JSON.stringify(classify(input));
  const b = JSON.stringify(classify(input));
  assert.equal(a, b);
  assert.equal(input.text, "audit the routing configuration and tell me what is mistuned");
});

test("command-only messages are detected", () => {
  for (const s of ["/stop", "/new", "/think high", "  /context json  "]) {
    assert.ok(isCommandOnly(s), s);
  }
  for (const s of ["/stop the deploy and roll back production now", "stop", "what is /new"]) {
    assert.ok(!isCommandOnly(s), s);
  }
});

test("ask counting splits multi-part messages", () => {
  assert.ok(countDistinctAsks(normalizeText("what time is it?")) >= 1);
  assert.ok(
    countDistinctAsks(
      normalizeText("check the weather. also find me coffee. and tell me the churn number."),
    ) > 2,
  );
});

test("hints stay inside the char cap and carry the override clause", () => {
  for (const plane of ["A", "B", "C", "D"]) {
    const h = buildHint(plane, 350);
    assert.ok(h.length <= 350, `${plane} hint is ${h.length} chars`);
    assert.match(h, /judgment overrides/i);
  }
  assert.ok(buildHint("A", 350).length < 120, "route A hint must stay one short line");
  assert.match(buildHint("B", 350), /sessions_spawn/);
  assert.match(buildHint("B", 350), /NOT Codex spawn_agent/);
  assert.match(buildHint("C", 350), /durable engineering workflow/);
  assert.match(buildHint("D", 350), /ask the owner/i);
  assert.equal(buildHint("C", 60).length, 60);
});

test("sanitize truncates, strips control chars, and redacts secret shapes", () => {
  const long = "x".repeat(500);
  assert.equal(sanitize(long, 120).length, 120);
  assert.equal(sanitize("a\u0007b\tc"), "a b c");
  assert.match(sanitize("token sk-abcdefghijklmnopqrstuvwx"), /\[redacted\]/);
  assert.match(sanitize("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), /\[redacted\]/);
  assert.match(sanitize("Authorization: Bearer abcdefghijklmnopqrstuvwx"), /\[redacted\]/);
  assert.ok(!sanitize("token sk-abcdefghijklmnopqrstuvwx").includes("abcdefghij"));
});

test("requestId is a stable 16-hex hash of channel|messageId|ts", () => {
  const a = requestId("telegram", "123", "2026-01-01T00:00:00.000Z");
  const b = requestId("telegram", "123", "2026-01-01T00:00:00.000Z");
  const c = requestId("telegram", "124", "2026-01-01T00:00:00.000Z");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});
