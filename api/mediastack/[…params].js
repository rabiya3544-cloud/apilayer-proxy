import {
  handlePreflight, rejectMethod, requireAuth, apiKey,
  sendJson, sendError, coerceParams, buildCacheKey,
  createCache, isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM_BASE = "https://api.apilayer.net/mediastack/v1";
const UPSTREAM_PATHS = { sources: "sources", news: "news", live: "news" };
const CACHE_BY_ENDPOINT = { sources: 60 * 60 * 24, news: 60 * 15, live: 60 * 15 };
const SWR_BY_ENDPOINT   = { sources: 60 * 60 * 24 * 7, news: 60 * 60 * 2, live: 60 * 60 * 2 };

const SHARED_SCHEMA = {
  countries:  { type: "pattern", pattern: /^-?[a-z]{2,}(,-?[a-z]{2,})*$/i, maxLen: 500 },
  languages:  { type: "pattern", pattern: /^-?[a-z]{2,}(,-?[a-z]{2,})*$/i, maxLen: 500 },
  categories: { type: "pattern", pattern: /^-?[a-z]+(,-?[a-z]+)*$/i,       maxLen: 500 },
  limit:      { type: "int", min: 1, max: 100,   default: 25 },
  offset:     { type: "int", min: 0, max: 10000, default: 0 },
};

const SCHEMAS = {
  sources: {
    ...SHARED_SCHEMA,
    search: { type: "text", maxLen: 200, required: true, hint: "Source name, e.g. bbc." },
  },
  news: {
    ...SHARED_SCHEMA,
    search:   { type: "text", maxLen: 200 },
    keywords: { type: "text", maxLen: 200, required: true },
    sources:  { type: "pattern", pattern: /^-?[a-z0-9-]+(,-?[a-z0-9-]+)*$/i, maxLen: 500 },
    date:     { type: "pattern", pattern: /^\d{4}-\d{2}-\d{2}(,\d{4}-\d{2}-\d{2})?$/, maxLen: 40 },
  },
};
SCHEMAS.live = SCHEMAS.news;

const cache = createCache(100);

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
  if (requireAuth(req, res)) return;

  const segments = getSegments(req);
  const proxyEndpoint = (segments[0] || "").toLowerCase();
  const upstreamPath = UPSTREAM_PATHS[proxyEndpoint];
  if (!upstreamPath) {
    return sendError(res, 400, "Unknown endpoint", {
      allowed: Object.keys(UPSTREAM_PATHS),
      debug: { url: req.url, queryKeys: Object.keys(req.query), segments },
    });
  }

  const { out: params, errors } = coerceParams(req.query, SCHEMAS[proxyEndpoint]);
  if (errors.length) return sendError(res, 400, "Invalid parameters", errors);

  const cacheSeconds = CACHE_BY_ENDPOINT[proxyEndpoint];
  const swrSeconds   = SWR_BY_ENDPOINT[proxyEndpoint];
  const cacheKey = buildCacheKey(`mediastack:${proxyEndpoint}`, params);
  const hit = cache.get(cacheKey);
  if (hit) return sendJson(res, hit, "HIT-LOCAL", cacheSeconds, swrSeconds);

  try {
    const search = new URLSearchParams();
    search.set("access_key", apiKey());
    for (const [k, v] of Object.entries(params)) search.set(k, v);
    const upstream = await fetch(`${UPSTREAM_BASE}/${upstreamPath}?${search}`, { headers: { Accept: "application/json" } });
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
