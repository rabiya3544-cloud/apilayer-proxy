import {
  handlePreflight, rejectMethod, requireAuth, apiKey,
  sendJson, sendError, coerceParams, buildCacheKey,
  createCache, isUpstreamError, readUpstream,
} from "../_lib/apilayer.js";

const UPSTREAM = "https://api.apilayer.net/aviationstack/v1";
const UPSTREAM_PATHS = {
  flights: "flights", timetable: "timetable", airports: "airports",
  airlines: "airlines", routes: "routes", airplanes: "airplanes",
};
const CACHE_BY_ENDPOINT = {
  flights: 60 * 15, timetable: 60 * 60 * 6,
  airports: 60 * 60 * 24 * 7, airlines: 60 * 60 * 24 * 7,
  routes: 60 * 60 * 24 * 7, airplanes: 60 * 60 * 24 * 7,
};
const SWR_BY_ENDPOINT = {
  flights: 60 * 60, timetable: 60 * 60 * 24,
  airports: 60 * 60 * 24 * 30, airlines: 60 * 60 * 24 * 30,
  routes: 60 * 60 * 24 * 30, airplanes: 60 * 60 * 24 * 30,
};

const FLIGHT_STATUS = ["scheduled","active","landed","cancelled","incident","diverted"];
const PAGINATION = {
  limit:  { type: "int", min: 1, max: 100,   default: 100 },
  offset: { type: "int", min: 0, max: 10000, default: 0 },
};

const FLIGHTS_SCHEMA = {
  flight_date:   { type: "date" },
  flight_status: { type: "enum",  values: FLIGHT_STATUS },
  dep_iata:      { type: "pattern", pattern: /^[a-z]{3}$/i, hint: "3-letter airport IATA" },
  dep_icao:      { type: "pattern", pattern: /^[a-z]{4}$/i, hint: "4-letter airport ICAO" },
  arr_iata:      { type: "pattern", pattern: /^[a-z]{3}$/i },
  arr_icao:      { type: "pattern", pattern: /^[a-z]{4}$/i },
  airline_name:  { type: "text", maxLen: 100 },
  airline_iata:  { type: "pattern", pattern: /^[a-z0-9]{2,3}$/i },
  airline_icao:  { type: "pattern", pattern: /^[a-z]{3,4}$/i },
  flight_number: { type: "pattern", pattern: /^\d{1,5}$/ },
  flight_iata:   { type: "pattern", pattern: /^[a-z0-9]{3,8}$/i },
  flight_icao:   { type: "pattern", pattern: /^[a-z0-9]{4,10}$/i },
  min_delay:     { type: "int", min: 0, max: 1440 },
  max_delay:     { type: "int", min: 0, max: 1440 },
  ...PAGINATION,
};
const TIMETABLE_SCHEMA = {
  iataCode: { type: "pattern", pattern: /^[a-z]{3}$/i, required: true, hint: "3-letter airport IATA" },
  type:     { type: "enum", values: ["arrival","departure"], default: "arrival" },
  date:     { type: "date" },
  ...PAGINATION,
};
const REFERENCE_SCHEMA = { search: { type: "text", maxLen: 200 }, ...PAGINATION };

const SCHEMAS = {
  flights: FLIGHTS_SCHEMA, timetable: TIMETABLE_SCHEMA,
  airports: REFERENCE_SCHEMA, airlines: REFERENCE_SCHEMA,
  routes: REFERENCE_SCHEMA, airplanes: REFERENCE_SCHEMA,
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
  if (requireKeyAuth(req, res)) return;

  const segments = getSegments(req);
  const endpoint = (segments[0] || "").toLowerCase();
  const upstreamPath = UPSTREAM_PATHS[endpoint];
  if (!upstreamPath) {
    return sendError(res, 400, "Unknown endpoint", {
      allowed: Object.keys(UPSTREAM_PATHS),
      debug: { url: req.url, queryKeys: Object.keys(req.query), segments },
    });
  }

  const { out: params, errors } = coerceParams(req.query, SCHEMAS[endpoint]);
  if (errors.length) return sendError(res, 400, "Invalid parameters", errors);

  const cacheSeconds = CACHE_BY_ENDPOINT[endpoint];
  const swrSeconds   = SWR_BY_ENDPOINT[endpoint];
  const cacheKey = buildCacheKey(`aviationstack:${endpoint}`, params);
  const hit = cache.get(cacheKey);
  if (hit) return sendJson(res, hit, "HIT-LOCAL", cacheSeconds, swrSeconds);

  try {
    const search = new URLSearchParams();
    search.set("access_key", apiKey());
    for (const [k, v] of Object.entries(params)) search.set(k, v);
    const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
const upstream = await fetch(`${UPSTREAM}/${upstreamPath}?${search}`, {
  headers: { Accept: "application/json" },
  signal: controller.signal,
}).finally(() => clearTimeout(timer));
    const { text, payload, isJson } = await readUpstream(upstream);
    if (!isJson) return sendError(res, 502, "Upstream returned non-JSON", text.slice(0, 300));
    if (isUpstreamError(upstream, payload, true)) {
      return res.status(502).json({ error: "Upstream error", status: upstream.status, details: payload?.error ?? payload });
    }
    cache.set(cacheKey, payload, cacheSeconds * 1000);
    return sendJson(res, payload, "MISS", cacheSeconds, swrSeconds);
 } catch (err) {
  if (err?.name === "AbortError") {
    return sendError(res, 504, "Upstream timeout", "Aviationstack took longer than 8s. Try again or narrow the query.");
  }
  return sendError(res, 500, "Proxy request failed", err?.message ?? String(err));
}
}
