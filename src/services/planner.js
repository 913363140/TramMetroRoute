import { buildAmapCommutePlan, getAmapPlannerStatus } from "./amapPlanner.js";
import { buildMockCommutePlan } from "./mockPlanner.js";
import { parseIntent } from "./intent.js";

const PLAN_CACHE_TTL_MS = Number(process.env.PLANNER_CACHE_TTL_MS || 5 * 60 * 1000);
const planCache = new Map();
const inFlightPlanCache = new Map();

function buildPlanCacheKey(input = {}) {
  const intent = parseIntent(input);
  return JSON.stringify({
    origin: intent.origin || "",
    destination: intent.destination || "",
    mode: intent.mode || "balanced",
    preferLongerRide: Boolean(intent.preferLongerRide)
  });
}

function readPlanCache(key) {
  const cached = planCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    planCache.delete(key);
    return null;
  }
  return JSON.parse(JSON.stringify(cached.value));
}

function writePlanCache(key, value) {
  planCache.set(key, {
    expiresAt: Date.now() + PLAN_CACHE_TTL_MS,
    value: JSON.parse(JSON.stringify(value))
  });
}

function withFallbackMetadata(result, reason) {
  return {
    ...result,
    summary: {
      ...result.summary,
      dataSource: "mock-fallback",
      dataSourceLabel: "Mock 兜底结果",
      fallbackReason: reason
    },
    plans: result.plans.map((plan) => ({
      ...plan,
      dataSource: "mock-fallback"
    }))
  };
}

export async function buildCommutePlan(input) {
  const cacheKey = buildPlanCacheKey(input);
  const cached = readPlanCache(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightPlanCache.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const plannerStatus = getAmapPlannerStatus();
    if (!plannerStatus.enabled) {
      const result = withFallbackMetadata(
        buildMockCommutePlan(input),
        "未配置 AMAP_WEB_SERVICE_KEY"
      );
      writePlanCache(cacheKey, result);
      return result;
    }

    try {
      const result = await buildAmapCommutePlan(input);
      writePlanCache(cacheKey, result);
      return result;
    } catch (error) {
      const result = withFallbackMetadata(
        buildMockCommutePlan(input),
        error?.message || "高德规划失败"
      );
      writePlanCache(cacheKey, result);
      return result;
    } finally {
      inFlightPlanCache.delete(cacheKey);
    }
  })();

  inFlightPlanCache.set(cacheKey, task);
  return task;
}

export function getPlannerStatus() {
  const plannerStatus = getAmapPlannerStatus();
  if (plannerStatus.enabled) {
    return {
      mode: "amap-real",
      enabled: true
    };
  }
  return {
    mode: "mock-fallback",
    enabled: false
  };
}
