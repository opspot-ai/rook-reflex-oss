/**
 * rook-reflex — bounded, secret-safe persistence.
 *
 * Everything written here is metadata. Never prompt text beyond
 * `INTERPRETED_MAX` sanitized chars, never tool arguments, never secrets.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const INTERPRETED_MAX = 120;

const SECRET_PATTERNS = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bops_[A-Za-z0-9]{16,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  // base64-ish blobs: require mixed case + digits so ordinary long words survive
  /\b(?=[A-Za-z0-9+/]{40,})(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/** Collapses whitespace, strips control chars, redacts secret-shaped tokens, truncates. */
export function sanitize(value, maxChars = INTERPRETED_MAX) {
  let s = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxChars) s = `${s.slice(0, Math.max(0, maxChars - 1))}…`;
  return s;
}

/** Stable request id: sha256(channel|messageId|timestamp) truncated to 16 hex. */
export function requestId(channel, messageId, ts) {
  const material = `${channel ?? "unknown"}|${messageId ?? "nomsg"}|${ts ?? ""}`;
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function utcDay(iso) {
  return String(iso).slice(0, 10);
}

export function createStore(stateDirRaw) {
  const stateDir = expandHome(stateDirRaw);
  const receiptsDir = path.join(stateDir, "receipts");
  const telemetryPath = path.join(stateDir, "telemetry.jsonl");
  const undeliveredPath = path.join(stateDir, "undelivered.jsonl");
  const errorPath = path.join(stateDir, "plugin-errors.log");

  const ensureDir = (dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };

  const noteError = (where, err) => {
    try {
      ensureDir(stateDir);
      fs.appendFileSync(
        errorPath,
        `${new Date().toISOString()} ${where}: ${sanitize(err?.message ?? err, 200)}\n`,
        "utf8",
      );
    } catch {
      /* never throw out of a hook */
    }
  };

  const appendJsonl = (file, obj) => {
    try {
      ensureDir(path.dirname(file));
      fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, "utf8");
      return true;
    } catch (err) {
      noteError(`append ${path.basename(file)}`, err);
      return false;
    }
  };

  return {
    stateDir,
    receiptsDir,
    telemetryPath,
    undeliveredPath,

    telemetry(event) {
      return appendJsonl(telemetryPath, event);
    },

    undelivered(record) {
      return appendJsonl(undeliveredPath, record);
    },

    /** Writes receipts/YYYY-MM-DD/<request_id>.json; returns the path or null. */
    writeReceipt(receipt) {
      try {
        const dir = path.join(receiptsDir, utcDay(receipt.received_at || new Date().toISOString()));
        ensureDir(dir);
        const file = path.join(dir, `${receipt.request_id}.json`);
        fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        return file;
      } catch (err) {
        noteError("writeReceipt", err);
        return null;
      }
    },

    noteError,
  };
}
