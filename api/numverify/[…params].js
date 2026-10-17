// api/numverify/[...params].js
// Routes:
//   /api/numverify/countries          → /api/countries
//   /api/numverify/validate?number=…  → /api/validate?number=…

import {
  handlePreflight, rejectMethod, requireAuth, apiKey,
  sendJson, sendError, coerceParams, buildCacheKey,
  createCache, isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM = "https://api.apilayer.net/numverify/api";

const UPSTREAM_PATHS = { countries: "countries", validate: "validate" };

const CACHE_BY_ENDPOINT = { countries: 60 * 60 * 24 * 7, validate: 60 * 60 * 24 };
const SWR_BY_ENDPOINT   = { countries: 60 * 60 * 24 * 30, validate: 60 * 60 * 24 * 7 };

const SCHEMAS = {
  countries: {},
  validate: {
    number:       { type: "text",    maxLen: 40, required: true, hint: "Full international number (incl. country prefix)." },
    country_code: { type: "pattern", pattern: /^[a-z]{2}$/i, hint: "2-letter ISO country code." },
    format:       { type: "bool01",  default: "0" },
  },
};

const cache = createCache(100);

function getSegments(req) {
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
  if (requireAuth(req, res)) return;

  const segments = getSegments(req);
  const endpoint = (segments[0] || "").toLowerCase();
  const upstreamPath = UPSTREAM_PATHS[endpoint];

  if (!upstreamPath) {
    return sendError(res, 400, "Unknown endpoint", {
      allowed: Object.keys(UPSTREAM_PATHS),
      debug: {
        url: req.url,
        queryKeys: Object.keys(req.query),
        segments: segments,
      },
    });
  }

  const { out: params, errors } = coerceParams(req.query, SCHEMAS[endpoint]);
  if (errors.length) return sendError(res, 400, "Invalid parameters", errors);

  if (endpoint === "validate" && params.number) {
    params.number = params.number.replace(/[\s\-().]/g, "");
  }

  const cacheSeconds = CACHE_BY_ENDPOINT[endpoint];
  const swrSeconds   = SWR_BY_ENDPOINT[endpoint];
  const cacheKey = buildCacheKey(`numverify:${endpoint}`, params);
  const hit = cache.get(cacheKey);
  if (hit) return sendJson(res, hit, "HIT-LOCAL", cacheSeconds, swrSeconds);

  try {
    const search = new URLSearchParams();
    search.set("access_key", apiKey());
    for (const [k, v] of Object.entries(params)) search.set(k, v);

    const upstream = await fetch(`${UPSTREAM}/${upstreamPath}?${search}`, { headers: { Accept: "application/json" } });
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
