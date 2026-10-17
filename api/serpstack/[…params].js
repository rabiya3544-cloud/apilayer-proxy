import {
  handlePreflight, rejectMethod, requireKey, apiKey,
  sendPayload, sendError, coerceParams, buildCacheKey,
  createCache, isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM = "https://api.apilayer.net/serpstack";

const CACHE_BY_ENDPOINT = { search: parseInt(process.env.SEARCH_CACHE_SECONDS || "1800", 10), locations: 60 * 60 * 24 * 7 };
const SWR_BY_ENDPOINT   = { search: 60 * 60 * 24, locations: 60 * 60 * 24 * 30 };

const SEARCH_SCHEMA = {
  query:                        { required: true, type: "text", maxLen: 200 },
  engine:                       { type: "enum",  values: ["google"], default: "google" },
  type:                         { type: "enum",  values: ["web","images","videos","news","shopping"], default: "web" },
  device:                       { type: "enum",  values: ["desktop","mobile","tablet"], default: "desktop" },
  location:                     { type: "text",  maxLen: 200, default: "New York,New York,United States" },
  auto_location:                { type: "bool01", default: "1" },
  google_domain:                { type: "text",  maxLen: 100, default: "google.com" },
  gl:                           { type: "pattern", pattern: /^[a-z]{2}$/i, default: "us" },
  hl:                           { type: "pattern", pattern: /^[a-z]{2}$/i, default: "en" },
  safe:                         { type: "bool01", default: "0" },
  period:                       { type: "enum",  values: ["last_hour","last_day","last_week","last_month","last_year","custom"], default: "last_week" },
  period_start:                 { type: "date",  default: "2023-01-01" },
  period_end:                   { type: "date",  default: "2023-01-31" },
  news_type:                    { type: "text",  maxLen: 50, default: "blogs" },
  exclude_autocorrected_results:{ type: "bool01", default: "0" },
  images_page:                  { type: "int",   min: 1, max: 100, default: 1 },
  images_color:                 { type: "enum",  values: ["any","black_and_white","transparent","red","orange","yellow","green","teal","blue","purple","pink","white","gray","black","brown"], default: "any" },
  images_size:                  { type: "enum",  values: ["large","medium","icon"], default: "large" },
  images_type:                  { type: "enum",  values: ["clipart","line_drawing","gif"], default: "clipart" },
  images_usage:                 { type: "enum",  values: ["reuse_with_modification","reuse","non_commercial_reuse_with_modification","non_commercial_reuse"], default: "reuse" },
  sort:                         { type: "enum",  values: ["relevance","date"], default: "relevance" },
  page:                         { type: "int",   min: 1, max: 10, default: 1 },
  output:                       { type: "enum",  values: ["json","csv"], default: "json" },
  csv_fields:                   { type: "text",  maxLen: 500, default: "search_parameters.query,organic_results.title" },
};

const LOCATIONS_SCHEMA = {
  query:    { type: "text", maxLen: 200 },
  location: { type: "text", maxLen: 200 },
  q:        { type: "text", maxLen: 200 },
  region:   { type: "text", maxLen: 100 },
  country:  { type: "text", maxLen: 100 },
  limit:    { type: "int",  min: 1, max: 100, default: 10 },
  output:   { type: "enum", values: ["json"], default: "json" },
};

const SCHEMAS = { search: SEARCH_SCHEMA, locations: LOCATIONS_SCHEMA };

const QUERY_ALLOWLIST = (process.env.SEARCH_QUERY_ALLOWLIST || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

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
  if (requireKey(res)) return;

  const segments = getSegments(req);
  const endpoint = (segments[0] || "").toLowerCase();
  const schema = SCHEMAS[endpoint];
  if (!schema) {
    return sendError(res, 400, "Unknown endpoint", {
      allowed: Object.keys(SCHEMAS),
      debug: { url: req.url, queryKeys: Object.keys(req.query), segments },
    });
  }

  const { out: params, errors } = coerceParams(req.query, schema);
  if (errors.length) return sendError(res, 400, "Invalid parameters", errors);

  if (endpoint === "locations") {
    if (!params.query) params.query = params.location || params.q || "";
    delete params.location;
    delete params.q;
    if (!params.query) {
      return sendError(res, 400, "locations requires ?query=... (or ?location= / ?q=)");
    }
  }

  if (endpoint === "search" && QUERY_ALLOWLIST.length) {
    const q = params.query.toLowerCase();
    if (!QUERY_ALLOWLIST.some(a => q === a || q.includes(a))) {
      return sendError(res, 403, "Query not permitted by this proxy.", "Allowed: " + QUERY_ALLOWLIST.join(", "));
    }
  }

  const cacheSeconds = CACHE_BY_ENDPOINT[endpoint];
  const swrSeconds   = SWR_BY_ENDPOINT[endpoint];
  const cacheKey = buildCacheKey(`serpstack:${endpoint}`, params);
  const hit = cache.get(cacheKey);
  if (hit) return sendPayload(res, hit.data, hit.contentType, "HIT-LOCAL", cacheSeconds, swrSeconds);

  try {
    const search = new URLSearchParams();
    search.set("access_key", apiKey());
    for (const [k, v] of Object.entries(params)) search.set(k, v);

    const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
const upstream = await fetch(`${UPSTREAM}/${endpoint}?${search}`, {
  headers: { Accept: "*/*" },
  signal: controller.signal,
}).finally(() => clearTimeout(timer));
    const { contentType, text, payload, isJson } = await readUpstream(upstream);
    if (isUpstreamError(upstream, payload, isJson)) {
      return res.status(502).json({
        error: "Upstream error",
        status: upstream.status,
        details: isJson ? (payload?.error ?? payload?.request ?? payload) : text.slice(0, 500),
      });
    }
    const outData = isJson ? payload : text;
    const outType = isJson ? "application/json; charset=utf-8" : contentType;
    const size = isJson ? JSON.stringify(outData).length : outData.length;
    if (size <= 1024 * 1024) cache.set(cacheKey, { data: outData, contentType: outType }, cacheSeconds * 1000);
    return sendPayload(res, outData, outType, "MISS", cacheSeconds, swrSeconds);
  } catch (err) {
  if (err?.name === "AbortError") {
    return sendError(res, 504, "Upstream timeout", "Serpstack took longer than 8s. Try again or narrow the query.");
  }
  return sendError(res, 500, "Proxy request failed", err?.message ?? String(err));
}
}
