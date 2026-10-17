import {
  handlePreflight, rejectMethod, requireKey, apiKey,
  sendJson, sendError, buildCacheKey, createCache,
  isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM = "https://api.apilayer.net/countrylayer/v2";

const ENDPOINTS = {
  all:          { required: false },
  name:         { required: true, type: "text",    maxLen: 100 },
  capital:      { required: true, type: "text",    maxLen: 100 },
  language:     { required: true, type: "text",    maxLen: 100 },
  currency:     { required: true, type: "pattern", pattern: /^[a-z]{3}$/i, hint: "ISO 4217 (EUR, USD)" },
  region:       { required: true, type: "enum",    values: ["Africa","Americas","Asia","Europe","Oceania","Antarctic"] },
  regionalbloc: { required: true, type: "text",    maxLen: 50 },
  callingcode:  { required: true, type: "pattern", pattern: /^\d{1,4}$/, hint: "1–4 digits" },
  alpha:        { required: true, type: "pattern", pattern: /^[a-z]{2,3}$/i, hint: "2 or 3 letters" },
};

const CACHE_SECONDS = 60 * 60 * 24 * 7;
const SWR_SECONDS   = 60 * 60 * 24 * 30;
const cache = createCache(100);

function normalizeFilters(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean).join(";");
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (rejectMethod(req, res)) return;
  if (requireKey(res)) return;

  const segments = Array.isArray(req.query.params) ? req.query.params : [];
  const endpoint = (segments[0] || "all").toLowerCase();
  const rawValue = segments.slice(1).join("/");
  const rule = ENDPOINTS[endpoint];
  if (!rule) return sendError(res, 400, "Unknown endpoint", Object.keys(ENDPOINTS));

  let value = "";
  if (rule.required) {
    value = rawValue.trim();
    if (!value) return sendError(res, 400, `${endpoint} requires a value, e.g. /api/countrylayer/${endpoint}/example`);
    if (rule.maxLen && value.length > rule.maxLen) return sendError(res, 400, `${endpoint}: max ${rule.maxLen} chars`);
    if (rule.type === "pattern" && !rule.pattern.test(value)) return sendError(res, 400, `${endpoint}: invalid format`, rule.hint);
    if (rule.type === "enum") {
      const match = rule.values.find(v => v.toLowerCase() === value.toLowerCase());
      if (!match) return sendError(res, 400, `${endpoint}: must be one of ${rule.values.join(", ")}`);
      value = match;
    }
  }

  const filters = normalizeFilters(req.query.filters);
  const cacheKey = buildCacheKey(`countrylayer:${endpoint}:${value.toLowerCase()}`, { filters });
  const hit = cache.get(cacheKey);
  if (hit) return sendJson(res, hit, "HIT-LOCAL", CACHE_SECONDS, SWR_SECONDS);

  try {
    const path = rule.required ? `/${endpoint}/${encodeURIComponent(value)}` : "/all";
    let url = `${UPSTREAM}${path}?access_key=${encodeURIComponent(apiKey())}`;
    if (filters) url += `&filters=${encodeURIComponent(filters)}`;

    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    const { text, payload, isJson } = await readUpstream(upstream);
    if (!isJson) return sendError(res, 502, "Upstream returned non-JSON", text.slice(0, 300));
    if (isUpstreamError(upstream, payload, true)) {
      return res.status(502).json({ error: "Upstream error", status: upstream.status, details: payload?.error ?? payload });
    }
    cache.set(cacheKey, payload, CACHE_SECONDS * 1000);
    return sendJson(res, payload, "MISS", CACHE_SECONDS, SWR_SECONDS);
  } catch (err) {
    return sendError(res, 500, "Proxy request failed", err?.message ?? String(err));
  }
}
