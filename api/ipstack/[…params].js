import {
  handlePreflight, rejectMethod, requireKey, apiKey,
  sendJson, sendError, coerceParams, buildCacheKey,
  createCache, isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM = "https://api.apilayer.net/ipstack";

const CACHE_BY_ENDPOINT = { check: 60 * 60, lookup: 60 * 60 * 24, standard: 60 * 60 * 24, bulk: 60 * 60 * 24 };
const SWR_BY_ENDPOINT   = { check: 60 * 60 * 6, lookup: 60 * 60 * 24 * 7, standard: 60 * 60 * 24 * 7, bulk: 60 * 60 * 24 * 7 };

const OPTIONAL = {
  fields:   { type: "text",    maxLen: 500 },
  hostname: { type: "bool01",  default: "0" },
  security: { type: "bool01",  default: "0" },
  language: { type: "pattern", pattern: /^[a-z]{2}$/i, hint: "2-letter language code" },
};

const SCHEMAS = {
  check:    {},
  lookup:   OPTIONAL,
  standard: OPTIONAL,
  bulk:     { ips: { type: "text", maxLen: 500, required: true }, ...OPTIONAL },
};

const NAMED_ENDPOINTS = new Set(["check", "standard", "bulk", "lookup"]);
const cache = createCache(200);

function getSegments(req) {
  if (typeof req.query.path === "string" && req.query.path) {
    return req.query.path.split("/").filter(Boolean);
  }
  const raw = req.query.params;
  if (Array.isArray(raw) && raw.length) return raw;
  if (typeof raw === "string" && raw) return raw.split("/").filter(Boolean);
  const urlPath = String(req.url || "").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(2) : [];
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (rejectMethod(req, res)) return;
  if (requireKey(res)) return;

  const segments = getSegments(req);
  const first = (segments[0] || "").toLowerCase();

  let endpoint, ipValue = "";
  if (!first)                          endpoint = "standard";
  else if (NAMED_ENDPOINTS.has(first)) { endpoint = first; ipValue = segments[1] || ""; }
  else                                 { endpoint = "lookup"; ipValue = first; }

  const schema = SCHEMAS[endpoint];
  if (!schema) {
    return sendError(res, 400, "Unknown endpoint", {
      allowed: Object.keys(SCHEMAS),
      debug: { url: req.url, queryKeys: Object.keys(req.query), segments },
    });
  }
  if (endpoint === "lookup" && !ipValue) return sendError(res, 400, "lookup requires an IP, e.g. /api/ipstack/lookup/8.8.8.8");

  const { out: params, errors } = coerceParams(req.query, schema);
  if (errors.length) return sendError(res, 400, "Invalid parameters", errors);

  const cacheSeconds = CACHE_BY_ENDPOINT[endpoint];
  const swrSeconds   = SWR_BY_ENDPOINT[endpoint];
  const cacheKey = buildCacheKey(`ipstack:${endpoint}:${ipValue}`, params);
  const hit = cache.get(cacheKey);
  if (hit) return sendJson(res, hit, "HIT-LOCAL", cacheSeconds, swrSeconds);

  try {
    let path;
    if (endpoint === "check")         path = "/check";
    else if (endpoint === "standard") path = "/standard";
    else if (endpoint === "bulk")     path = "/bulk";
    else                              path = `/${encodeURIComponent(ipValue)}`;

    const search = new URLSearchParams();
    search.set("access_key", apiKey());
    for (const [k, v] of Object.entries(params)) search.set(k, v);

    const upstream = await fetch(`${UPSTREAM}${path}?${search}`, { headers: { Accept: "application/json" } });
    const { text, payload, isJson } = await readUpstream(upstream);
    if (!isJson) return sendError(res, 502, "Upstream returned non-JSON", text.slice(0, 300));
    if (isUpstreamError(upstream, payload, true)) {
      return res.status(502).json({ error: "Upstream error", status: upstream.status, details: payload?.error ?? payload });
    }
    cache.set(cacheKey, payload, cacheSeconds * 1000);
    return sendJson(res, payload, "MISS", cacheSeconds, swrSeconds);
  } catch (err) {
    return sendError(res, 500, "Proxy request failed", err?.message ?? String(err));
  }
}
