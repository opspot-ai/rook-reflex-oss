/**
 * rook-reflex — Reflex Router + latency telemetry + undelivered-run recorder.
 *
 * Plain ESM. No runtime dependencies, no SDK import (the loader accepts a default
 * export exposing `register`; see dist/loader-*.js resolvePluginModuleExport).
 *
 * Hooks
 *   message_received     inbound receipt (metadata only)
 *   before_prompt_build  deterministic Reflex Router -> prependContext hint + receipt JSON
 *   llm_input/llm_output first model dispatch + model completion (Codex harness)
 *   model_call_started/ended  same, for non-Codex harnesses
 *   after_tool_call      tool count + last tool NAME (never args)
 *   message_sent         first visible delivery
 *   agent_end            run end + undelivered-run detection
 *
 * Privacy contract: no prompt text beyond 120 sanitized chars, no tool arguments,
 * no model output, no secrets. See src/store.js sanitize().
 */

import { classify, isCommandOnly, DEFAULTS as ROUTER_DEFAULTS } from "./src/router.js";
import { buildHint } from "./src/hint.js";
import { createStore, sanitize, requestId, INTERPRETED_MAX } from "./src/store.js";

const PLUGIN_ID = "rook-reflex";

const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  stateDir: "~/.openclaw/state/rook-reflex",
  hintOnDirect: true,
  maxHintChars: 350,
  directChannels: ["telegram", "imessage", "webchat", "web"],
  includeChannellessRuns: true,
  // Track abnormal runs for the configured user-facing channels.
  undeliveredChannels: ["telegram", "imessage"],
  longPromptChars: ROUTER_DEFAULTS.longPromptChars,
  longDocChars: ROUTER_DEFAULTS.longDocChars,
  maxDistinctAsks: ROUTER_DEFAULTS.maxDistinctAsks,
  longMediaSeconds: ROUTER_DEFAULTS.longMediaSeconds,
  modelRoutes: {
    reflex: "inline:primary",
    detached: "spawn:sessions_spawn/default",
    durable: "spawn:sessions_spawn/durable",
    board: "inline:primary",
  },
});

// Session keys provide a second filter when system turns lack a trigger label.
const ANNOUNCE_RE =
  /A background task completed\. Use this result|\[Internal task completion event\]|OpenClaw runtime context \(internal\)/;
const SKIP_SESSION_RE =
  /(?::heartbeat\b|:heartbeat:|:cron\b|:cron:|:followup\b|:exec-event\b|:announce\b|:subagent\b|:acp\b|:task:)/i;

const SKIP_TRIGGERS = new Set([
  "heartbeat",
  "cron",
  "schedule",
  "scheduled",
  "exec-event",
  "exec_event",
  "system",
  "followup",
  "subagent",
  "subagent-announce",
]);

const MEDIA_MARKER_RE =
  /\[(image|photo|voice|audio|video|document|file|attachment)[^\]]{0,40}\]|\b(voice note|voice message|attachment:|media:)\b/i;

const AUDIO_RE = /\b(voice note|voice message|audio|\.mp3|\.m4a|\.ogg|\.wav|\.opus)\b/i;
const VIDEO_RE = /\b(video|\.mp4|\.mov|\.mkv|\.webm|screen recording)\b/i;
const DOC_RE = /\b(pdf|\.docx?|\.txt|\.md|document|transcript file)\b/i;

const MAX_TRACKED_RUNS = 400;
const MAX_TRACKED_SESSIONS = 200;

// ------------------------------------------------------------------ config

function coerceConfig(raw) {
  const c = { ...CONFIG_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  c.modelRoutes = { ...CONFIG_DEFAULTS.modelRoutes, ...(raw?.modelRoutes || {}) };
  if (!Array.isArray(c.directChannels)) c.directChannels = [...CONFIG_DEFAULTS.directChannels];
  if (!Array.isArray(c.undeliveredChannels))
    c.undeliveredChannels = [...CONFIG_DEFAULTS.undeliveredChannels];
  c.maxHintChars = Math.max(40, Math.min(2000, Number(c.maxHintChars) || 350));
  return c;
}

const configSchema = {
  safeParse(value) {
    if (value === undefined || value === null) return { success: true, data: undefined };
    if (typeof value !== "object" || Array.isArray(value)) {
      return { success: false, error: { message: "rook-reflex config must be an object" } };
    }
    return { success: true, data: value };
  },
  jsonSchema: { type: "object", additionalProperties: true },
};

// ------------------------------------------------------------ small helpers

function nowIso() {
  return new Date().toISOString();
}

function boundedSet(map, key, value, limit) {
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function isSubagentSession(sessionKey) {
  const k = String(sessionKey || "");
  return (
    k.includes(":subagent:") ||
    k.includes(":subagent-") ||
    k.includes(":child:") ||
    k.includes(":acp:") ||
    /:task:[0-9a-f-]{8,}/.test(k)
  );
}

/** Direct human chat? Channelled sessions must be allowlisted; CLI runs are opt-in. */
function isDirectChat(ctx, cfg) {
  const channel = ctx?.channel || ctx?.messageProvider;
  if (!channel) return cfg.includeChannellessRuns === true;
  return cfg.directChannels.includes(String(channel).toLowerCase());
}

function shouldSkip(ctx, cfg) {
  if (cfg.enabled === false) return "disabled";
  const trigger = String(ctx?.trigger || "").toLowerCase();
  if (trigger && SKIP_TRIGGERS.has(trigger)) return `trigger:${trigger}`;
  if (ctx?.jobId) return "cron-job";
  if (isSubagentSession(ctx?.sessionKey)) return "subagent-session";
  if (SKIP_SESSION_RE.test(String(ctx?.sessionKey || ""))) return "system-session";
  if (!isDirectChat(ctx, cfg)) return "not-direct-chat";
  return null;
}

function detectMedia(text, receipt) {
  if (receipt && typeof receipt.has_media === "boolean") {
    return {
      hasMedia: receipt.has_media,
      mediaKind: receipt.media_kind || "unknown",
      mediaSeconds: receipt.media_seconds || 0,
    };
  }
  const hasMedia = MEDIA_MARKER_RE.test(text);
  let mediaKind = "unknown";
  if (hasMedia) {
    if (VIDEO_RE.test(text)) mediaKind = "video";
    else if (AUDIO_RE.test(text)) mediaKind = "audio";
    else if (DOC_RE.test(text)) mediaKind = "document";
    else if (/\b(image|photo|screenshot|\.png|\.jpe?g)\b/i.test(text)) mediaKind = "image";
  }
  return { hasMedia, mediaKind, mediaSeconds: 0 };
}

function deliveryDestination(ctx) {
  const channel = ctx?.channel || ctx?.messageProvider;
  const target = ctx?.chatId ?? ctx?.channelId ?? ctx?.senderId;
  if (!channel && !target) return "local:cli";
  return `${channel || "unknown"}:${target ?? "unknown"}`;
}

function classifyEndReason(event) {
  const err = String(event?.error || "").toLowerCase();
  if (/cancel/.test(err)) return "cancelled";
  if (/timed out|timeout/.test(err)) return "timed_out";
  if (/abort/.test(err)) return "aborted";
  if (event?.success === false) return "failed";
  return "no_delivery";
}

// --------------------------------------------------------------- the plugin

export function register(api) {
  // api.pluginConfig is this plugin's validated config block
  // (plugins.entries.rook-reflex.config). api.config is the whole OpenClaw config.
  const cfg = coerceConfig(api?.pluginConfig);
  const store = createStore(cfg.stateDir);

  /** sessionKey -> last inbound receipt (in-memory correlation only). */
  const inbound = new Map();
  /** runKey -> run state. */
  const runs = new Map();
  /** sessionKey -> last delivery timestamp (ms). */
  const lastDelivery = new Map();

  const runKey = (ctx) => String(ctx?.runId || ctx?.sessionKey || "unknown");

  const getRun = (ctx) => {
    const key = runKey(ctx);
    let r = runs.get(key);
    if (!r) {
      r = {
        run_id: ctx?.runId ?? null,
        session_key: ctx?.sessionKey ?? null,
        channel: ctx?.channel ?? ctx?.messageProvider ?? null,
        started_at_ms: Date.now(),
        tool_calls: 0,
        last_tool: null,
        delivery_seen: false,
        request_id: null,
        plane: null,
        direct: false,
        hint: undefined,
      };
      boundedSet(runs, key, r, MAX_TRACKED_RUNS);
    }
    return r;
  };

  const emit = (event, ctx, fields) => {
    store.telemetry({
      ts: nowIso(),
      event,
      plugin: PLUGIN_ID,
      session_key: ctx?.sessionKey ?? null,
      run_id: ctx?.runId ?? null,
      ...fields,
    });
  };

  const guard = (name, fn) => async (event, ctx) => {
    try {
      return await fn(event, ctx);
    } catch (err) {
      store.noteError(name, err);
      return undefined;
    }
  };

  // -- 1. message_received --------------------------------------------------
  api.on(
    "message_received",
    guard("message_received", (event, ctx) => {
      const channel = ctx?.channelId || ctx?.channel || "unknown";
      const receivedAt = event?.timestamp ? new Date(event.timestamp).toISOString() : nowIso();
      const text = typeof event?.content === "string" ? event.content : "";
      const meta = event?.metadata && typeof event.metadata === "object" ? event.metadata : {};
      const metaMedia =
        meta.hasMedia === true ||
        Array.isArray(meta.media) ||
        Array.isArray(meta.attachments) ||
        Boolean(meta.mediaType) ||
        Boolean(meta.mimeType);
      const sniffed = detectMedia(text, null);
      const rid = requestId(channel, event?.messageId, receivedAt);

      const receipt = {
        request_id: rid,
        session_key: event?.sessionKey ?? ctx?.sessionKey ?? null,
        channel: String(channel),
        received_at: receivedAt,
        has_media: metaMedia || sniffed.hasMedia,
        media_kind: sniffed.mediaKind,
        media_seconds: Number(meta.durationSeconds) || Number(meta.duration) || 0,
        text_len: text.length,
      };

      const skey = receipt.session_key;
      if (skey) boundedSet(inbound, skey, receipt, MAX_TRACKED_SESSIONS);
      emit("message_received", { sessionKey: skey, runId: ctx?.runId }, {
        request_id: receipt.request_id,
        channel: receipt.channel,
        received_at: receipt.received_at,
        has_media: receipt.has_media,
        text_len: receipt.text_len,
      });
    }),
    { priority: 60 },
  );

  // -- 2. before_prompt_build : the Reflex Router ---------------------------
  api.on(
    "before_prompt_build",
    guard("before_prompt_build", (event, ctx) => {
      const prompt = typeof event?.prompt === "string" ? event.prompt : "";
      const skip = shouldSkip(ctx, cfg);
      const run = getRun(ctx);

      if (skip) {
        run.direct = false;
        emit("routed_skipped", ctx, { skip_reason: skip });
        return undefined;
      }
      run.direct = true;
      const chan = String(ctx?.channel || ctx?.messageProvider || "").toLowerCase();
      run.silent_run_watch = cfg.undeliveredChannels.includes(chan);

      if (isCommandOnly(prompt)) {
        emit("routed_skipped", ctx, { skip_reason: "command-only" });
        return undefined;
      }
      // Runtime completion announcements are not direct user requests.
      if (String(ctx?.runId || "").startsWith("announce:") || ANNOUNCE_RE.test(prompt)) {
        run.hint = null;
        emit("routed_skipped", ctx, { skip_reason: "announce-turn" });
        return undefined;
      }

      // The Codex harness can rebuild the prompt more than once per run
      // (buildPromptFromCurrentInputs in dist/run-attempt-*.js). Route once, then
      // replay the same hint so the rebuilt prompt keeps it, without a duplicate receipt.
      if (run.hint !== undefined) {
        emit("routed_repeat", ctx, { request_id: run.request_id, plane: run.plane });
        return run.hint === null ? undefined : { prependContext: run.hint };
      }

      const skey = ctx?.sessionKey ?? null;
      const priorReceipt = skey ? inbound.get(skey) : null;
      const media = detectMedia(prompt, priorReceipt);
      const receivedAt = priorReceipt?.received_at || nowIso();
      const rid =
        priorReceipt?.request_id ||
        requestId(ctx?.channel || ctx?.messageProvider || "local", ctx?.runId || skey, receivedAt);

      const decision = classify(
        {
          text: prompt,
          hasMedia: media.hasMedia,
          mediaKind: media.mediaKind,
          mediaSeconds: media.mediaSeconds,
          attachedDocChars: priorReceipt?.text_len && priorReceipt.text_len > prompt.length
            ? priorReceipt.text_len
            : 0,
        },
        cfg,
      );

      const receipt = {
        request_id: rid,
        received_at: receivedAt,
        interpreted_outcome: sanitize(prompt, INTERPRETED_MAX),
        selected_plane: decision.selected_plane,
        selected_mode: decision.selected_mode,
        reason: decision.reason,
        risk_class: decision.risk_class,
        estimated_blocking_risk: decision.estimated_blocking_risk,
        model_route: cfg.modelRoutes[decision.selected_mode] || cfg.modelRoutes.reflex,
        durability_required: decision.durability_required,
        linear_required: decision.linear_required,
        review_required: decision.review_required,
        delivery_destination: deliveryDestination(ctx),
        // provenance (metadata only)
        plane: decision.plane,
        signals: decision.signals,
        session_key: skey,
        run_id: ctx?.runId ?? null,
        prompt_chars: prompt.length,
        has_media: media.hasMedia,
        routed_at: nowIso(),
        plugin_version: VERSION,
      };

      const file = store.writeReceipt(receipt);
      run.request_id = rid;
      run.plane = decision.plane;

      emit("routed", ctx, {
        request_id: rid,
        plane: decision.plane,
        selected_plane: decision.selected_plane,
        selected_mode: decision.selected_mode,
        risk_class: decision.risk_class,
        estimated_blocking_risk: decision.estimated_blocking_risk,
        prompt_chars: prompt.length,
        receipt_path: file,
      });

      if (decision.plane === "A" && cfg.hintOnDirect === false) {
        run.hint = null;
        return undefined;
      }
      run.hint = buildHint(decision.plane, cfg.maxHintChars);
      return { prependContext: run.hint };
    }),
    { priority: 40, timeoutMs: 5000 },
  );

  // -- 3. latency telemetry -------------------------------------------------
  api.on(
    "llm_input",
    guard("llm_input", (event, ctx) => {
      const run = getRun(ctx);
      if (!run.first_dispatch_ms) run.first_dispatch_ms = Date.now();
      emit("llm_input", ctx, {
        source: "llm_input",
        provider: event?.provider ?? null,
        model: event?.model ?? null,
        prompt_chars: typeof event?.prompt === "string" ? event.prompt.length : null,
        history_messages: Array.isArray(event?.historyMessages) ? event.historyMessages.length : null,
        images: Number(event?.imagesCount) || 0,
        tools: Array.isArray(event?.tools) ? event.tools.length : null,
      });
    }),
    { priority: 40 },
  );

  api.on(
    "llm_output",
    guard("llm_output", (event, ctx) => {
      emit("llm_output", ctx, {
        source: "llm_output",
        provider: event?.provider ?? null,
        model: event?.model ?? null,
        harness_id: event?.harnessId ?? null,
        assistant_texts: Array.isArray(event?.assistantTexts) ? event.assistantTexts.length : 0,
        assistant_chars: Array.isArray(event?.assistantTexts)
          ? event.assistantTexts.reduce((n, t) => n + (typeof t === "string" ? t.length : 0), 0)
          : 0,
        usage: event?.usage ?? null,
        reasoning_effort: event?.reasoningEffort ?? null,
        fast_mode: event?.fastMode ?? null,
      });
    }),
    { priority: 40 },
  );

  api.on(
    "model_call_started",
    guard("model_call_started", (event, ctx) => {
      const run = getRun(ctx);
      if (!run.first_dispatch_ms) run.first_dispatch_ms = Date.now();
      emit("model_call_started", ctx, {
        source: "model_call_started",
        call_id: event?.callId ?? null,
        provider: event?.provider ?? null,
        model: event?.model ?? null,
        api: event?.api ?? null,
        transport: event?.transport ?? null,
        context_token_budget: event?.contextTokenBudget ?? null,
      });
    }),
    { priority: 40 },
  );

  api.on(
    "model_call_ended",
    guard("model_call_ended", (event, ctx) => {
      emit("model_call_ended", ctx, {
        source: "model_call_ended",
        call_id: event?.callId ?? null,
        provider: event?.provider ?? null,
        model: event?.model ?? null,
        duration_ms: event?.durationMs ?? null,
        outcome: event?.outcome ?? null,
      });
    }),
    { priority: 40 },
  );

  // Tool arguments are not needed for this hook.

  api.on(
    "after_tool_call",
    guard("after_tool_call", (event, ctx) => {
      const run = getRun(ctx);
      run.tool_calls += 1;
      run.last_tool = typeof event?.toolName === "string" ? event.toolName.slice(0, 64) : null;
    }),
    { priority: 20 },
  );

  api.on(
    "message_sent",
    guard("message_sent", (event, ctx) => {
      const skey = ctx?.sessionKey ?? event?.sessionKey ?? null;
      const at = Date.now();
      if (skey) boundedSet(lastDelivery, skey, at, MAX_TRACKED_SESSIONS);
      for (const r of runs.values()) {
        if (skey && r.session_key === skey && event?.success !== false) {
          if (!r.first_delivery_ms) r.first_delivery_ms = at;
          r.delivery_seen = true;
        }
      }
      emit("message_sent", { sessionKey: skey, runId: ctx?.runId ?? event?.runId ?? null }, {
        success: event?.success !== false,
        content_chars: typeof event?.content === "string" ? event.content.length : 0,
        message_id: event?.messageId ?? null,
        error: event?.error ? sanitize(event.error, 160) : null,
      });
    }),
    { priority: 40 },
  );

  // -- 4. agent_end + undelivered-run recorder ------------------------------
  api.on(
    "agent_end",
    guard("agent_end", (event, ctx) => {
      const key = runKey(ctx);
      const run = getRun(ctx);
      const endedAt = nowIso();
      const reason = classifyEndReason(event);
      const abnormal = reason !== "no_delivery";
      const deliveredAt = run.session_key ? lastDelivery.get(run.session_key) : undefined;
      const delivered =
        run.delivery_seen || (typeof deliveredAt === "number" && deliveredAt >= run.started_at_ms);
      const silentDirect = run.silent_run_watch === true && !delivered && run.tool_calls >= 1;

      emit("agent_end", ctx, {
        success: event?.success !== false,
        duration_ms: event?.durationMs ?? null,
        messages: Array.isArray(event?.messages) ? event.messages.length : null,
        tool_calls: run.tool_calls,
        last_tool: run.last_tool,
        delivery_seen: delivered,
        plane: run.plane,
        request_id: run.request_id,
        first_dispatch_ms: run.first_dispatch_ms
          ? run.first_dispatch_ms - run.started_at_ms
          : null,
        first_delivery_ms: run.first_delivery_ms ? run.first_delivery_ms - run.started_at_ms : null,
        silent_run: silentDirect,
        end_reason: reason,
      });

      // Record undelivered outcomes only for direct user-facing runs.
      const owesDelivery = run.direct === true && !shouldSkip(ctx, cfg);
      // Delivery signals vary by host harness; abnormal outcomes are recorded as a fallback.
      if (owesDelivery && (event?.success === false || abnormal)) {
        store.undelivered({
          run_id: run.run_id ?? ctx?.runId ?? null,
          session_key: run.session_key ?? ctx?.sessionKey ?? null,
          ended_at: endedAt,
          reason: event?.success === false ? classifyEndReason(event) : reason === "no_delivery" ? "silent_run" : reason,
          last_tool: run.last_tool,
          delivery_seen: false,
          tool_calls: run.tool_calls,
          plane: run.plane,
          request_id: run.request_id,
          error: event?.error ? sanitize(event.error, 160) : null,
        });
      }

      runs.delete(key);
    }),
    { priority: 40, timeoutMs: 10000 },
  );

  api.on(
    "gateway_start",
    guard("gateway_start", () => {
      store.telemetry({
        ts: nowIso(),
        event: "gateway_start",
        plugin: PLUGIN_ID,
        version: VERSION,
        state_dir: store.stateDir,
      });
    }),
    { priority: 10 },
  );
}

export const VERSION = "0.1.0";

export default {
  id: PLUGIN_ID,
  name: "Rook Reflex",
  description:
    "Deterministic Reflex Router, latency telemetry, and undelivered-run recorder for Rook.",
  version: VERSION,
  configSchema,
  register,
};
