// api/auth.js
// Verifies a key against PLAYGROUND_PASSWORD (or APILAYER_API_KEY if unset).
// The key itself never leaves the server for comparison; client sends plaintext
// over HTTPS, server compares timing-safely.

import crypto from "node:crypto";
import { handlePreflight, apiKey, sendError } from "./_lib/apilayer.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") return sendError(res, 405, "Method not allowed. Use POST.");

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const provided = String(body?.key ?? "").trim();
  if (!provided) return sendError(res, 400, "Missing key");

  const expected = String(
    process.env.PLAYGROUND_PASSWORD || apiKey() || ""
  ).trim();

  if (!expected) {
    return sendError(res, 500, "Server misconfigured: set PLAYGROUND_PASSWORD or APILAYER_API_KEY.");
  }

  // Timing-safe compare
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  let match = false;
  if (a.length === b.length) {
    try { match = crypto.timingSafeEqual(a, b); } catch { match = false; }
  }

  if (!match) return res.status(401).json({ ok: false, error: "Invalid key" });
  return res.status(200).json({ ok: true });
}
