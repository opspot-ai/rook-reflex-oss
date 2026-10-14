/**
 * Harness tests for the rook-reflex hook wiring.
 *
 *   node --test tests/test_hooks.mjs
 *
 * Drives the real register() with a fake plugin API and a throwaway state directory.
 * It checks receipt and telemetry file shapes without starting a live gateway.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../plugin/rook-reflex/index.js";

function harness(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rook-reflex-test-"));
  const hooks = new Map();
  const api = {
    id: "rook-reflex",
    pluginConfig: { stateDir, ...overrides },
    on(name, handler) {
      const list = hooks.get(name) || [];
      list.push(handler);
      hooks.set(name, list);
    },
  };
  plugin.register(api);
  const fire = async (name, event, ctx) => {
    let last;
    for (const h of hooks.get(name) || []) last = await h(event, ctx);
    return last;
  };
  const readJsonl = (file) => {
    const p = path.join(stateDir, file);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  };
  const receipts = () => {
    const root = path.join(stateDir, "receipts");
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const day of fs.readdirSync(root)) {
      for (const f of fs.readdirSync(path.join(root, day))) {
        out.push(JSON.parse(fs.readFileSync(path.join(root, day, f), "utf8")));
      }
    }
    return out;
  };
  return { api, hooks, fire, stateDir, readJsonl, receipts };
}

const TG = {
  runId: "run-1",
  sessionKey: "agent:main:telegram:direct:test-chat",
  channel: "telegram",
  messageProvider: "telegram",
  chatId: "test-chat",
  agentId: "main",
};

test("registers exactly the hooks the layer needs", () => {
  const h = harness();
  const names = [...h.hooks.keys()].sort();
  assert.deepEqual(names, [
    "after_tool_call",
    "agent_end",
    "before_prompt_build",
    "gateway_start",
    "llm_input",
    "llm_output",
    "message_received",
    "message_sent",
    "model_call_ended",
    "model_call_started",
  ]);
});

test("message_received writes a metadata-only receipt line", async () => {
  const h = harness();
  await h.fire(
    "message_received",
    {
      from: "synthetic-user",
      content: "hey rook, quick one",
      messageId: "m-1",
      timestamp: Date.parse("2026-01-01T12:00:00Z"),
      sessionKey: TG.sessionKey,
      metadata: {},
    },
    { ...TG, channelId: "telegram" },
  );
  const lines = h.readJsonl("telemetry.jsonl");
  const rec = lines.find((l) => l.event === "message_received");
  assert.ok(rec, "no message_received line");
  assert.match(rec.request_id, /^[0-9a-f]{16}$/);
  assert.equal(rec.text_len, "hey rook, quick one".length);
  assert.equal(rec.has_media, false);
  assert.ok(!("content" in rec), "raw content must never be persisted");
});

test("before_prompt_build routes, writes a receipt, and returns a hint", async () => {
  const h = harness();
  const out = await h.fire(
    "before_prompt_build",
    { prompt: "research X across several sources and give me a full report", messages: [] },
    TG,
  );
  assert.ok(out?.prependContext, "expected a prependContext hint");
  assert.ok(out.prependContext.length <= 350);
  assert.match(out.prependContext, /sessions_spawn/);

  const [r] = h.receipts();
  assert.ok(r, "no receipt written");
  for (const key of [
    "request_id",
    "received_at",
    "interpreted_outcome",
    "selected_plane",
    "selected_mode",
    "reason",
    "risk_class",
    "estimated_blocking_risk",
    "model_route",
    "durability_required",
    "linear_required",
    "review_required",
    "delivery_destination",
  ]) {
    assert.ok(key in r, `receipt missing ${key}`);
  }
  assert.equal(r.selected_plane, "reflex");
  assert.equal(r.selected_mode, "detached");
  assert.equal(r.delivery_destination, "telegram:test-chat");
  assert.ok(r.interpreted_outcome.length <= 120);
});

test("heartbeat / cron / subagent turns get no hint and no receipt", async () => {
  for (const ctx of [
    { ...TG, trigger: "heartbeat" },
    { ...TG, jobId: "cron-7" },
    { ...TG, sessionKey: "agent:main:subagent:abc123" },
    // The trigger is absent; the session key still identifies a system turn.
    { ...TG, sessionKey: "agent:main:main:heartbeat", trigger: undefined },
    { ...TG, sessionKey: "agent:main:cron:nightly-sweep", trigger: undefined },
    { ...TG, channel: "discord", messageProvider: "discord" },
  ]) {
    const h = harness();
    const out = await h.fire("before_prompt_build", { prompt: "deploy to production", messages: [] }, ctx);
    assert.equal(out, undefined, JSON.stringify(ctx));
    assert.equal(h.receipts().length, 0);
    const skipped = h.readJsonl("telemetry.jsonl").filter((l) => l.event === "routed_skipped");
    assert.equal(skipped.length, 1);
  }
});

test("a rebuilt prompt in the same run reuses the hint and writes no second receipt", async () => {
  const h = harness();
  const ev = { prompt: "research X across several sources and give me a full report", messages: [] };
  const first = await h.fire("before_prompt_build", ev, TG);
  const second = await h.fire("before_prompt_build", ev, TG);
  assert.equal(second.prependContext, first.prependContext);
  assert.equal(h.receipts().length, 1, "duplicate receipt written for one run");
  const repeats = h.readJsonl("telemetry.jsonl").filter((l) => l.event === "routed_repeat");
  assert.equal(repeats.length, 1);
});

test("command-only messages get no hint", async () => {
  const h = harness();
  const out = await h.fire("before_prompt_build", { prompt: "/stop", messages: [] }, TG);
  assert.equal(out, undefined);
  assert.equal(h.receipts().length, 0);
});

test("hintOnDirect:false suppresses the route-A line but still writes the receipt", async () => {
  const h = harness({ hintOnDirect: false });
  const out = await h.fire("before_prompt_build", { prompt: "what time is it", messages: [] }, TG);
  assert.equal(out, undefined);
  assert.equal(h.receipts()[0].selected_mode, "direct");
});

test("telemetry carries first dispatch, delivery, and run end", async () => {
  const h = harness();
  await h.fire("before_prompt_build", { prompt: "what time is it", messages: [] }, TG);
  await h.fire(
    "llm_input",
    { runId: "run-1", sessionId: "s", provider: "openai", model: "test-model", prompt: "p", historyMessages: [], imagesCount: 0, tools: [] },
    TG,
  );
  await h.fire("message_sent", { to: "test-chat", content: "10:00", success: true }, TG);
  await h.fire("agent_end", { runId: "run-1", messages: [1, 2], success: true, durationMs: 1234 }, TG);

  const lines = h.readJsonl("telemetry.jsonl");
  const events = lines.map((l) => l.event);
  for (const e of ["routed", "llm_input", "message_sent", "agent_end"]) {
    assert.ok(events.includes(e), `missing ${e}`);
  }
  const end = lines.find((l) => l.event === "agent_end");
  assert.equal(end.delivery_seen, true);
  assert.equal(end.silent_run, false);
  assert.equal(typeof end.first_dispatch_ms, "number");
  assert.equal(h.readJsonl("undelivered.jsonl").length, 0);
});

test("a silent Telegram run (tool calls, no delivery) is recorded as undelivered", async () => {
  const h = harness();
  await h.fire("before_prompt_build", { prompt: "check the delivery queue", messages: [] }, TG);
  await h.fire("after_tool_call", { toolName: "bash" }, TG);
  await h.fire("after_tool_call", { toolName: "apply_patch" }, TG);
  await h.fire("agent_end", { runId: "run-1", messages: [], success: true, durationMs: 4200 }, TG);

  const un = h.readJsonl("undelivered.jsonl");
  assert.equal(un.length, 1);
  assert.equal(un[0].run_id, "run-1");
  assert.equal(un[0].session_key, TG.sessionKey);
  assert.equal(un[0].delivery_seen, false);
  assert.equal(un[0].reason, "silent_run");
  assert.equal(un[0].last_tool, "apply_patch");
  assert.ok(un[0].ended_at);
});

test("a cancelled run is recorded regardless of channel or tool count", async () => {
  const h = harness();
  await h.fire("before_prompt_build", { prompt: "what time is it", messages: [] }, TG);
  await h.fire(
    "agent_end",
    { runId: "run-1", messages: [], success: false, error: "run_cancelled", durationMs: 9 },
    TG,
  );
  const un = h.readJsonl("undelivered.jsonl");
  assert.equal(un.length, 1);
  assert.equal(un[0].reason, "cancelled");
});

test("a timed-out run is recorded with reason timed_out", async () => {
  const h = harness();
  await h.fire("before_prompt_build", { prompt: "what time is it", messages: [] }, TG);
  await h.fire(
    "agent_end",
    {
      runId: "run-1",
      messages: [],
      success: false,
      error: "request timed out waiting for completion",
    },
    TG,
  );
  assert.equal(h.readJsonl("undelivered.jsonl")[0].reason, "timed_out");
});

test("a webchat/CLI one-shot with tool calls is NOT flagged as undelivered", async () => {
  const h = harness();
  const ctx = { ...TG, channel: "webchat", messageProvider: "webchat", chatId: "test-chat" };
  await h.fire("before_prompt_build", { prompt: "check the delivery queue", messages: [] }, ctx);
  await h.fire("after_tool_call", { toolName: "bash" }, ctx);
  await h.fire("agent_end", { runId: "run-1", messages: [], success: true }, ctx);
  assert.equal(h.readJsonl("undelivered.jsonl").length, 0);
});

test("no persisted record contains tool arguments or long prompt text", async () => {
  const h = harness();
  const secretish = `deploy to production with token sk-${"a".repeat(30)} ${"filler ".repeat(60)}`;
  await h.fire("before_prompt_build", { prompt: secretish, messages: [] }, TG);
  await h.fire("after_tool_call", { toolName: "bash", params: { command: "cat /path/to/credentials.json" } }, TG);
  await h.fire("agent_end", { runId: "run-1", messages: [], success: true }, TG);

  const blob = [
    fs.readFileSync(path.join(h.stateDir, "telemetry.jsonl"), "utf8"),
    JSON.stringify(h.receipts()),
    fs.existsSync(path.join(h.stateDir, "undelivered.jsonl"))
      ? fs.readFileSync(path.join(h.stateDir, "undelivered.jsonl"), "utf8")
      : "",
  ].join("\n");

  assert.ok(!blob.includes("credentials.json"), "tool args leaked");
  assert.ok(!blob.includes("sk-aaaaaaaaaa"), "secret-shaped token leaked");
  assert.ok(!blob.includes("filler ".repeat(20)), "prompt body leaked beyond the 120-char excerpt");
  for (const r of h.receipts()) assert.ok(r.interpreted_outcome.length <= 120);
});

test("hook handlers never throw even on garbage events", async () => {
  const h = harness();
  for (const name of [...h.hooks.keys()]) {
    await h.fire(name, undefined, undefined);
    await h.fire(name, { prompt: 42 }, { sessionKey: null });
  }
  assert.ok(true);
});


