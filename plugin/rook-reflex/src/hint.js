/**
 * rook-reflex — routing hint text.
 *
 * The hint is prepended to the turn prompt via before_prompt_build.
 * Hard cap: `maxHintChars` (default 350). Route A stays one short, non-pushy line.
 * Every hint ends with the override clause: Rook's judgment wins.
 */

const OVERRIDE = "Your own judgment overrides this.";

const HINTS = {
  A: () => "[reflex A/direct] Answer inline now; no background task needed. " + OVERRIDE,

  B: () =>
    "[reflex B/detached] Use sessions_spawn with an isolated task packet for research, media, or " +
    "multi-step work, then end the turn with a short visible acknowledgement. Answer any quick part now. " +
    OVERRIDE,

  C: () =>
    "[reflex C/durable] Use sessions_spawn to hand code, repository, or production work to the " +
    "durable engineering workflow configured for this installation. Do not implement it inline. " +
    OVERRIDE,

  D: () =>
    "[reflex D/board] For money movement, payment-provider changes, contract signatures, or " +
    "irreversible identity changes, prepare the exact action and ask the owner. Keep doing every " +
    "ungated adjacent piece. " + OVERRIDE,
};

/**
 * @param {'A'|'B'|'C'|'D'} plane
 * @param {number} maxChars
 * @returns {string}
 */
export function buildHint(plane, maxChars = 350) {
  const make = HINTS[plane] || HINTS.A;
  const text = make();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export const HINT_PLANES = Object.keys(HINTS);
