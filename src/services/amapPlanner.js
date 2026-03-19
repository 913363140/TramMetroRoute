import { SCORING_PRESETS, SEARCH_LIMITS } from "../config.js";
import { parseIntent } from "./intent.js";
import {
  geocodeAddress,
  geocodeAddressCandidates,
  getAmapConfig,
  planBicyclingRoute,
  planTransitRoutes,
  searchNearbyPois
} from "./amapClient.js";

const WALK_METERS_PER_MINUTE = 80;
const STATION_SEARCH_RADIUS = 5000;
const ENTRANCE_SEARCH_RADIUS = 500;
const PARKING_SEARCH_RADIUS = 400;
const GATE_SEARCH_RADIUS = 450;
const COMPOSED_CACHE_TTL_MS = Number(process.env.AMAP_COMPOSED_CACHE_TTL_MS || 10 * 60 * 1000);
const geocodePairCache = new Map();
const nearbyStationCache = new Map();
const resolvedStationCache = new Map();

function round1(n) {
  return Math.round(n * 10) / 10;
}

function logPlanner(stage, detail = {}) {
  console.log(`[${new Date().toISOString()}] [planner] ${stage} ${JSON.stringify(detail)}`);
}

function readComposedCache(store, key) {
  const cached = store.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }
  return cached.value;
}

function writeComposedCache(store, key, value) {
  store.set(key, {
    expiresAt: Date.now() + COMPOSED_CACHE_TTL_MS,
    value
  });
  return value;
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function compact(value) {
  return value.filter(Boolean);
}

function normalizeStationName(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, "")
    .replace(/（.*?）/g, "")
    .replace(/\s+/g, "")
    .replace(/地铁站$/g, "")
    .trim();
}

function normalizeTransitLineKey(name) {
  return String(name || "")
    .replace(/\(.*?\)/g, "")
    .replace(/（.*?）/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeOriginName(name) {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/(小区|社区|公寓|花园|家园|苑)$/g, "")
    .trim();
}

function getStationKey(station) {
  return station.id || station.normalizedName || station.name;
}

function parsePolyline(polyline) {
  return String(polyline || "")
    .split(";")
    .map((point) => {
      const [lng, lat] = point.split(",").map((item) => Number(item));
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return null;
      }
      return [lng, lat];
    })
    .filter(Boolean);
}

function mergePolylines(polylines) {
  const merged = [];
  for (const polyline of polylines) {
    for (const point of polyline) {
      const prev = merged[merged.length - 1];
      if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) {
        merged.push(point);
      }
    }
  }
  return merged;
}

function extractPathPolyline(rawPath) {
  if (!rawPath) {
    return [];
  }

  const direct = parsePolyline(rawPath.polyline);
  if (direct.length > 0) {
    return direct;
  }

  const steps = Array.isArray(rawPath.steps) ? rawPath.steps : [];
  return mergePolylines(steps.map((step) => parsePolyline(step?.polyline)));
}

function metersToMinutes(distanceMeters, fallback = 2) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return fallback;
  }
  return round1(Math.max(1, distanceMeters / WALK_METERS_PER_MINUTE));
}

function estimateRideMinutes(distanceMeters, fallback = 6) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return fallback;
  }
  return round1(Math.max(2, distanceMeters / 250));
}

function scorePlan(plan, mode, preferLongerRide) {
  const preset = SCORING_PRESETS[mode] || SCORING_PRESETS.balanced;
  let score =
    plan.subwayMinutes * preset.subwayPenalty +
    plan.ebikeRideMinutes * preset.ridePenalty +
    plan.walkMinutes * preset.walkPenalty +
    plan.transfers * preset.transferPenalty;

  if (preferLongerRide) {
    score -= Math.min(plan.ebikeRideMinutes, 10) * 0.3;
  }

  return round1(score);
}

function summarizeTransit(transit, originStationName, destinationStationName) {
  const segments = Array.isArray(transit?.segments) ? transit.segments : [];
  const stations = [];
  const lineGuide = [];
  const mapSegments = [];

  for (const segment of segments) {
    const buslines = Array.isArray(segment?.bus?.buslines) ? segment.bus.buslines : [];
    for (const line of buslines) {
      const departure = line?.departure_stop?.name || "";
      const arrival = line?.arrival_stop?.name || "";
      const lineName = line?.name || line?.id || "地铁线路";
      const viaCount = Number(line?.via_num || 0);
      if (departure && stations[stations.length - 1] !== departure) {
        stations.push(departure);
      }
      if (arrival && stations[stations.length - 1] !== arrival) {
        stations.push(arrival);
      }
      lineGuide.push({
        lineName,
        from: departure,
        to: arrival,
        stopCount: viaCount,
        description: `${lineName}：${departure} -> ${arrival}${viaCount >= 0 ? `（约 ${viaCount + 1} 站）` : ""}`
      });
      const polyline = parsePolyline(line?.polyline);
      if (polyline.length > 1) {
        mapSegments.push({
          mode: "subway",
          label: lineName,
          points: polyline
        });
      }
    }
  }

  if (stations.length === 0) {
    stations.push(originStationName, destinationStationName);
  }

  const durationMinutes = round1(Number(transit?.duration || 0) / 60);
  const walkingDistance = Number(transit?.walking_distance || 0);
  const walkingMinutesInsideTransit = metersToMinutes(walkingDistance, 0);
  const routeStations = uniqueBy(stations, (item) => item);
  const distinctLineKeys = lineGuide.reduce((list, item) => {
    const key = normalizeTransitLineKey(item.lineName);
    if (!key || list[list.length - 1] === key) {
      return list;
    }
    list.push(key);
    return list;
  }, []);
  const inferredTransfers = Math.max(0, distinctLineKeys.length - 1);
  const apiTransfers = Number(transit?.transfers || 0);
  const firstBoardingStation =
    lineGuide[0]?.from || routeStations[0] || originStationName || "起点附近";
  const lastArrivalStation =
    lineGuide[lineGuide.length - 1]?.to ||
    routeStations[routeStations.length - 1] ||
    destinationStationName ||
    "终点附近";

  return {
    routeStations,
    durationMinutes,
    subwayMinutes: round1(Math.max(1, durationMinutes - walkingMinutesInsideTransit)),
    transfers: Math.max(apiTransfers, inferredTransfers),
    walkingMinutesInsideTransit,
    firstBoardingStation,
    lastArrivalStation,
    lineGuide,
    mapSegments
  };
}

function summarizeTransitOptionForRanking(transit) {
  const durationMinutes = round1(Number(transit?.duration || 0) / 60);
  const walkingDistance = Number(transit?.walking_distance || 0);
  const walkingMinutesInsideTransit = metersToMinutes(walkingDistance, 0);
  const segments = Array.isArray(transit?.segments) ? transit.segments : [];
  const lineKeys = [];
  let hasRail = false;

  for (const segment of segments) {
    const buslines = Array.isArray(segment?.bus?.buslines) ? segment.bus.buslines : [];
    for (const line of buslines) {
      const lineName = line?.name || line?.id || "";
      const key = normalizeTransitLineKey(lineName);
      if (key && lineKeys[lineKeys.length - 1] !== key) {
        lineKeys.push(key);
      }
      if (/(地铁|轻轨|有轨|磁悬浮|号线|机场线|亦庄线|昌平线|房山线|八通线)/.test(lineName)) {
        hasRail = true;
      }
    }
  }

  return {
    durationMinutes,
    walkingMinutesInsideTransit,
    transfers: Math.max(Number(transit?.transfers || 0), Math.max(0, lineKeys.length - 1)),
    hasRail
  };
}

function selectBestTransitOption(transits, mode) {
  const list = Array.isArray(transits) ? transits : [];
  if (list.length === 0) {
    throw new Error("高德没有返回可用的公交/地铁路径");
  }

  const ranked = list
    .map((transit) => ({
      transit,
      summary: summarizeTransitOptionForRanking(transit)
    }))
    .sort((a, b) => {
      if (a.summary.hasRail !== b.summary.hasRail) {
        return a.summary.hasRail ? -1 : 1;
      }
      if (mode === "less_transfer") {
        if (a.summary.transfers !== b.summary.transfers) {
          return a.summary.transfers - b.summary.transfers;
        }
        if (a.summary.durationMinutes !== b.summary.durationMinutes) {
          return a.summary.durationMinutes - b.summary.durationMinutes;
        }
        return a.summary.walkingMinutesInsideTransit - b.summary.walkingMinutesInsideTransit;
      }

      if (a.summary.durationMinutes !== b.summary.durationMinutes) {
        return a.summary.durationMinutes - b.summary.durationMinutes;
      }
      if (a.summary.transfers !== b.summary.transfers) {
        return a.summary.transfers - b.summary.transfers;
      }
      return a.summary.walkingMinutesInsideTransit - b.summary.walkingMinutesInsideTransit;
    });

  return ranked[0].transit;
}

function stationNameMatches(a, b) {
  return normalizeStationName(a) === normalizeStationName(b);
}

async function resolveStationByName(stationName, nearPoint, city, fallbackStations = []) {
  const normalizedTarget = normalizeStationName(stationName);
  if (!normalizedTarget) {
    return null;
  }

  const cacheKey = JSON.stringify({
    stationName: normalizedTarget,
    city: city || "",
    nearPoint: `${nearPoint?.lng || ""},${nearPoint?.lat || ""}`,
    fallbackStations: fallbackStations.map((station) => getStationKey(station)).join("|")
  });
  const cached = readComposedCache(resolvedStationCache, cacheKey);
  if (cached) {
    return cached;
  }

  const matchedFallback = fallbackStations.find((station) =>
    stationNameMatches(station.name, stationName)
  );
  if (matchedFallback) {
    return writeComposedCache(resolvedStationCache, cacheKey, matchedFallback);
  }

  try {
    const pois = await searchNearbyPois({
      location: nearPoint,
      city,
      radius: STATION_SEARCH_RADIUS,
      offset: 10,
      keywords: `${normalizedTarget}地铁站`
    });
    const matchedPoi =
      pois.find((poi) => stationNameMatches(poi.name, stationName)) ||
      pois.find((poi) => normalizeStationName(poi.name).includes(normalizedTarget)) ||
      pois[0];
    if (matchedPoi) {
      return writeComposedCache(resolvedStationCache, cacheKey, {
        ...matchedPoi,
        normalizedName: normalizeStationName(matchedPoi.name)
      });
    }
  } catch (error) {
    return writeComposedCache(resolvedStationCache, cacheKey, matchedFallback || null);
  }

  return writeComposedCache(resolvedStationCache, cacheKey, matchedFallback || null);
}

function buildFallbackEntrance(stationName, point, type = "出入口") {
  return {
    name: `${stationName}就近${type}`,
    location: point,
    address: "",
    distanceMeters: 0
  };
}

function buildTransitOnlyPlan({
  intent,
  transitSummary,
  originGeo,
  destinationGeo,
  routeCity,
  originStation,
  destinationStation,
  originGate,
  originEntrance,
  destinationEntrance,
  parking,
  ebikeLeg,
  extraWalkMinutes = 0,
  notes = []
}) {
  const ebikeRideMinutes = ebikeLeg ? ebikeLeg.durationMinutes : 0;
  const walkMinutes = round1(transitSummary.walkingMinutesInsideTransit + extraWalkMinutes);
  const totalMinutes = round1(transitSummary.durationMinutes + ebikeRideMinutes + extraWalkMinutes);
  const bikePolyline = ebikeLeg ? extractPathPolyline(ebikeLeg.raw) : [];

  return enrichPlanMetadata(
    {
      routeStations: transitSummary.routeStations,
      lineGuide: transitSummary.lineGuide,
      originStation: originStation?.name || transitSummary.firstBoardingStation,
      destinationStation: destinationStation?.name || transitSummary.lastArrivalStation,
      originGate: originGate?.name || `${intent.origin}就近出口`,
      originEntrance: originEntrance?.name || buildFallbackEntrance(transitSummary.firstBoardingStation, originGeo.location, "进站口").name,
      destinationEntrance:
        destinationEntrance?.name ||
        buildFallbackEntrance(transitSummary.lastArrivalStation, destinationGeo.location, "出站口").name,
      routeCity: routeCity || "",
      parkingZone: parking ? summarizeParking(parking, originEntrance) : "无需电瓶车停放",
      ebikeRideMinutes,
      subwayMinutes: transitSummary.subwayMinutes,
      walkMinutes,
      transfers: transitSummary.transfers,
      totalMinutes,
      mapData: buildMapData({
        originPoint: originGeo.location,
        originGate,
        parking,
        originEntrance,
        destinationEntrance,
        destinationPoint: destinationGeo.location,
        bikePolyline,
        walkPolyline: [],
        transitSegments: transitSummary.mapSegments
      })
    },
    intent,
    notes
  );
}

function isMeaningfulDetourPlan(plan, baselinePlan) {
  if (!baselinePlan) {
    return true;
  }
  if (plan.ebikeRideMinutes <= 0) {
    return true;
  }
  if (plan.transfers < baselinePlan.transfers) {
    return true;
  }
  if (plan.transfers > baselinePlan.transfers) {
    return false;
  }
  return plan.totalMinutes + 10 <= baselinePlan.totalMinutes;
}

async function findNearbyStations(point, city, limit) {
  const cacheKey = JSON.stringify({
    city: city || "",
    limit,
    point: `${point?.lng || ""},${point?.lat || ""}`
  });
  const cached = readComposedCache(nearbyStationCache, cacheKey);
  if (cached) {
    return cached.slice(0, limit);
  }

  const pois = await searchNearbyPois({
    location: point,
    city,
    radius: STATION_SEARCH_RADIUS,
    offset: 15,
    keywords: "地铁站"
  });

  const stations = uniqueBy(
    pois
      .map((poi) => ({
        ...poi,
        normalizedName: normalizeStationName(poi.name)
      }))
      .filter((poi) => poi.normalizedName),
    (poi) => poi.normalizedName
  );
  writeComposedCache(nearbyStationCache, cacheKey, stations);
  return stations.slice(0, limit);
}

function roughGeoDistance(a, b) {
  const lng = Math.abs((a.lng - b.lng) * 100000);
  const lat = Math.abs((a.lat - b.lat) * 100000);
  return lng + lat;
}

function scoreGatePoi(poi, targetPoint) {
  const name = String(poi?.name || "");
  let score = roughGeoDistance(poi.location, targetPoint);

  if (/(东门|西门|南门|北门|门|出入口|入口|出口)/.test(name)) {
    score -= 1200;
  }
  if (/(停车|停车场|车场)/.test(name)) {
    score += 2200;
  }
  if (!/(门|口|入口|出口)/.test(name)) {
    score += 600;
  }
  return score;
}

function isLikelyGatePoiName(name) {
  return /(东门|西门|南门|北门|门岗|出入口|入口|出口|大门|侧门)/.test(name);
}

function isBlockedGatePoiName(name) {
  return /(停车|停车场|车场|商店|超市|便利店|药店|饭店|餐厅|足道|医院|诊所|驿站|快递|理发|门店|涮肉|火锅|烤肉|咖啡|奶茶|酒吧|面馆|粉面|生鲜|超市发)/.test(
    name
  );
}

function isLikelyEbikeParkingPoi(poi) {
  const name = String(poi?.name || "").replace(/\s+/g, "");
  const type = String(poi?.type || "");
  const typecode = String(poi?.typecode || "");

  if (!name && !type) {
    return false;
  }

  if (/(地下停车场|停车场|公共停车场|大厦停车场|中心停车场|国际中心停车场|酒店停车场)/.test(name)) {
    return false;
  }

  if (/(1509)/.test(typecode) || /停车场/.test(type)) {
    return false;
  }

  return /(非机动车|电动车|电瓶车|自行车|共享单车)/.test(`${name} ${type}`);
}

function isLikelyStationEntrancePoi(poi, stationName) {
  const name = String(poi?.name || "").replace(/\s+/g, "");
  const normalizedStation = normalizeStationName(stationName);
  if (!name) {
    return false;
  }
  if (/(停车|停车场|车场|宾馆|酒店|大厦|商场|广场|地下停车场)/.test(name)) {
    return false;
  }
  if (!/(口|出入口|入口|出口)/.test(name)) {
    return false;
  }
  return !normalizedStation || normalizeStationName(name).includes(normalizedStation);
}

function isValidOriginGatePoi(poi, normalizedOrigin, directionalTokens) {
  const name = String(poi?.name || "").replace(/\s+/g, "");
  if (!name || isBlockedGatePoiName(name) || !isLikelyGatePoiName(name)) {
    return false;
  }

  if (normalizedOrigin && name.includes(normalizedOrigin)) {
    return true;
  }

  if (directionalTokens.some((token) => name.includes(token))) {
    return true;
  }

  return /^([东南西北]{1,2}门|出入口|入口|出口|大门|侧门)$/.test(name);
}

function inferGateTokens(anchorPoint, targetPoint) {
  const dx = targetPoint.lng - anchorPoint.lng;
  const dy = targetPoint.lat - anchorPoint.lat;
  const tokens = [];
  const horizontal = dx >= 0 ? "东" : "西";
  const vertical = dy >= 0 ? "北" : "南";
  const horizontalWeight = Math.abs(dx);
  const verticalWeight = Math.abs(dy);

  if (horizontalWeight > 0.0008 && verticalWeight > 0.0008) {
    tokens.push(`${horizontal}${vertical}门`);
  }
  if (verticalWeight >= horizontalWeight) {
    tokens.push(`${vertical}门`);
    if (horizontalWeight > 0.0006) {
      tokens.push(`${horizontal}门`);
    }
  } else {
    tokens.push(`${horizontal}门`);
    if (verticalWeight > 0.0006) {
      tokens.push(`${vertical}门`);
    }
  }
  return uniqueBy(tokens, (item) => item);
}

function buildFallbackGateName(originName, anchorPoint, targetPoint) {
  const [primary] = inferGateTokens(anchorPoint, targetPoint);
  if (primary) {
    return `${originName}${primary}方向出口`;
  }
  return `${originName}就近出入口`;
}

async function chooseEntrance(station, targetPoint, city) {
  const stationName = normalizeStationName(station.name);
  const keywordsList = [
    `${stationName}地铁站出入口`,
    `${stationName} 出入口`,
    "地铁站出入口"
  ];

  for (const keywords of keywordsList) {
    try {
      const pois = await searchNearbyPois({
        location: station.location,
        city,
        radius: ENTRANCE_SEARCH_RADIUS,
        offset: 10,
        keywords
      });
      if (pois.length > 0) {
        const filtered = pois.filter((poi) => isLikelyStationEntrancePoi(poi, station.name));
        const candidates = filtered.length > 0 ? filtered : pois;
        candidates.sort(
          (a, b) => roughGeoDistance(a.location, targetPoint) - roughGeoDistance(b.location, targetPoint)
        );
        return candidates[0];
      }
    } catch (error) {
      break;
    }
  }

  return {
    name: `${station.name}就近进出口`,
    location: station.location,
    address: station.address || "",
    distanceMeters: 0
  };
}

async function chooseOriginGate(originName, anchorPoint, targetPoint, city) {
  const normalizedOrigin = normalizeOriginName(originName);
  const directionalTokens = inferGateTokens(anchorPoint, targetPoint);
  const keywordsList = compact([
    ...directionalTokens.map((token) => (normalizedOrigin ? `${normalizedOrigin}${token}` : "")),
    normalizedOrigin ? `${normalizedOrigin}出入口` : "",
    normalizedOrigin ? `${normalizedOrigin}门` : "",
    "小区门"
  ]);

  for (const keywords of keywordsList) {
    try {
      const pois = await searchNearbyPois({
        location: anchorPoint,
        city,
        radius: GATE_SEARCH_RADIUS,
        offset: 12,
        keywords
      });
      if (pois.length > 0) {
        const gateCandidates = pois
          .filter((poi) => isValidOriginGatePoi(poi, normalizedOrigin, directionalTokens))
          .sort((a, b) => scoreGatePoi(a, targetPoint) - scoreGatePoi(b, targetPoint));
        if (gateCandidates.length > 0) {
          return gateCandidates[0];
        }
      }
    } catch (error) {
      break;
    }
  }

  return {
    name: buildFallbackGateName(originName, anchorPoint, targetPoint),
    location: anchorPoint,
    address: "",
    distanceMeters: 0
  };
}

async function chooseParking(anchorPoint, city, anchorName = "地铁站口") {
  const keywordsList = ["非机动车停车", "非机动车停放", "电动车停车", "电瓶车停放"];
  for (const keywords of keywordsList) {
    try {
      const pois = await searchNearbyPois({
        location: anchorPoint,
        city,
        radius: PARKING_SEARCH_RADIUS,
        offset: 10,
        keywords
      });
      if (pois.length > 0) {
        const candidates = pois
          .filter((poi) => isLikelyEbikeParkingPoi(poi))
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
        if (candidates.length > 0 && candidates[0].distanceMeters <= 120) {
          return candidates[0];
        }
      }
    } catch (error) {
      break;
    }
  }

  return {
    name: `${anchorName}外侧非机动车停放点`,
    location: anchorPoint,
    address: "",
    distanceMeters: 20
  };
}

function buildMapData({
  originPoint,
  originGate,
  parking,
  originEntrance,
  destinationEntrance,
  destinationPoint,
  bikePolyline,
  walkPolyline,
  transitSegments
}) {
  return {
    markers: compact([
      {
        key: "origin",
        name: "起点",
        detail: "通勤出发点",
        position: [originPoint.lng, originPoint.lat],
        tone: "origin"
      },
      originGate
        ? {
            key: "originGate",
            name: "推荐小区出口",
            detail: originGate.name,
            position: [originGate.location.lng, originGate.location.lat],
            tone: "gate"
          }
        : null,
      parking
        ? {
            key: "parking",
            name: "电瓶车停放点",
            detail: parking.name,
            position: [parking.location.lng, parking.location.lat],
            tone: "parking"
          }
        : null,
      originEntrance
        ? {
            key: "originEntrance",
            name: "最佳进站口",
            detail: originEntrance.name,
            position: [originEntrance.location.lng, originEntrance.location.lat],
            tone: "entrance"
          }
        : null,
      destinationEntrance
        ? {
            key: "destinationEntrance",
            name: "目标出站口",
            detail: destinationEntrance.name,
            position: [destinationEntrance.location.lng, destinationEntrance.location.lat],
            tone: "exit"
          }
        : null,
      {
        key: "destination",
        name: "终点",
        detail: "通勤目的地",
        position: [destinationPoint.lng, destinationPoint.lat],
        tone: "destination"
      }
    ]),
    segments: compact([
      bikePolyline.length > 1
        ? {
            mode: "bike",
            label: "电瓶车骑行",
            points: bikePolyline
          }
        : null,
      ...transitSegments,
      walkPolyline.length > 1
        ? {
            mode: "walk",
            label: "出站步行",
            points: walkPolyline
          }
        : null
    ])
  };
}

function summarizeParking(parking, entrance) {
  if (!parking) {
    return entrance ? `${entrance.name}外侧非机动车停放点` : "站口附近非机动车停放点";
  }
  return parking.name;
}

function enrichPlanMetadata(plan, input, notes = []) {
  return {
    ...plan,
    mode: input.mode,
    origin: input.origin,
    destination: input.destination,
    notes,
    dataSource: "amap"
  };
}

function getGeoCityHint(geo) {
  return geo?.city || geo?.citycode || "";
}

function scoreGeoPair(originGeo, destinationGeo, originIndex, destinationIndex) {
  let score = 0;

  if (originGeo.citycode && destinationGeo.citycode && originGeo.citycode === destinationGeo.citycode) {
    score += 100;
  } else if (originGeo.city && destinationGeo.city && originGeo.city === destinationGeo.city) {
    score += 80;
  } else if (
    originGeo.province &&
    destinationGeo.province &&
    originGeo.province === destinationGeo.province
  ) {
    score += 20;
  }

  score -= originIndex * 2;
  score -= destinationIndex * 2;
  return score;
}

async function resolveConsistentGeocodePair(origin, destination) {
  const cacheKey = JSON.stringify({ origin, destination });
  const cached = readComposedCache(geocodePairCache, cacheKey);
  if (cached) {
    return cached;
  }

  const originCandidates = await geocodeAddressCandidates(origin);
  if (originCandidates.length === 0) {
    throw new Error(`无法从高德解析地址：${origin}`);
  }

  const originPool = [...originCandidates];
  const seenOriginKeys = new Set(
    originPool.map((item) => `${item.formattedAddress}:${item.location.lng}:${item.location.lat}`)
  );
  const destinationCandidates = [];
  const seenDestinationKeys = new Set();
  const cityHints = uniqueBy(
    compact(originPool.map((item) => getGeoCityHint(item))),
    (item) => item
  );

  const pushDestinationCandidates = async (cityHint = "") => {
    try {
      const list = await geocodeAddressCandidates(destination, cityHint);
      for (const item of list) {
        const key = `${item.formattedAddress}:${item.location.lng}:${item.location.lat}`;
        if (!seenDestinationKeys.has(key)) {
          seenDestinationKeys.add(key);
          destinationCandidates.push(item);
        }
      }
    } catch (error) {
      return;
    }
  };

  for (const cityHint of cityHints.slice(0, 5)) {
    await pushDestinationCandidates(cityHint);
  }
  await pushDestinationCandidates("");

  if (destinationCandidates.length === 0) {
    const fallbackOrigin = await geocodeAddress(origin);
    const fallbackDestination = await geocodeAddress(destination);
    return writeComposedCache(geocodePairCache, cacheKey, {
      originGeo: fallbackOrigin,
      destinationGeo: fallbackDestination
    });
  }

  const hasSameCityPair = originPool.some((originGeo) =>
    destinationCandidates.some(
      (destinationGeo) =>
        (originGeo.citycode && originGeo.citycode === destinationGeo.citycode) ||
        (originGeo.city && originGeo.city === destinationGeo.city)
    )
  );

  if (!hasSameCityPair) {
    const destinationCityHints = uniqueBy(
      compact(destinationCandidates.map((item) => getGeoCityHint(item))),
      (item) => item
    );
    for (const cityHint of destinationCityHints.slice(0, 3)) {
      try {
        const extraOrigins = await geocodeAddressCandidates(origin, cityHint);
        for (const item of extraOrigins) {
          const key = `${item.formattedAddress}:${item.location.lng}:${item.location.lat}`;
          if (!seenOriginKeys.has(key)) {
            seenOriginKeys.add(key);
            originPool.push(item);
          }
        }
      } catch (error) {
        continue;
      }
    }
  }

  let bestPair = {
    originGeo: originPool[0],
    destinationGeo: destinationCandidates[0],
    score: Number.NEGATIVE_INFINITY
  };

  originPool.forEach((originGeo, originIndex) => {
    destinationCandidates.forEach((destinationGeo, destinationIndex) => {
      const score = scoreGeoPair(originGeo, destinationGeo, originIndex, destinationIndex);
      if (score > bestPair.score) {
        bestPair = {
          originGeo,
          destinationGeo,
          score
        };
      }
    });
  });

  return writeComposedCache(geocodePairCache, cacheKey, {
    originGeo: bestPair.originGeo,
    destinationGeo: bestPair.destinationGeo
  });
}

export function getAmapPlannerStatus() {
  const config = getAmapConfig();
  return {
    mode: config.enabled ? "amap-real" : "mock-fallback",
    enabled: config.enabled
  };
}

export async function buildAmapCommutePlan(input) {
  const startedAt = Date.now();
  const intent = parseIntent(input);
  const amapConfig = getAmapConfig();
  if (!amapConfig.enabled) {
    throw new Error("AMAP_WEB_SERVICE_KEY is not configured");
  }

  const geocodeStartedAt = Date.now();
  const { originGeo, destinationGeo } = await resolveConsistentGeocodePair(
    intent.origin,
    intent.destination
  );
  const geocodeDurationMs = Date.now() - geocodeStartedAt;
  const cityHint =
    destinationGeo.city ||
    originGeo.city ||
    destinationGeo.citycode ||
    originGeo.citycode ||
    destinationGeo.adcode ||
    originGeo.adcode;

  const stationStartedAt = Date.now();
  const originCandidates = await findNearbyStations(
    originGeo.location,
    cityHint,
    SEARCH_LIMITS.maxOriginStations
  );
  const destinationCandidates = await findNearbyStations(
    destinationGeo.location,
    cityHint,
    SEARCH_LIMITS.maxDestinationStations
  );
  const stationDurationMs = Date.now() - stationStartedAt;

  if (originCandidates.length === 0 || destinationCandidates.length === 0) {
    throw new Error("高德未找到足够的地铁站候选点");
  }

  const gateCache = new Map();
  const bikeCache = new Map();
  const entranceCache = new Map();
  const parkingCache = new Map();
  const plans = [];

  const baselineStartedAt = Date.now();
  const baselineTransit = selectBestTransitOption(
    await planTransitRoutes(originGeo.location, destinationGeo.location, cityHint),
    intent.mode
  );
  const baselineSummary = summarizeTransit(baselineTransit, intent.origin, intent.destination);
  const baselineOriginStation = await resolveStationByName(
    baselineSummary.firstBoardingStation,
    originGeo.location,
    cityHint,
    originCandidates
  );
  const baselineDestinationStation = await resolveStationByName(
    baselineSummary.lastArrivalStation,
    destinationGeo.location,
    cityHint,
    destinationCandidates
  );
  const baselineOriginGate = baselineOriginStation
    ? await chooseOriginGate(intent.origin, originGeo.location, baselineOriginStation.location, cityHint)
    : {
        name: `${intent.origin}就近出口`,
        location: originGeo.location,
        address: "",
        distanceMeters: 0
      };
  const baselineOriginEntrance = baselineOriginStation
    ? await chooseEntrance(baselineOriginStation, destinationGeo.location, cityHint)
    : buildFallbackEntrance(baselineSummary.firstBoardingStation, originGeo.location, "进站口");
  const baselineDestinationEntrance = baselineDestinationStation
    ? await chooseEntrance(baselineDestinationStation, destinationGeo.location, cityHint)
    : buildFallbackEntrance(baselineSummary.lastArrivalStation, destinationGeo.location, "出站口");
  const baselinePlan = buildTransitOnlyPlan({
    intent,
    transitSummary: baselineSummary,
    originGeo,
    destinationGeo,
    routeCity: cityHint,
    originStation: baselineOriginStation,
    destinationStation: baselineDestinationStation,
    originGate: baselineOriginGate,
    originEntrance: baselineOriginEntrance,
    destinationEntrance: baselineDestinationEntrance,
    parking: null,
    ebikeLeg: null,
    extraWalkMinutes: 0,
    notes: [
      "先基于高德真实公共交通方案生成直达终点的基线路线。",
      "再评估是否值得通过多骑几分钟电瓶车来减少换乘或缩短总耗时。",
      "进站口、停车点和小区出口基于真实 POI 搜索做近似匹配。"
    ]
  });
  baselinePlan.score = scorePlan(baselinePlan, intent.mode, false);
  plans.push(baselinePlan);
  const baselineDurationMs = Date.now() - baselineStartedAt;

  const getOriginGate = async (station) => {
    const key = getStationKey(station);
    if (!gateCache.has(key)) {
      gateCache.set(key, chooseOriginGate(intent.origin, originGeo.location, station.location, cityHint));
    }
    return gateCache.get(key);
  };

  const getOriginBike = async (station, startPoint) => {
    const key = `${getStationKey(station)}:${startPoint.lng}:${startPoint.lat}`;
    if (!bikeCache.has(key)) {
      bikeCache.set(
        key,
        planBicyclingRoute(startPoint, station.location).catch(() => ({
          distanceMeters: station.distanceMeters,
          durationMinutes: estimateRideMinutes(station.distanceMeters, 6),
          raw: null
        }))
      );
    }
    return bikeCache.get(key);
  };

  const getEntrance = async (station, targetPoint) => {
    const key = `${getStationKey(station)}:${targetPoint.lng}:${targetPoint.lat}`;
    if (!entranceCache.has(key)) {
      entranceCache.set(key, chooseEntrance(station, targetPoint, cityHint));
    }
    return entranceCache.get(key);
  };

  const getParking = async (station, anchor, entranceName) => {
    const key = `${getStationKey(station)}:${anchor.lng}:${anchor.lat}:${entranceName}`;
    if (!parkingCache.has(key)) {
      parkingCache.set(key, chooseParking(anchor, cityHint, entranceName));
    }
    return parkingCache.get(key);
  };

  const candidateStartedAt = Date.now();
  for (const originStation of originCandidates) {
    try {
      const candidateOriginGate = await getOriginGate(originStation);
      const candidateBikeLeg = await getOriginBike(
        originStation,
        candidateOriginGate.location || originGeo.location
      );
      const candidateOriginEntrance = await getEntrance(originStation, destinationGeo.location);

      const transit = selectBestTransitOption(
        await planTransitRoutes(candidateOriginEntrance.location, destinationGeo.location, cityHint),
        intent.mode
      );
      const transitSummary = summarizeTransit(
        transit,
        originStation.name,
        intent.destination
      );
      const actualOriginStation =
        (await resolveStationByName(
          transitSummary.firstBoardingStation,
          candidateOriginEntrance.location,
          cityHint,
          originCandidates
        )) || originStation;
      const destinationStation = await resolveStationByName(
        transitSummary.lastArrivalStation,
        destinationGeo.location,
        cityHint,
        destinationCandidates
      );
      const originGate = await getOriginGate(actualOriginStation);
      const ebikeLeg = await getOriginBike(
        actualOriginStation,
        originGate.location || originGeo.location
      );
      const originEntrance = await getEntrance(actualOriginStation, destinationGeo.location);

      const provisionalPlan = {
        ebikeRideMinutes: ebikeLeg.durationMinutes,
        transfers: transitSummary.transfers,
        totalMinutes: round1(transitSummary.durationMinutes + ebikeLeg.durationMinutes + 1)
      };

      if (!isMeaningfulDetourPlan(provisionalPlan, baselinePlan)) {
        continue;
      }

      const parking = await getParking(
        actualOriginStation,
        originEntrance.location,
        originEntrance.name
      );
      const parkingWalkMinutes = metersToMinutes(parking.distanceMeters, 1);
      const destinationEntrance = destinationStation
        ? await getEntrance(destinationStation, destinationGeo.location)
        : buildFallbackEntrance(transitSummary.lastArrivalStation, destinationGeo.location, "出站口");

      const plan = buildTransitOnlyPlan({
        intent,
        transitSummary,
        originGeo,
        destinationGeo,
        routeCity: cityHint,
        originStation: actualOriginStation,
        destinationStation,
        originGate,
        originEntrance,
        destinationEntrance,
        parking,
        ebikeLeg,
        extraWalkMinutes: parkingWalkMinutes,
        notes: [
          "先保留高德真实公共交通路线，再评估是否值得先骑电瓶车到更合适的起始站。",
          "骑行后可直接停在地铁站口外侧的非机动车停放点，再步行进站。",
          "如果多骑几分钟能减少换乘或总耗时，这类方案会被优先抬高。"
        ]
      });

      plan.score = scorePlan(plan, intent.mode, intent.preferLongerRide);
      plans.push(plan);
    } catch (error) {
      continue;
    }
  }
  const candidateDurationMs = Date.now() - candidateStartedAt;

  if (plans.length === 0) {
    throw new Error("高德未返回可组合的电瓶车+地铁方案");
  }

  plans.sort((a, b) => a.score - b.score);
  const topPlans = plans.slice(0, SEARCH_LIMITS.topPlans);

  logPlanner("build.finish", {
    origin: intent.origin,
    destination: intent.destination,
    cityHint,
    geocodeDurationMs,
    stationDurationMs,
    baselineDurationMs,
    candidateDurationMs,
    totalDurationMs: Date.now() - startedAt,
    originCandidates: originCandidates.length,
    destinationCandidates: destinationCandidates.length,
    candidatePlans: plans.length
  });

  return {
    summary: {
      mode: intent.mode,
      candidatePlans: plans.length,
      recommended: topPlans[0] || null,
      dataSource: "amap",
      dataSourceLabel: "高德真实路线 + 周边 POI",
      approximation:
        "进站口、停车点和小区出口基于真实 POI 搜索做近似匹配，非地铁官方闸机级精确数据。"
    },
    plans: topPlans
  };
}
