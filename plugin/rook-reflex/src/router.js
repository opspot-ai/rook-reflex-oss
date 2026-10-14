/**
 * rook-reflex — deterministic Reflex Router.
 *
 * Pure, side-effect free classifier. No I/O, no clock, no randomness.
 * classify(input, cfg) -> decision
 *
 * Planes:
 *   D / board          money movement, payment-provider change, contract signing,
 *                      irreversible public identity
 *   C / durable factory code, repo, PR, deploy, migration, production, auth,
 *                      customer data, multi-specialist work
 *   B / detached       research / compare / analyze / investigate / audit / diagnose /
 *                      benchmark / long-media transcribe+summarize / "full report" /
 *                      "thorough" / multi-step, or size thresholds
 *   A / direct         everything else
 *
 * Precedence is strictly D > C > B > A.
 */

export const DEFAULTS = Object.freeze({
  longPromptChars: 1200,
  longDocChars: 4000,
  maxDistinctAsks: 2,
  longMediaSeconds: 300,
});


/** Strips OpenClaw envelope decoration so patterns match the human sentence. */
export function normalizeText(raw) {
  const s = typeof raw === "string" ? raw : "";
  return s
    .replace(/\r/g, "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .toLowerCase();
}

const REPO_PATH_RE = /(?:~\/(?:products|projects|workspaces)\/|\/users\/[a-z0-9._-]+\/(?:products|projects|workspaces)\/)/;


const D_RULES = [
  // Move money.
  {
    id: "money-move",
    re: /\b(pay|paying|pay off|wire|transfer|send|remit|refund|reimburse|settle|withdraw|deposit|charge|payout)\b[^.?!\n]{0,60}\b(invoice|invoices|bill|bills|balance|payment|money|funds|retainer|payroll|vendor|contractor|subscription|usd|\$\s?\d|\d+\s?(usd|dollars))/,
  },
  { id: "money-move-invoice", re: /\bpay\b[^.?!\n]{0,60}\binvoice\b/ },
  {
    id: "money-move-amount",
    re: /\b(send|wire|transfer|move)\b[^.?!\n]{0,30}\$\s?\d/,
  },
  // Trade / convert assets.
  {
    id: "asset-trade",
    re: /\b(buy|sell|swap|convert|trade|liquidate)\b[^.?!\n]{0,40}\b(btc|eth|crypto|bitcoin|stock|stocks|shares|equity|securities)\b/,
  },
  // Touch a payment provider.
  {
    id: "payment-provider",
    re: /\b(switch|change|swap|migrate|rotate|update|connect|disconnect|add|remove|cancel|close|reconfigure|set up|setup)\b[^.?!\n]{0,60}\b(stripe|paypal|square|mercury|brex|ramp|quickbooks|plaid|lemon squeezy|paddle|payment (provider|processor|method|gateway)|billing (provider|account|processor)|bank account|card on file|merchant account)\b/,
  },
  {
    id: "payment-provider-direct",
    re: /\b(stripe|paypal|mercury|brex|ramp|plaid|paddle|lemon squeezy)\b[^.?!\n]{0,40}\b(payout|transfer|charge|refund|withdraw|api key rotation)\b/,
  },
  // Sign / execute a contract.
  {
    id: "contract-sign",
    re: /\b(sign|countersign|execute|docusign|accept and sign)\b[^.?!\n]{0,60}\b(contract|agreement|msa|sow|nda|lease|loi|term sheet|terms of service|engagement letter)\b/,
  },
  // Irreversible public identity.
  {
    id: "identity-irreversible",
    re: /\b(rename|rebrand|dissolve|incorporate|deregister|register|file|transfer|hand over|surrender|delete|shut down)\b[^.?!\n]{0,60}\b(the )?(llc|corporation|legal entity|legal name|business name|company name|trademark|domain name|the domain|official (account|handle)|brand identity)\b/,
  },
];

/** Money/contract talk that is a QUESTION about the past, not an instruction. */
const D_DEMOTE_RE =
  /^(what|what's|whats|how much|how many|when|who|why|where|did|do|does|is|are|was|were|have|has|can you tell|remind me)\b/;
const D_DEMOTE_PAST_RE =
  /\b(did we|have we|has anyone|already paid|was paid|were paid|last (month|week|year)|so far|to date|history of)\b/;


const C_VERB_RE =
  /\b(implement|refactor|rewrite|scaffold|ship|deploy|redeploy|rollback|roll back|hotfix|patch|merge|rebase|cherry-pick|commit|push|revert|migrate|backfill|instrument|wire up|integrate|bootstrap|productionize|harden|containerize|dockerize)\b/;
const C_BUILD_RE =
  /\b(build|add|write|create|make|code|develop|extend)\b[^.?!\n]{0,50}\b(feature|endpoint|api|route|service|plugin|module|migration|schema|database table|db table|worker|daemon|cli|hook|test|tests|component|page|pipeline|adapter|integration)\b/;
const C_FIX_RE =
  /\b(fix|debug|repair|resolve|unbreak|stop)\b[^.?!\n]{0,40}\b(bug|crash|regression|failure|failing test|error|exception|outage|broken build|500|timeout)\b/;
const C_NOUN_RE =
  /\b(pull request|open a pr|open the pr|a pr\b|the pr\b|\bpr\b|repo|repository|git branch|branch off|commit history|deployment|deploy|production|prod\b|staging|ci\/cd|\bci\b|build pipeline|database migration|db migration|schema migration|launchd|systemd|durable (task )?workflow)\b/;
const C_SENSITIVE_RES = [
  /\b(oauth|auth flow|authentication|authorization|credential rotation|api key rotation|customer data|customer records|\bpii\b|user data|production database|prod db)\b/,
  /\brotat\w*\b[^.?!\n]{0,40}\b(keys?|tokens?|credentials?|secrets?)\b/,
];
const C_MULTI_SPECIALIST_RE =
  /\b(multi-specialist|several (engineers|agents|specialists)|spin up a team|whole team|president and|engineer and auditor)\b/;


const B_VERB_RE =
  /\b(research|compare|contrast|analyz|analys|investigate|audit|diagnose|benchmark|evaluate|assess|survey|map out|deep dive|deep-dive|dig into|look into|write up|synthesize|cross-reference)\w*/;
const B_SHAPE_RE =
  /\b(full report|complete report|detailed report|thorough|thoroughly|comprehensive|exhaustive|in depth|in-depth|end to end|end-to-end|multi-step|multi step|step by step plan|across (several|multiple|many) sources|several sources|multiple sources|pros and cons of|landscape of|competitive analysis|options and tradeoffs|trade-?offs)\b/;
const B_MEDIA_LONG_RE =
  /\b(process (the |this )?(video|recording|footage)|transcribe and summari[sz]e|summari[sz]e (the |this )?(video|recording|call|meeting|podcast|webinar|interview|episode)|go through (the |this )?(video|recording|transcript))\b/;
const TRANSCRIBE_RE = /\b(transcribe|transcription|transcript of)\b/;
const SUMMARIZE_RE = /\b(summari[sz]e|summary|recap|key points|takeaways)\b/;


const ASK_SPLIT_RE = /[.?!\n;]+/;
const ASK_VERB_RE =
  /\b(what|when|where|who|why|how|which|can you|could you|please|give me|tell me|show me|find|check|make|build|write|send|draft|list|explain|compare|fix|deploy|research|summari[sz]e|transcribe|analyz|open|add|remove|update|run)\w*/;

/** Counts distinct asks: sentences that carry an imperative or interrogative head. */
export function countDistinctAsks(normalized) {
  const parts = normalized
    .split(ASK_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length >= 6);
  let n = 0;
  for (const part of parts) {
    if (ASK_VERB_RE.test(part)) n += 1;
  }
  // "do X, then Y, then Z" is one sentence but several asks.
  const thens = (normalized.match(/\b(?:and then|then also|after that|also,)\b/g) || []).length;
  return n + thens;
}


const COMMAND_ONLY_RE = /^\s*\/[a-z][a-z0-9_-]*(\s+\S{0,40})?\s*$/;

/** True when the message is a bare slash command (no routing hint wanted). */
export function isCommandOnly(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s.startsWith("/")) return false;
  return COMMAND_ONLY_RE.test(s.toLowerCase());
}


/**
 * @param {object} input
 * @param {string} input.text            raw prompt text
 * @param {boolean} [input.hasMedia]
 * @param {string} [input.mediaKind]     audio|video|image|document|unknown
 * @param {number} [input.mediaSeconds]
 * @param {number} [input.attachedDocChars]
 * @param {object} [cfg]
 * @returns {{plane:'A'|'B'|'C'|'D', selected_plane:string, selected_mode:string,
 *            reason:string, risk_class:string, estimated_blocking_risk:string,
 *            durability_required:boolean, linear_required:boolean,
 *            review_required:boolean, signals:string[]}}
 */
export function classify(input, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const raw = typeof input?.text === "string" ? input.text : "";
  const t = normalizeText(raw);
  const signals = [];

  const textLen = raw.length;
  const docChars = Number(input?.attachedDocChars) || 0;
  const mediaSeconds = Number(input?.mediaSeconds) || 0;
  const mediaKind = String(input?.mediaKind || "").toLowerCase();
  const hasMedia = Boolean(input?.hasMedia);
  const asks = countDistinctAsks(t);

  const dHit = D_RULES.find((r) => r.re.test(t));
  if (dHit) {
    const isBackwardQuestion = D_DEMOTE_RE.test(t.trim()) || D_DEMOTE_PAST_RE.test(t);
    if (!isBackwardQuestion) {
      signals.push(`D:${dHit.id}`);
      return decision("D", `money/contract/identity action (${dHit.id})`, signals, {
        risk_class: "high",
        estimated_blocking_risk: "low",
      });
    }
    signals.push(`D:${dHit.id}:demoted-question`);
  }

  const cHits = [];
  if (C_VERB_RE.test(t)) cHits.push("verb");
  if (C_BUILD_RE.test(t)) cHits.push("build-noun");
  if (C_FIX_RE.test(t)) cHits.push("fix-defect");
  if (C_NOUN_RE.test(t)) cHits.push("delivery-noun");
  if (C_SENSITIVE_RES.some((re) => re.test(t))) cHits.push("sensitive");
  if (C_MULTI_SPECIALIST_RE.test(t)) cHits.push("multi-specialist");
  // A path or generic project reference counts only alongside engineering intent.
  const engineeringIntent = cHits.length > 0;
  if (REPO_PATH_RE.test(t) && engineeringIntent) cHits.push("repo-path");
  if (/\b(project|workspace)\b/.test(t) && engineeringIntent) cHits.push("project-reference");

  // Nouns alone in a research or design question do not imply implementation work.
  const cActionHit = cHits.some((h) => h === "verb" || h === "build-noun" || h === "fix-defect");
  if (cHits.length > 0 && !cActionHit && B_VERB_RE.test(t)) {
    signals.push(`C:${cHits.join("+")}:demoted-research`);
    cHits.length = 0;
  }

  if (cHits.length > 0) {
    // A pure question *about* code is not factory work.
    const askingAbout =
      /^(what|what's|whats|how does|how do|why does|why is|where is|where does|who|is there|are there|do we|does the|can you explain|explain)\b/.test(
        t.trim(),
      ) && !C_VERB_RE.test(t) && !C_BUILD_RE.test(t) && !C_FIX_RE.test(t);
    if (!askingAbout) {
      for (const h of cHits) signals.push(`C:${h}`);
      const risky = cHits.some((h) => h === "sensitive" || h === "delivery-noun");
      return decision("C", `durable factory work (${cHits.join("+")})`, signals, {
        risk_class: risky ? "high" : "moderate",
        estimated_blocking_risk: "high",
      });
    }
    signals.push(`C:${cHits.join("+")}:demoted-question`);
  }

  const bHits = [];
  if (B_VERB_RE.test(t)) bHits.push("research-verb");
  if (B_SHAPE_RE.test(t)) bHits.push("report-shape");
  if (B_MEDIA_LONG_RE.test(t)) bHits.push("long-media");
  if (TRANSCRIBE_RE.test(t) && SUMMARIZE_RE.test(t)) bHits.push("transcribe+summarize");
  if (hasMedia && (mediaKind === "video" || mediaSeconds > c.longMediaSeconds)) {
    bHits.push("media-over-threshold");
  }
  if (textLen > c.longPromptChars) bHits.push(`prompt>${c.longPromptChars}`);
  if (docChars > c.longDocChars) bHits.push(`doc>${c.longDocChars}`);
  if (asks > c.maxDistinctAsks) bHits.push(`asks=${asks}`);

  if (bHits.length > 0) {
    for (const h of bHits) signals.push(`B:${h}`);
    return decision("B", `detached investigation (${bHits.join("+")})`, signals, {
      risk_class: "low",
      estimated_blocking_risk: "high",
    });
  }

  if (hasMedia) signals.push("A:media-fast-tool");
  if (asks > 0) signals.push(`A:asks=${asks}`);
  return decision("A", "short/single-step request", signals, {
    risk_class: "low",
    estimated_blocking_risk: "low",
  });
}

const PLANE_MAP = {
  A: { selected_plane: "reflex", selected_mode: "direct" },
  B: { selected_plane: "reflex", selected_mode: "detached" },
  C: { selected_plane: "factory", selected_mode: "durable" },
  D: { selected_plane: "board", selected_mode: "board" },
};

function decision(plane, reason, signals, extra) {
  return {
    plane,
    ...PLANE_MAP[plane],
    reason,
    signals,
    durability_required: plane === "C",
    linear_required: plane === "C" || plane === "D",
    review_required: plane === "C" || plane === "D",
    ...extra,
  };
}

export const PLANES = PLANE_MAP;
