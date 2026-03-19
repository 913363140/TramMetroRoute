const DEFAULT_AMAP_BASE_URL = process.env.AMAP_BASE_URL || "https://restapi.amap.com";
const DEFAULT_TIMEOUT_MS = Number(process.env.AMAP_HTTP_TIMEOUT_MS || 12000);
const DEFAULT_MIN_INTERVAL_MS = Number(process.env.AMAP_MIN_INTERVAL_MS || 220);
const DEFAULT_CACHE_TTL_MS = Number(process.env.AMAP_CACHE_TTL_MS || 5 * 60 * 1000);

const responseCache = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function logAmap(stage, detail = {}) {
  console.log(`[${nowIso()}] [amap] ${stage} ${JSON.stringify(detail)}`);
}

function logAmapError(stage, detail = {}) {
  console.error(`[${nowIso()}] [amap] ${stage} ${JSON.stringify(detail)}`);
}

function truncate(value, max = 400) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...<truncated>`;
}

function toQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    query.set(key, String(value));
  });
  return query;
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseLocation(value) {
  const text = String(value || "").trim();
  if (!text.includes(",")) {
    return null;
  }
  const [lng, lat] = text.split(",").map((item) => Number(item));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }
  return { lng, lat };
}

function locationString(location) {
  return `${location.lng},${location.lat}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function redactKey(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  if (text.length < 8) {
    return `${text.slice(0, 2)}***`;
  }
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildCacheKey(pathname, params) {
  return `${pathname}?${toQuery(params).toString()}`;
}

function readCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function writeCachedResponse(cacheKey, data) {
  responseCache.set(cacheKey, {
    expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
    data
  });
}

function isRateLimitError(data, error) {
  const info = String(data?.info || "");
  const infocode = String(data?.infocode || "");
  const message = String(error?.message || "");
  return (
    info.includes("CUQPS_HAS_EXCEEDED_THE_LIMIT") ||
    infocode === "10021" ||
    message.includes("CUQPS_HAS_EXCEEDED_THE_LIMIT")
  );
}

async function enqueueAmapRequest(task) {
  const scheduled = requestQueue
    .catch(() => {})
    .then(async () => {
      const waitMs = Math.max(0, lastRequestAt + DEFAULT_MIN_INTERVAL_MS - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      lastRequestAt = Date.now();
      return task();
    });

  requestQueue = scheduled.then(
    () => undefined,
    () => undefined
  );

  return scheduled;
}

export function getAmapConfig() {
  const key =
    process.env.AMAP_WEB_SERVICE_KEY ||
    process.env.AMAP_KEY ||
    process.env.GAODE_WEB_SERVICE_KEY ||
    process.env.GAODE_KEY ||
    "";

  return {
    baseUrl: DEFAULT_AMAP_BASE_URL.replace(/\/$/, ""),
    key,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    enabled: Boolean(key)
  };
}

async function requestAmap(pathname, params, attempt = 0) {
  const config = getAmapConfig();
  if (!config.enabled) {
    throw new Error("AMAP_WEB_SERVICE_KEY is not configured");
  }

  const requestParams = {
    output: "JSON",
    key: config.key,
    ...params
  };
  const query = toQuery(requestParams);
  const url = `${config.baseUrl}${pathname}?${query.toString()}`;
  const cacheKey = buildCacheKey(pathname, requestParams);
  const cachedData = readCachedResponse(cacheKey);
  if (cachedData) {
    logAmap("request.cache_hit", {
      pathname,
      key: redactKey(config.key)
    });
    return cachedData;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request-timeout"), config.timeoutMs);
  const startedAt = Date.now();

  logAmap("request.start", {
    pathname,
    timeoutMs: config.timeoutMs,
    key: redactKey(config.key),
    query: truncate(Object.fromEntries(query.entries()))
  });

  try {
    const response = await enqueueAmapRequest(() =>
      fetch(url, {
        method: "GET",
        signal: controller.signal
      })
    );
    const rawText = await response.text();
    const durationMs = Date.now() - startedAt;

    logAmap("request.finish", {
      pathname,
      status: response.status,
      ok: response.ok,
      durationMs,
      bodyPreview: truncate(rawText)
    });

    if (!response.ok) {
      throw new Error(`AMap request failed: ${response.status} ${rawText}`);
    }

    const data = JSON.parse(rawText);
    const success =
      String(data?.status) === "1" ||
      Number(data?.errcode) === 0 ||
      String(data?.errcode) === "0";

    if (!success) {
      if (isRateLimitError(data) && attempt < 1) {
        logAmap("request.retry_wait", {
          pathname,
          retryInMs: 600
        });
        await sleep(600);
        clearTimeout(timeout);
        return requestAmap(pathname, params, attempt + 1);
      }
      throw new Error(data?.info || data?.infocode || "AMap returned non-success status");
    }
    writeCachedResponse(cacheKey, data);
    return data;
  } catch (error) {
    logAmapError("request.error", {
      pathname,
      message: error?.message || String(error),
      name: error?.name || "Error"
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePoi(poi) {
  const location = parseLocation(poi?.location);
  if (!location) {
    return null;
  }
  return {
    id: poi.id || "",
    name: poi.name || "Unknown POI",
    address: poi.address || poi.pname || "",
    type: poi.type || "",
    typecode: poi.typecode || "",
    distanceMeters: parseNumber(poi.distance, 0),
    location
  };
}

function buildAddressVariants(address) {
  const raw = String(address || "").trim();
  const variants = [raw];
  const noSpaces = raw.replace(/\s+/g, "");
  if (noSpaces && noSpaces !== raw) {
    variants.push(noSpaces);
  }
  return [...new Set(variants.filter(Boolean))];
}

function normalizeGeocode(geo, address) {
  if (!geo?.location) {
    return null;
  }
  return {
    query: address,
    formattedAddress: geo.formatted_address || address,
    location: parseLocation(geo.location),
    province: geo.province || "",
    city: Array.isArray(geo.city) ? geo.city[0] || "" : geo.city || "",
    citycode: geo.citycode || "",
    adcode: geo.adcode || ""
  };
}

export async function geocodeAddressCandidates(address, city = "") {
  let lastError = null;
  const merged = [];

  for (const variant of buildAddressVariants(address)) {
    try {
      const data = await requestAmap("/v3/geocode/geo", {
        address: variant,
        city
      });
      const items = (Array.isArray(data?.geocodes) ? data.geocodes : [])
        .map((geo) => normalizeGeocode(geo, address))
        .filter((geo) => geo?.location);
      for (const item of items) {
        const key = `${item.formattedAddress}:${item.location?.lng}:${item.location?.lat}`;
        if (!merged.some((existing) => `${existing.formattedAddress}:${existing.location?.lng}:${existing.location?.lat}` === key)) {
          merged.push(item);
        }
      }
      if (merged.length > 0) {
        return merged;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`无法从高德解析地址：${address}`);
}

export async function geocodeAddress(address, city = "") {
  const candidates = await geocodeAddressCandidates(address, city);
  const geo = candidates[0] || null;
  if (!geo?.location) {
    throw new Error(`无法从高德解析地址：${address}`);
  }
  return geo;
}

export async function searchNearbyPois({
  location,
  keywords,
  radius = 3000,
  city = "",
  offset = 20,
  types = ""
}) {
  const data = await requestAmap("/v3/place/around", {
    location: locationString(location),
    keywords,
    radius,
    city,
    offset,
    page: 1,
    sortrule: "distance",
    extensions: "base",
    types
  });

  return (Array.isArray(data?.pois) ? data.pois : [])
    .map((poi) => normalizePoi(poi))
    .filter(Boolean);
}

export async function planBicyclingRoute(origin, destination) {
  const data = await requestAmap("/v4/direction/bicycling", {
    origin: locationString(origin),
    destination: locationString(destination)
  });
  const path = Array.isArray(data?.data?.paths) ? data.data.paths[0] : null;
  if (!path) {
    throw new Error("高德没有返回可用的骑行路径");
  }

  const distanceMeters = parseNumber(path.distance, 0);
  const durationSeconds = parseNumber(path.duration, 0);
  return {
    distanceMeters,
    durationMinutes: round1(durationSeconds > 0 ? durationSeconds / 60 : distanceMeters / 250),
    raw: path
  };
}

export async function planWalkingRoute(origin, destination) {
  const data = await requestAmap("/v3/direction/walking", {
    origin: locationString(origin),
    destination: locationString(destination)
  });
  const path = Array.isArray(data?.route?.paths) ? data.route.paths[0] : null;
  if (!path) {
    throw new Error("高德没有返回可用的步行路径");
  }

  const distanceMeters = parseNumber(path.distance, 0);
  const durationSeconds = parseNumber(path.duration, 0);
  return {
    distanceMeters,
    durationMinutes: round1(durationSeconds > 0 ? durationSeconds / 60 : distanceMeters / 75),
    raw: path
  };
}

export async function planTransitRoutes(origin, destination, city = "") {
  const data = await requestAmap("/v3/direction/transit/integrated", {
    origin: locationString(origin),
    destination: locationString(destination),
    city,
    extensions: "all",
    strategy: 0
  });
  const transits = Array.isArray(data?.route?.transits) ? data.route.transits : [];
  if (transits.length === 0) {
    throw new Error("高德没有返回可用的公交/地铁路径");
  }
  return transits;
}

export async function planTransitRoute(origin, destination, city = "") {
  const transits = await planTransitRoutes(origin, destination, city);
  return transits[0];
}
