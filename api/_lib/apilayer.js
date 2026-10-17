// api/_lib/apilayer.js
// Shared utilities for every apilayer product proxy.

import crypto from "node:crypto";

const JSON_CT = "application/json; charset=utf-8";
const SWR_MULTIPLIER = 4;

const LEGACY_KEYS = [
  "COUNTRYLAYER_API_KEY",
  "SERPSTACK_API_KEY",
  "MEDIASTACK_API_KEY",
  "AVIATIONSTACK_API_KEY",
  "IPSTACK_API_KEY",
  "NUMVERIFY_API_KEY",
];

export function apiKey() {
  if (process.env.APILAYER_API_KEY) return process.env.APILAYER_API_KEY;
  for (const k of LEGACY_KEYS) if (process.env[k]) return process.env[k];
  return undefined;
}

export function handlePreflight(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

export function rejectMethod(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed. Use GET." });
    return true;
  }
  return false;
}

export function requireAuth(req, res) {
  const expected = apiKey();
  if (!expected) {
    res.status(500).json({ error: "Server misconfigured: APILAYER_API_KEY not set." });
    return true;
  }
  const auth = String(req.headers["authorization"] || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) {
    res.status(401).json({ error: "Unauthorized. Send header: Authorization: Bearer <apilayer-key>" });
    return true;
  }
  return false;
}

export function sendPayload(res, data, contentType, cacheStatus, cacheSeconds, swrSeconds) {
  const swr = swrSeconds ?? cacheSeconds * SWR_MULTIPLIER;
  res.setHeader("Content-Type", contentType || JSON_CT);
  res.setHeader("Cache-Control", `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${swr}`);
  res.setHeader("X-Cache", cacheStatus);
  if (typeof data === "string") return res.status(200).send(data);
  return res.status(200).json(data);
}

export function sendJson(res, data, cacheStatus, cacheSeconds, swrSeconds) {
  return sendPayload(res, data, JSON_CT, cacheStatus, cacheSeconds, swrSeconds);
}

export function sendError(res, status, error, details) {
  const body = { error };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

export function coerceParams(rawQuery, schema) {
  const out = {}, errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const raw = rawQuery[key];
    const provided = raw !== undefined && String(raw).trim() !== "";
    if (!provided) {
      if (rule.required) { errors.push(`${key}: required`); continue; }
      if (rule.default !== undefined) out[key] = String(rule.default);
      continue;
    }
    if (Array.isArray(raw)) { errors.push(`${key}: expected single value`); continue; }
    const val = String(raw).trim();
    if (rule.maxLen && val.length > rule.maxLen) { errors.push(`${key}: max ${rule.maxLen} chars`); continue; }
    switch (rule.type) {
      case "text": out[key] = val; break;
      case "enum":
        if (!rule.values.includes(val)) errors.push(`${key}: must be one of ${rule.values.join(", ")}`);
        else out[key] = val;
        break;
      case "bool01":
        if (val !== "0" && val !== "1") errors.push(`${key}: must be 0 or 1`);
        else out[key] = val;
        break;
      case "int": {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n)) errors.push(`${key}: must be integer`);
        else if (rule.min !== undefined && n < rule.min) errors.push(`${key}: must be >= ${rule.min}`);
        else if (rule.max !== undefined && n > rule.max) errors.push(`${key}: must be <= ${rule.max}`);
        else out[key] = String(n);
        break;
      }
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) errors.push(`${key}: must be YYYY-MM-DD`);
        else out[key] = val;
        break;
      case "pattern":
        if (!rule.pattern.test(val)) errors.push(`${key}: invalid format`);
        else out[key] = val;
        break;
      default:
        errors.push(`${key}: unknown type`);
    }
  }
  return { out, errors };
}

export function buildCacheKey(namespace, params) {
  const stable = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha256").update(`${namespace}|${stable}`).digest("hex").slice(0, 32);
}

export function createCache(maxEntries = 100) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) { map.delete(key); return null; }
      return entry.data;
    },
    set(key, data, ttlMs) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { data, expiresAt: Date.now() + ttlMs });
    },
  };
}

export function isUpstreamError(upstream, payload, isJson) {
  if (!upstream.ok) return true;
  if (!isJson) return false;
  if (payload?.success === false) return true;
  if (payload?.request?.success === false) return true;
  if (payload?.error && typeof payload.error === "object" && Object.keys(payload.error).length > 0) return true;
  return false;
}

export async function readUpstream(upstream) {
  const contentType = upstream.headers.get("content-type") || JSON_CT;
  const text = await upstream.text();
  let isJson = false, payload;
  const looksJson = /json/i.test(contentType) || /^\s*[\[{]/.test(text);
  if (looksJson) {
    try { payload = JSON.parse(text); isJson = true; } catch { /* keep text */ }
  }
  return { contentType, text, payload, isJson };
}
